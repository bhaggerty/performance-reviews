/**
 * Requires DynamoDB Local (DYNAMODB_ENDPOINT set) — see docs/TESTING.md. Skips cleanly
 * otherwise so `npm run test:integration` never fails on a machine without Docker.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const hasDynamoLocal = Boolean(process.env.DYNAMODB_ENDPOINT);
const describeIfLocal = hasDynamoLocal ? describe : describe.skip;

describeIfLocal('review cycle — active-cycle singleton lock (requires DynamoDB Local)', () => {
  let createCycle: typeof import('../../src/db/cycles').createCycle;
  let transitionCycle: typeof import('../../src/db/cycles').transitionCycle;
  let getActiveCycle: typeof import('../../src/db/cycles').getActiveCycle;

  beforeAll(async () => {
    const mod = await import('../../src/db/cycles');
    createCycle = mod.createCycle;
    transitionCycle = mod.transitionCycle;
    getActiveCycle = mod.getActiveCycle;
  });

  it('only one cycle may hold the active lock at a time', async () => {
    const cycleA = await createCycle({ name: `A-${Date.now()}` }, 'admin-1');
    const cycleB = await createCycle({ name: `B-${Date.now()}` }, 'admin-1');

    await transitionCycle(cycleA.id, 'collecting_feedback', 'admin-1');
    const active = await getActiveCycle();
    expect(active?.id).toBe(cycleA.id);

    await expect(transitionCycle(cycleB.id, 'collecting_feedback', 'admin-1')).rejects.toThrow(/already active/);

    // Releasing the lock (cancel) must free it up for the next cycle.
    await transitionCycle(cycleA.id, 'cancelled', 'admin-1');
    await transitionCycle(cycleB.id, 'collecting_feedback', 'admin-1');
    const nowActive = await getActiveCycle();
    expect(nowActive?.id).toBe(cycleB.id);
  });

  it('rejects an illegal transition (e.g. draft -> released)', async () => {
    const cycle = await createCycle({ name: `Illegal-${Date.now()}` }, 'admin-1');
    await expect(transitionCycle(cycle.id, 'released', 'admin-1')).rejects.toThrow();
  });
});
