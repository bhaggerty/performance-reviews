import { describe, it, expect } from 'vitest';
import {
  canTransitionCycle,
  assertValidCycleTransition,
  InvalidCycleTransitionError,
  holdsActiveLock,
  requireCyclePhase,
  ACTION_REQUIRED_PHASE,
} from '../../src/domain/cycleStateMachine';
import type { CycleStatus } from '../../src/types';

const ALL_STATUSES: CycleStatus[] = [
  'draft',
  'collecting_feedback',
  'manager_reviews',
  'people_review',
  'released',
  'closed',
  'cancelled',
];

const LEGAL: [CycleStatus, CycleStatus][] = [
  ['draft', 'collecting_feedback'],
  ['draft', 'cancelled'],
  ['collecting_feedback', 'manager_reviews'],
  ['collecting_feedback', 'cancelled'],
  ['manager_reviews', 'people_review'],
  ['manager_reviews', 'cancelled'],
  ['people_review', 'released'],
  ['people_review', 'cancelled'],
  ['released', 'closed'],
];

describe('canTransitionCycle / assertValidCycleTransition', () => {
  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(canTransitionCycle(from, to)).toBe(true);
    expect(() => assertValidCycleTransition(from, to)).not.toThrow();
  });

  it('rejects every (from, to) pair not in the legal list', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    let illegalCount = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (legalSet.has(`${from}->${to}`)) continue;
        illegalCount += 1;
        expect(canTransitionCycle(from, to)).toBe(false);
        expect(() => assertValidCycleTransition(from, to)).toThrow(InvalidCycleTransitionError);
      }
    }
    // Sanity: we actually exercised a meaningful number of illegal pairs, not zero.
    expect(illegalCount).toBeGreaterThan(30);
  });

  it('closed and cancelled are terminal (no outgoing transitions)', () => {
    for (const to of ALL_STATUSES) {
      expect(canTransitionCycle('closed', to)).toBe(false);
      expect(canTransitionCycle('cancelled', to)).toBe(false);
    }
  });
});

describe('holdsActiveLock', () => {
  it('draft, closed, and cancelled do not hold the lock', () => {
    expect(holdsActiveLock('draft')).toBe(false);
    expect(holdsActiveLock('closed')).toBe(false);
    expect(holdsActiveLock('cancelled')).toBe(false);
  });

  it('collecting_feedback, manager_reviews, people_review, released hold the lock', () => {
    expect(holdsActiveLock('collecting_feedback')).toBe(true);
    expect(holdsActiveLock('manager_reviews')).toBe(true);
    expect(holdsActiveLock('people_review')).toBe(true);
    expect(holdsActiveLock('released')).toBe(true);
  });
});

describe('requireCyclePhase', () => {
  it.each(Object.keys(ACTION_REQUIRED_PHASE) as (keyof typeof ACTION_REQUIRED_PHASE)[])(
    'action "%s" is allowed in each of its required phases and rejected in others',
    (action) => {
      const allowed = ACTION_REQUIRED_PHASE[action];
      for (const status of allowed) {
        expect(() => requireCyclePhase(status, action)).not.toThrow();
      }
      for (const status of ALL_STATUSES.filter((s) => !allowed.includes(s))) {
        expect(() => requireCyclePhase(status, action)).toThrow();
      }
    }
  );
});
