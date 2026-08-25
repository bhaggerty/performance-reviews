import type { Employee } from '../../types';
import {
  getEmployeeByEmail,
  listEmployees,
  normalizeEmail,
  upsertEmployeeByEmail,
  updateEmployee,
} from '../../db/employees';
import { recordDirectoryImport } from '../../db/directoryImports';
import type { DirectoryImportSummary } from '../../types';
import type { DirectoryRow, ImportIssue, ImportPlan, ImportPlanRow } from './types';
import { isoNow, systemClock, type Clock } from '../../domain/clock';

export interface ResolvedRow extends DirectoryRow {
  rowNumber: number;
}

function validateStructure(rows: DirectoryRow[]): {
  resolved: ResolvedRow[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
} {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const seenEmails = new Map<string, number>();
  const seenSlackIds = new Map<string, number>();
  const resolved: ResolvedRow[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // header is row 1
    const email = normalizeEmail(row.email);
    if (!row.name || !email) {
      errors.push({ row: rowNumber, message: 'name and email are required.' });
      return;
    }
    if (row.email !== email) row = { ...row, email };
    if (row.manager_email && normalizeEmail(row.manager_email) === email) {
      errors.push({ row: rowNumber, email, message: 'An employee cannot be their own manager.' });
      return;
    }
    if (seenEmails.has(email)) {
      errors.push({ row: rowNumber, email, message: `Duplicate email in file (also row ${seenEmails.get(email)}).` });
      return;
    }
    seenEmails.set(email, rowNumber);

    if (row.slack_id) {
      if (seenSlackIds.has(row.slack_id)) {
        errors.push({
          row: rowNumber,
          email,
          message: `Duplicate Slack ID in file (also row ${seenSlackIds.get(row.slack_id)}).`,
        });
        return;
      }
      seenSlackIds.set(row.slack_id, rowNumber);
    }

    resolved.push({ ...row, manager_email: row.manager_email ? normalizeEmail(row.manager_email) : '', rowNumber });
  });

  return { resolved, errors, warnings };
}

