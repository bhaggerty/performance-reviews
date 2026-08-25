import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, queryAll, TABLE_NAME, isConditionalCheckFailed } from './client';
import {
  deleteEmailIdentityItem,
  deleteSlackIdentityItem,
  getEmployeeIdByEmail,
  getEmployeeIdBySlackId,
  putEmailIdentityItem,
  putSlackIdentityItem,
  type TransactWriteItem,
} from './identities';
import type { Employee } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'EMP#';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toItem(emp: Employee) {
  return {
    PK: `${PREFIX}${emp.id}`,
    SK: 'METADATA',
    GSI1PK: 'EMPLOYEE_DIRECTORY',
    GSI1SK: `${emp.name}#${emp.id}`,
    GSI2PK: `MANAGER_REPORTS#${emp.manager_id ?? 'none'}`,
    GSI2SK: `${PREFIX}${emp.id}`,
    type: 'EMPLOYEE',
    ...emp,
  };
}

function fromItem(item: Record<string, unknown>): Employee {
  return {
    id: item.id as string,
    slack_id: (item.slack_id as string) || null,
    name: item.name as string,
    email: item.email as string,
    manager_id: (item.manager_id as string) || null,
    department: (item.department as string) ?? '',
    status: (item.status as Employee['status']) ?? 'active',
    is_people_admin: Boolean(item.is_people_admin),
    schema_version: (item.schema_version as number) ?? 1,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function getEmployeeById(id: string): Promise<Employee | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `${PREFIX}${id}`, SK: 'METADATA' } })
  );
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

export async function getEmployeeBySlackId(slackId: string): Promise<Employee | null> {
  const id = await getEmployeeIdBySlackId(slackId);
  return id ? getEmployeeById(id) : null;
}

export async function getEmployeeByEmail(email: string): Promise<Employee | null> {
  const id = await getEmployeeIdByEmail(normalizeEmail(email));
  return id ? getEmployeeById(id) : null;
}

export async function getDirectReports(managerId: string): Promise<Employee[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `MANAGER_REPORTS#${managerId}` },
  });
  return items.map((i) => fromItem(i));
}

/** Full directory listing via a sparse GSI partition — no table Scan. */
export async function listEmployees(): Promise<Employee[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'EMPLOYEE_DIRECTORY' },
  });
  return items.map((i) => fromItem(i));
}

export interface CreateEmployeeInput {
  slack_id?: string | null;
  name: string;
  email: string;
  manager_id?: string | null;
  department?: string;
  status?: Employee['status'];
  is_people_admin?: boolean;
}

/**
 * Create a brand-new employee with a fresh ID. Uniqueness on normalized email (and Slack ID,
 * when present) is enforced atomically via a transaction against the identity records — a
 * duplicate email or Slack ID throws rather than silently creating a second employee.
 */
export async function createEmployee(input: CreateEmployeeInput, clock: Clock = systemClock): Promise<Employee> {
  const email = normalizeEmail(input.email);
  const id = randomUUID();
  const now = isoNow(clock);
  const employee: Employee = {
    id,
    slack_id: input.slack_id || null,
    name: input.name,
    email,
    manager_id: input.manager_id ?? null,
    department: input.department ?? '',
    status: input.status ?? 'active',
    is_people_admin: input.is_people_admin ?? false,
    schema_version: 1,
    created_at: now,
    updated_at: now,
  };

  const transactItems: TransactWriteItem[] = [
    { Put: { TableName: TABLE_NAME, Item: toItem(employee), ConditionExpression: 'attribute_not_exists(PK)' } },
    putEmailIdentityItem(email, id),
    ...(employee.slack_id ? [putSlackIdentityItem(employee.slack_id, id)] : []),
  ];

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new Error(`Employee with email "${email}" or Slack ID "${employee.slack_id}" already exists.`);
    }
    throw error;
  }
  return employee;
}

export interface UpdateEmployeeInput {
  name?: string;
  email?: string;
  manager_id?: string | null;
  department?: string;
  status?: Employee['status'];
  slack_id?: string | null;
  is_people_admin?: boolean;
}

/**
 * Update an existing employee in place (preserving its ID). If the email or Slack ID is
 * changing, the old identity pointer is deleted and the new one created atomically so
 * uniqueness holds across the rename.
 */
export async function updateEmployee(
  id: string,
  updates: UpdateEmployeeInput,
  clock: Clock = systemClock
): Promise<Employee | null> {
  const existing = await getEmployeeById(id);
  if (!existing) return null;

  const now = isoNow(clock);
  const nextEmail = updates.email ? normalizeEmail(updates.email) : existing.email;
  const nextSlackId = updates.slack_id !== undefined ? updates.slack_id : existing.slack_id;
  const updated: Employee = {
    ...existing,
    ...updates,
    email: nextEmail,
    slack_id: nextSlackId,
    manager_id: updates.manager_id !== undefined ? updates.manager_id : existing.manager_id,
    updated_at: now,
  };

  const transactItems: TransactWriteItem[] = [
    { Put: { TableName: TABLE_NAME, Item: toItem(updated), ConditionExpression: 'attribute_exists(PK)' } },
  ];

  if (nextEmail !== existing.email) {
    transactItems.push(deleteEmailIdentityItem(existing.email));
    transactItems.push(putEmailIdentityItem(nextEmail, id));
  }
  if (nextSlackId !== existing.slack_id) {
    if (existing.slack_id) transactItems.push(deleteSlackIdentityItem(existing.slack_id));
    if (nextSlackId) transactItems.push(putSlackIdentityItem(nextSlackId, id));
  }

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new Error(`Email "${nextEmail}" or Slack ID "${nextSlackId}" is already used by another employee.`);
    }
    throw error;
  }
  return updated;
}

/**
 * Stable upsert keyed by normalized email: updates the existing employee in place when the
 * email is already known, otherwise creates a new one. This is the primitive the CSV importer
 * uses so re-importing the same person never mints a second employee ID.
 */
export async function upsertEmployeeByEmail(
  input: CreateEmployeeInput,
  clock: Clock = systemClock
): Promise<{ employee: Employee; created: boolean }> {
  const email = normalizeEmail(input.email);
  const existing = await getEmployeeByEmail(email);
  if (existing) {
    const updated = await updateEmployee(existing.id, { ...input, email }, clock);
    return { employee: updated!, created: false };
  }
  const created = await createEmployee({ ...input, email }, clock);
  return { employee: created, created: true };
}

export async function setManager(
  employeeId: string,
  managerId: string | null,
  clock: Clock = systemClock
): Promise<Employee | null> {
  return updateEmployee(employeeId, { manager_id: managerId }, clock);
}

/** Used only by App Home for a Slack user with no directory match — read-only, no auto-create. */
export async function findEmployeeBySlack(slackId: string): Promise<Employee | null> {
  return getEmployeeBySlackId(slackId);
}
