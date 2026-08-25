import { CYCLE_TRANSITIONS, CycleStatus } from '../types';

export class InvalidCycleTransitionError extends Error {
  constructor(from: CycleStatus, to: CycleStatus) {
    super(`Cannot transition cycle from "${from}" to "${to}".`);
    this.name = 'InvalidCycleTransitionError';
  }
}

export function canTransitionCycle(from: CycleStatus, to: CycleStatus): boolean {
  return CYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertValidCycleTransition(from: CycleStatus, to: CycleStatus): void {
  if (!canTransitionCycle(from, to)) {
    throw new InvalidCycleTransitionError(from, to);
  }
}

/**
 * Statuses that hold the singleton "active cycle" lock. Draft cycles may coexist freely;
 * only one cycle may be collecting feedback / under manager or People review / released
 * at a time (per the "only one non-draft, non-closed, non-cancelled cycle may be active" rule).
 */
export const ACTIVE_LOCK_STATUSES: CycleStatus[] = [
  'collecting_feedback',
  'manager_reviews',
  'people_review',
  'released',
];

export function holdsActiveLock(status: CycleStatus): boolean {
  return ACTIVE_LOCK_STATUSES.includes(status);
}

/** Which cycle phase each employee-facing action requires. */
export const ACTION_REQUIRED_PHASE = {
  self_reflection_edit: ['collecting_feedback'] as CycleStatus[],
  peer_request: ['collecting_feedback'] as CycleStatus[],
  peer_feedback_submit: ['collecting_feedback'] as CycleStatus[],
  upward_feedback_submit: ['collecting_feedback'] as CycleStatus[],
  manager_review_edit: ['manager_reviews'] as CycleStatus[],
  people_review_action: ['people_review'] as CycleStatus[],
  acknowledge: ['released', 'closed'] as CycleStatus[],
};

export function requireCyclePhase(status: CycleStatus, action: keyof typeof ACTION_REQUIRED_PHASE): void {
  const allowed = ACTION_REQUIRED_PHASE[action];
  if (!allowed.includes(status)) {
    throw new Error(
      `Action "${action}" is not allowed while the cycle is in phase "${status}" (requires one of: ${allowed.join(', ')}).`
    );
  }
}
