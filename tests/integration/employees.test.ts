/**
 * Integration tests against a real DynamoDB Local instance (or any real DynamoDB endpoint set
 * via DYNAMODB_ENDPOINT). These exercise the actual conditional-write / transaction / pagination
 * behavior that unit tests (which mock the AWS SDK client) cannot verify.
 *
 * Run with: docker compose up -d dynamodb-local && npm run db:create && npm run test:integration
 * (see docs/TESTING.md). If DYNAMODB_ENDPOINT is not set, every test in this file is skipped
 * rather than failing, so `npm run test:integration` is safe to run without local Docker.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const hasDynamoLocal = Boolean(process.env.DYNAMODB_ENDPOINT);
const describeIfLocal = hasDynamoLocal ? describe : describe.skip;

describeIfLocal('employees — stable upsert and uniqueness (requires DynamoDB Local)', () => {
  let createEmployee: typeof import('../../src/db/employees').createEmployee;
  let upsertEmployeeByEmail: typeof import('../../src/db/employees').upsertEmployeeByEmail;
  let getEmployeeByEmail: typeof import('../../src/db/employees').getEmployeeByEmail;

  beforeAll(async () => {
    const mod = await import('../../src/db/employees');
    createEmployee = mod.createEmployee;
    upsertEmployeeByEmail = mod.upsertEmployeeByEmail;
    getEmployeeByEmail = mod.getEmployeeByEmail;
  });

  it('rejects a duplicate email via the identity transaction', async () => {
    const email = `dup-${Date.now()}@example.com`;
    await createEmployee({ name: 'First', email, department: 'Eng' });
    await expect(createEmployee({ name: 'Second', email, department: 'Eng' })).rejects.toThrow(/already exists/);
  });

  it('upsertEmployeeByEmail updates the existing employee instead of minting a new ID', async () => {
    const email = `stable-${Date.now()}@example.com`;
    const { employee: first, created: firstCreated } = await upsertEmployeeByEmail({
      name: 'Name One',
      email,
      department: 'Eng',
    });
    expect(firstCreated).toBe(true);

    const { employee: second, created: secondCreated } = await upsertEmployeeByEmail({
      name: 'Name Two',
      email,
      department: 'Sales',
    });
    expect(secondCreated).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Name Two');
    expect(second.department).toBe('Sales');

    const fetched = await getEmployeeByEmail(email);
    expect(fetched?.id).toBe(first.id);
  });
});

if (!hasDynamoLocal) {
  describe('employees integration (skipped)', () => {
    it('DYNAMODB_ENDPOINT is not set — see docs/TESTING.md to run against DynamoDB Local', () => {
      expect(hasDynamoLocal).toBe(false);
    });
  });
}