/** Detects unknown managers and management cycles (including transitive ones) across the file + existing directory. */
function validateManagementGraph(
  resolved: ResolvedRow[],
  existingByEmail: Map<string, Employee>
): { errors: ImportIssue[]; unknownManagerEmails: Set<string> } {
  const errors: ImportIssue[] = [];
  const unknownManagerEmails = new Set<string>();
  const inFile = new Set(resolved.map((r) => r.email));

  const managerOf = new Map<string, string | undefined>();
  for (const row of resolved) {
    if (!row.manager_email) {
      managerOf.set(row.email, undefined);
      continue;
    }
    const managerKnown = inFile.has(row.manager_email) || existingByEmail.has(row.manager_email);
    if (!managerKnown) {
      unknownManagerEmails.add(row.manager_email);
      errors.push({ row: row.rowNumber, email: row.email, message: `Unknown manager email: ${row.manager_email}` });
      managerOf.set(row.email, undefined);
      continue;
    }
    managerOf.set(row.email, row.manager_email);
  }
  // Existing employees not in this file still contribute their manager edges for cycle detection.
  for (const emp of existingByEmail.values()) {
    if (!managerOf.has(emp.email)) {
      const mgr = emp.manager_id ? [...existingByEmail.values()].find((e) => e.id === emp.manager_id) : undefined;
      managerOf.set(emp.email, mgr?.email);
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cyclicEmails = new Set<string>();

  function visit(email: string, stack: string[]): void {
    color.set(email, GRAY);
    stack.push(email);
    const manager = managerOf.get(email);
    if (manager) {
      const managerColor = color.get(manager) ?? WHITE;
      if (managerColor === GRAY) {
        const cycleStart = stack.indexOf(manager);
        for (const e of stack.slice(cycleStart)) cyclicEmails.add(e);
      } else if (managerColor === WHITE) {
        visit(manager, stack);
      }
    }
    stack.pop();
    color.set(email, BLACK);
  }

  for (const email of managerOf.keys()) {
    if ((color.get(email) ?? WHITE) === WHITE) visit(email, []);
  }

  for (const row of resolved) {
    if (cyclicEmails.has(row.email)) {
      errors.push({
        row: row.rowNumber,
        email: row.email,
        message: 'Management cycle detected involving this employee.',
      });
    }
  }

  return { errors, unknownManagerEmails };
}

/** Topological order (managers before reports) so commit can resolve manager IDs in one pass. */
function topologicalOrder(resolved: ResolvedRow[]): ResolvedRow[] {
  const byEmail = new Map(resolved.map((r) => [r.email, r]));
  const visited = new Set<string>();
  const ordered: ResolvedRow[] = [];

  function visit(row: ResolvedRow): void {
    if (visited.has(row.email)) return;
    visited.add(row.email);
    const manager = row.manager_email ? byEmail.get(row.manager_email) : undefined;
    if (manager) visit(manager);
    ordered.push(row);
  }

  for (const row of resolved) visit(row);
  return ordered;
}

function diffEmployee(existing: Employee | undefined, row: ResolvedRow, resolvedManagerId: string | null | undefined) {
  if (!existing) return undefined;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (existing.name !== row.name) changes.name = { from: existing.name, to: row.name };
  if (existing.department !== row.department) changes.department = { from: existing.department, to: row.department };
  if (existing.status !== row.status) changes.status = { from: existing.status, to: row.status };
  if (row.slack_id && existing.slack_id !== row.slack_id)
    changes.slack_id = { from: existing.slack_id, to: row.slack_id };
  if (resolvedManagerId !== undefined && existing.manager_id !== resolvedManagerId) {
    changes.manager_id = { from: existing.manager_id, to: resolvedManagerId };
  }
  return Object.keys(changes).length ? changes : undefined;
}

export interface PlanOptions {
  authoritativeSnapshot: boolean;
  resolveSlackIdByEmail?: (email: string) => Promise<string | undefined>;
}

export async function planImport(
  rows: DirectoryRow[],
  options: PlanOptions
): Promise<{ plan: ImportPlan; resolved: ResolvedRow[] }> {
  const { resolved, errors: structuralErrors, warnings } = validateStructure(rows);
  const existing = await listEmployees();
  const existingByEmail = new Map(existing.map((e) => [e.email, e]));
  const { errors: graphErrors } = validateManagementGraph(resolved, existingByEmail);
  const errors = [...structuralErrors, ...graphErrors];
  const errorEmails = new Set(errors.filter((e) => e.email).map((e) => e.email!));

  const planRows: ImportPlanRow[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let unresolved = 0;

  const fileEmails = new Set(resolved.map((r) => r.email));
  const ordered = topologicalOrder(resolved.filter((r) => !errorEmails.has(r.email)));
  const assignedIds = new Map<string, string>();

  for (const row of ordered) {
    let slackResolved: boolean | undefined;
    if (!row.slack_id && options.resolveSlackIdByEmail) {
      const found = await options.resolveSlackIdByEmail(row.email);
      slackResolved = Boolean(found);
      if (!found)
        warnings.push({
          row: row.rowNumber,
          email: row.email,
          message: 'Could not resolve a Slack user for this email.',
        });
    }
    const existingEmp = existingByEmail.get(row.email);
    const managerId = row.manager_email
      ? (existingByEmail.get(row.manager_email)?.id ?? assignedIds.get(row.manager_email))
      : null;
    if (existingEmp) assignedIds.set(row.email, existingEmp.id);

    const changes = diffEmployee(existingEmp, row, managerId);
    if (!existingEmp) {
      created += 1;
      planRows.push({ row: row.rowNumber, email: row.email, action: 'create', slack_resolved: slackResolved });
    } else if (changes) {
      updated += 1;
      planRows.push({ row: row.rowNumber, email: row.email, action: 'update', changes, slack_resolved: slackResolved });
    } else {
      unchanged += 1;
      planRows.push({ row: row.rowNumber, email: row.email, action: 'unchanged', slack_resolved: slackResolved });
    }
  }

  for (const row of resolved) {
    if (errorEmails.has(row.email)) {
      unresolved += 1;
      planRows.push({ row: row.rowNumber, email: row.email, action: 'unresolved' });
    }
  }

  let deactivated = 0;
  if (options.authoritativeSnapshot) {
    for (const emp of existing) {
      if (!fileEmails.has(emp.email) && emp.status === 'active') deactivated += 1;
    }
  }

  return {
    resolved: ordered,
    plan: {
      rows: planRows,
      warnings,
      errors,
      createdCount: created,
      updatedCount: updated,
      unchangedCount: unchanged,
      deactivatedCount: deactivated,
      unresolvedCount: unresolved,
    },
  };
}

export interface CommitOptions extends PlanOptions {
  actorId: string;
  sourceName: string;
}

export async function commitImport(
  rows: DirectoryRow[],
  options: CommitOptions,
  clock: Clock = systemClock
): Promise<DirectoryImportSummary> {
  const { plan, resolved } = await planImport(rows, options);
  if (plan.errors.length > 0) {
    throw new Error(`Refusing to commit: ${plan.errors.length} validation error(s). Run a dry run first.`);
  }

  const assignedIds = new Map<string, string>();
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const row of resolved) {
    const managerId = row.manager_email
      ? (assignedIds.get(row.manager_email) ?? (await getEmployeeByEmail(row.manager_email))?.id ?? null)
      : null;
    let slackId = row.slack_id;
    if (!slackId && options.resolveSlackIdByEmail) slackId = await options.resolveSlackIdByEmail(row.email);

    const before = await getEmployeeByEmail(row.email);
    const { employee, created } = await upsertEmployeeByEmail(
      {
        name: row.name,
        email: row.email,
        manager_id: managerId,
        department: row.department,
        status: row.status,
        slack_id: slackId ?? null,
      },
      clock
    );
    assignedIds.set(row.email, employee.id);
    if (created) createdCount += 1;
    else if (
      before &&
      (before.name !== employee.name ||
        before.department !== employee.department ||
        before.status !== employee.status ||
        before.manager_id !== employee.manager_id ||
        before.slack_id !== employee.slack_id)
    ) {
      updatedCount += 1;
    } else {
      unchangedCount += 1;
    }
  }

  let deactivatedCount = 0;
  if (options.authoritativeSnapshot) {
    const fileEmails = new Set(resolved.map((r) => r.email));
    const existing = await listEmployees();
    for (const emp of existing) {
      if (!fileEmails.has(emp.email) && emp.status === 'active') {
        await updateEmployee(emp.id, { status: 'inactive' }, clock);
        deactivatedCount += 1;
      }
    }
  }

  return recordDirectoryImport(
    {
      status: 'committed',
      source: options.sourceName,
      authoritative_snapshot: options.authoritativeSnapshot,
      created_count: createdCount,
      updated_count: updatedCount,
      unchanged_count: unchangedCount,
      deactivated_count: deactivatedCount,
      unresolved_count: plan.unresolvedCount,
      warning_count: plan.warnings.length,
      error_count: plan.errors.length,
      actor_id: options.actorId,
    },
    clock
  );
}

export function isoTimestamp(clock: Clock = systemClock): string {
  return isoNow(clock);
}
