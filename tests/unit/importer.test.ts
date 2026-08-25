import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEmployee } from '../fixtures/builders';
import type { DirectoryRow } from '../../src/services/directoryImport/types';

const mockEmployees = {
  getEmployeeByEmail: vi.fn(),
  listEmployees: vi.fn(),
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
  upsertEmployeeByEmail: vi.fn(),
  updateEmployee: vi.fn(),
};
vi.mock('../../src/db/employees', () => mockEmployees);

const mockImports = { recordDirectoryImport: vi.fn() };
vi.mock('../../src/db/directoryImports', () => mockImports);

const { planImport, commitImport } = await import('../../src/services/directoryImport/importer');

function row(overrides: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    name: 'Someone',
    email: 'someone@example.com',
    manager_email: '',
    department: 'Eng',
    status: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmployees.listEmployees.mockResolvedValue([]);
  mockImports.recordDirectoryImport.mockImplementation((input: Record<string, unknown>) => ({
    id: 'import-1',
    created_at: '2026-01-01T00:00:00.000Z',
    ...input,
  }));
});

describe('planImport — structural validation', () => {
  it('flags a row missing name or email', async () => {
    const { plan } = await planImport([row({ name: '', email: '' })], { authoritativeSnapshot: false });
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].message).toMatch(/required/);
  });

  it('rejects self-management', async () => {
    const rows = [row({ email: 'a@example.com', manager_email: 'A@Example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.errors[0].message).toMatch(/own manager/);
  });

  it('flags duplicate emails within the file', async () => {
    const rows = [row({ email: 'dup@example.com' }), row({ email: 'DUP@example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.errors.some((e) => /Duplicate email/.test(e.message))).toBe(true);
  });

  it('flags duplicate slack_ids within the file', async () => {
    const rows = [row({ email: 'a@example.com', slack_id: 'U1' }), row({ email: 'b@example.com', slack_id: 'U1' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.errors.some((e) => /Duplicate Slack ID/.test(e.message))).toBe(true);
  });

  it('normalizes email to lowercase in the plan', async () => {
    const rows = [row({ email: 'MixedCase@Example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.rows[0].email).toBe('mixedcase@example.com');
  });
});

describe('planImport — management graph', () => {
  it('flags an unknown manager email', async () => {
    const rows = [row({ email: 'a@example.com', manager_email: 'ghost@example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.errors.some((e) => /Unknown manager/.test(e.message))).toBe(true);
  });

  it('accepts a valid multi-level hierarchy with no errors', async () => {
    const rows = [
      row({ email: 'ceo@example.com', manager_email: '' }),
      row({ email: 'vp@example.com', manager_email: 'ceo@example.com' }),
      row({ email: 'ic@example.com', manager_email: 'vp@example.com' }),
    ];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.errors).toHaveLength(0);
    expect(plan.createdCount).toBe(3);
  });

  it('detects a genuine 3-node management cycle (A -> B -> C -> A)', async () => {
    const rows = [
      row({ email: 'a@example.com', manager_email: 'c@example.com' }),
      row({ email: 'b@example.com', manager_email: 'a@example.com' }),
      row({ email: 'c@example.com', manager_email: 'b@example.com' }),
    ];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    const cycleErrors = plan.errors.filter((e) => /cycle/i.test(e.message));
    expect(cycleErrors).toHaveLength(3);
  });

  it('allows a manager who already exists in the directory but is absent from this file', async () => {
    mockEmployees.listEmployees.mockResolvedValue([buildEmployee({ id: 'mgr-1', email: 'boss@example.com' })]);
    const rows = [row({ email: 'a@example.com', manager_email: 'boss@example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.errors).toHaveLength(0);
  });
});

describe('planImport — dry run counts and authoritative snapshot', () => {
  it('counts create/update/unchanged correctly against existing employees', async () => {
    const existing = buildEmployee({
      email: 'same@example.com',
      name: 'Same Name',
      department: 'Eng',
      status: 'active',
    });
    const changed = buildEmployee({
      email: 'changed@example.com',
      name: 'Old Name',
      department: 'Eng',
      status: 'active',
    });
    mockEmployees.listEmployees.mockResolvedValue([existing, changed]);

    const rows = [
      row({ email: 'same@example.com', name: 'Same Name', department: 'Eng' }),
      row({ email: 'changed@example.com', name: 'New Name', department: 'Eng' }),
      row({ email: 'brandnew@example.com', name: 'Brand New', department: 'Eng' }),
    ];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.unchangedCount).toBe(1);
    expect(plan.updatedCount).toBe(1);
    expect(plan.createdCount).toBe(1);
  });

  it('authoritativeSnapshot dry-run counts deactivations without mutating anything', async () => {
    const stillActive = buildEmployee({ email: 'stays@example.com' });
    const missingFromFile = buildEmployee({ email: 'gone@example.com', status: 'active' });
    mockEmployees.listEmployees.mockResolvedValue([stillActive, missingFromFile]);

    const rows = [row({ email: 'stays@example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: true });

    expect(plan.deactivatedCount).toBe(1);
    // Dry run must never call any mutating db function.
    expect(mockEmployees.updateEmployee).not.toHaveBeenCalled();
    expect(mockEmployees.upsertEmployeeByEmail).not.toHaveBeenCalled();
  });

  it('unresolved rows (validation errors) are excluded from create/update counts', async () => {
    const rows = [row({ email: '', name: '' }), row({ email: 'ok@example.com' })];
    const { plan } = await planImport(rows, { authoritativeSnapshot: false });
    expect(plan.unresolvedCount).toBe(0); // the blank row never even enters `resolved`
    expect(plan.createdCount).toBe(1);
  });
});

describe('commitImport', () => {
  it('refuses to commit when the plan has validation errors', async () => {
    const rows = [row({ email: 'a@example.com', manager_email: 'a@example.com' })];
    await expect(
      commitImport(rows, { authoritativeSnapshot: false, actorId: 'admin-1', sourceName: 'test' })
    ).rejects.toThrow(/validation error/);
    expect(mockEmployees.upsertEmployeeByEmail).not.toHaveBeenCalled();
  });

  it('commits valid rows in manager-before-report order and records a summary', async () => {
    mockEmployees.upsertEmployeeByEmail.mockImplementation((input: { email: string; manager_id: string | null }) => ({
      employee: buildEmployee({ id: `id-${input.email}`, email: input.email, manager_id: input.manager_id }),
      created: true,
    }));

    const rows = [
      row({ email: 'boss@example.com', manager_email: '' }),
      row({ email: 'report@example.com', manager_email: 'boss@example.com' }),
    ];
    const summary = await commitImport(rows, { authoritativeSnapshot: false, actorId: 'admin-1', sourceName: 'test' });

    expect(mockEmployees.upsertEmployeeByEmail).toHaveBeenCalledTimes(2);
    const firstCallEmail = mockEmployees.upsertEmployeeByEmail.mock.calls[0][0].email;
    expect(firstCallEmail).toBe('boss@example.com'); // manager committed before report
    const secondCallArgs = mockEmployees.upsertEmployeeByEmail.mock.calls[1][0];
    expect(secondCallArgs.manager_id).toBe('id-boss@example.com'); // resolved via the same-batch assignedIds map
    expect(summary.created_count).toBe(2);
    expect(mockImports.recordDirectoryImport).toHaveBeenCalledOnce();
  });
});
