import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAME, queryAll, isConditionalCheckFailed } from './client';
import type {
  Approval,
  ApprovalAction,
  AtRiskDetails,
  ManagerReview,
  PeopleNote,
  PeopleReviewState,
  ReviewStatus,
} from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const CYCLE_PREFIX = 'CYCLE#';
const CURRENT_SK_PREFIX = 'REVIEW#';
const CURRENT_SK_SUFFIX = '#CURRENT';
const VERSION_SK_PREFIX = 'REVIEWVERSION#';
const NOTE_SK_PREFIX = 'PEOPLENOTE#';
const APPROVAL_SK_PREFIX = 'APPROVAL#';

function currentKey(cycleId: string, employeeId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${CURRENT_SK_PREFIX}${employeeId}${CURRENT_SK_SUFFIX}` };
}

function versionKey(cycleId: string, employeeId: string, version: number) {
  return {
    PK: `${CYCLE_PREFIX}${cycleId}`,
    SK: `${VERSION_SK_PREFIX}${employeeId}#${String(version).padStart(6, '0')}`,
  };
}

/** Used only for the CURRENT pointer row — this is the one row per (cycle, employee) that
 * should appear in "reviews by manager" / "reviews by employee" listings. */
function toCurrentItem(r: ManagerReview) {
  return {
    GSI1PK: `MANAGER_REVIEWS#${r.manager_id}`,
    GSI1SK: `${r.cycle_id}#${r.employee_id}`,
    GSI2PK: `EMP_REVIEW_HISTORY#${r.employee_id}`,
    GSI2SK: `${CYCLE_PREFIX}${r.cycle_id}`,
    type: 'MANAGER_REVIEW',
    ...r,
  };
}

/** Used for per-version history rows — deliberately excluded from GSI1/GSI2 so history entries
 * never duplicate the CURRENT row in manager/employee listings. */
function toVersionItem(r: ManagerReview) {
  return { type: 'MANAGER_REVIEW_VERSION', ...r };
}

function fromItem(item: Record<string, unknown>): ManagerReview {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    manager_id: item.manager_id as string,
    version: item.version as number,
    status: item.status as ReviewStatus,
    strengths: item.strengths as string | undefined,
    focus_areas: item.focus_areas as string | undefined,
    examples: item.examples as string | undefined,
    development_areas: item.development_areas as string | undefined,
    next_cycle_expectations: item.next_cycle_expectations as string | undefined,
    manager_support: item.manager_support as string | undefined,
    at_risk: item.at_risk as AtRiskDetails | undefined,
    follow_up_notes: item.follow_up_notes as string | undefined,
    people_state: (item.people_state as PeopleReviewState) ?? 'not_submitted',
    return_reason: item.return_reason as string | undefined,
    submitted_at: item.submitted_at as string,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function getManagerReview(cycleId: string, employeeId: string): Promise<ManagerReview | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: currentKey(cycleId, employeeId) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

export async function getReviewsByCycle(cycleId: string): Promise<ManagerReview[]> {
  // "REVIEW#" and "REVIEWVERSION#" never collide under begins_with (position 6 differs: '#' vs 'V'),
  // so this only matches the CURRENT pointer rows, not the per-version history rows.
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${CYCLE_PREFIX}${cycleId}`, ':sk': CURRENT_SK_PREFIX },
  });
  return items.map((i) => fromItem(i));
}

export async function getReviewHistory(cycleId: string, employeeId: string): Promise<ManagerReview[]> {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${CYCLE_PREFIX}${cycleId}`, ':sk': `${VERSION_SK_PREFIX}${employeeId}#` },
  });
  return items.map((i) => fromItem(i)).sort((a, b) => a.version - b.version);
}

export async function listReviewsByManager(managerId: string): Promise<ManagerReview[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `MANAGER_REVIEWS#${managerId}` },
  });
  return items.map((i) => fromItem(i));
}

export async function getReviewsByEmployeeAcrossCycles(employeeId: string): Promise<ManagerReview[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMP_REVIEW_HISTORY#${employeeId}` },
  });
  return items.map((i) => fromItem(i));
}

export interface ManagerReviewDraftInput {
  status: ReviewStatus;
  strengths?: string;
  focus_areas?: string;
  examples?: string;
  development_areas?: string;
  next_cycle_expectations?: string;
  manager_support?: string;
  at_risk?: AtRiskDetails;
  follow_up_notes?: string;
}

const EDITABLE_STATES: PeopleReviewState[] = ['not_submitted', 'manager_draft', 'returned_to_manager'];

async function persistVersion(review: ManagerReview): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...versionKey(review.cycle_id, review.employee_id, review.version), ...toVersionItem(review) },
    })
  );
}

/** Save/resume a manager-review draft. Editable while not yet submitted, or while returned by People. */
export async function saveManagerReviewDraft(
  cycleId: string,
  employeeId: string,
  managerId: string,
  data: ManagerReviewDraftInput,
  clock: Clock = systemClock
): Promise<ManagerReview> {
  const existing = await getManagerReview(cycleId, employeeId);
  if (existing && !EDITABLE_STATES.includes(existing.people_state)) {
    throw new Error('This review is not editable in its current state.');
  }
  const now = isoNow(clock);
  const next: ManagerReview = {
    id: existing?.id ?? randomUUID(),
    cycle_id: cycleId,
    employee_id: employeeId,
    manager_id: managerId,
    version: (existing?.version ?? 0) + 1,
    ...data,
    people_state: 'manager_draft',
    return_reason: existing?.return_reason,
    submitted_at: existing?.submitted_at ?? '',
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  const conditionExpression = existing ? 'version = :expected' : 'attribute_not_exists(PK)';
  const expressionValues = existing ? { ':expected': existing.version } : undefined;

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...currentKey(cycleId, employeeId), ...toCurrentItem(next) },
      ConditionExpression: conditionExpression,
      ExpressionAttributeValues: expressionValues,
    })
  );
  await persistVersion(next);
  return next;
}

/** Final submission: conditionally written so it cannot silently clobber an already-submitted review. */
export async function submitManagerReview(
  cycleId: string,
  employeeId: string,
  managerId: string,
  data: ManagerReviewDraftInput,
  clock: Clock = systemClock
): Promise<ManagerReview> {
  const existing = await getManagerReview(cycleId, employeeId);
  if (existing && !EDITABLE_STATES.includes(existing.people_state)) {
    throw new Error('This review has already been submitted and is awaiting People review.');
  }
  const now = isoNow(clock);
  const next: ManagerReview = {
    id: existing?.id ?? randomUUID(),
    cycle_id: cycleId,
    employee_id: employeeId,
    manager_id: managerId,
    version: (existing?.version ?? 0) + 1,
    ...data,
    people_state: 'submitted',
    return_reason: undefined,
    submitted_at: now,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...currentKey(cycleId, employeeId), ...toCurrentItem(next) },
        ConditionExpression: existing
          ? '(version = :expected) AND (people_state IN (:s1, :s2, :s3))'
          : 'attribute_not_exists(PK)',
        ExpressionAttributeValues: existing
          ? {
              ':expected': existing.version,
              ':s1': 'not_submitted',
              ':s2': 'manager_draft',
              ':s3': 'returned_to_manager',
            }
          : undefined,
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new Error('This review has already been submitted and is awaiting People review.');
    }
    throw error;
  }
  await persistVersion(next);
  return next;
}

async function transitionPeopleState(
  cycleId: string,
  employeeId: string,
  expectedStates: PeopleReviewState[],
  nextState: PeopleReviewState,
  extra: Partial<ManagerReview>,
  clock: Clock = systemClock
): Promise<ManagerReview> {
  const existing = await getManagerReview(cycleId, employeeId);
  if (!existing) throw new Error('Review not found.');
  if (!expectedStates.includes(existing.people_state)) {
    throw new Error(`Review is in state "${existing.people_state}"; expected one of: ${expectedStates.join(', ')}.`);
  }
  const updated: ManagerReview = { ...existing, ...extra, people_state: nextState, updated_at: isoNow(clock) };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...currentKey(cycleId, employeeId), ...toCurrentItem(updated) },
        ConditionExpression: 'version = :v AND people_state = :expected',
        ExpressionAttributeValues: { ':v': existing.version, ':expected': existing.people_state },
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) throw new Error('This review changed concurrently. Reload and try again.');
    throw error;
  }
  return updated;
}

export const returnToManager = (cycleId: string, employeeId: string, reason: string, clock?: Clock) =>
  transitionPeopleState(
    cycleId,
    employeeId,
    ['submitted', 'people_reviewing'],
    'returned_to_manager',
    { return_reason: reason },
    clock
  );

export const markPeopleReviewComplete = (cycleId: string, employeeId: string, clock?: Clock) =>
  transitionPeopleState(cycleId, employeeId, ['submitted', 'people_reviewing'], 'people_review_complete', {}, clock);

export const beginPeopleReview = (cycleId: string, employeeId: string, clock?: Clock) =>
  transitionPeopleState(cycleId, employeeId, ['submitted'], 'people_reviewing', {}, clock);

export const markAwaitingPrimaryApproval = (cycleId: string, employeeId: string, clock?: Clock) =>
  transitionPeopleState(cycleId, employeeId, ['people_review_complete'], 'awaiting_primary_approval', {}, clock);

export const markApproved = (cycleId: string, employeeId: string, clock?: Clock) =>
  transitionPeopleState(
    cycleId,
    employeeId,
    ['people_review_complete', 'awaiting_primary_approval'],
    'approved',
    {},
    clock
  );

export const markReleased = (cycleId: string, employeeId: string, clock?: Clock) =>
  transitionPeopleState(cycleId, employeeId, ['approved'], 'released', {}, clock);

export const markAcknowledged = (cycleId: string, employeeId: string, clock?: Clock) =>
  transitionPeopleState(cycleId, employeeId, ['released'], 'acknowledged', {}, clock);

// ---------------------------------------------------------------------------
// People notes (internal, never shown to employee/manager)
// ---------------------------------------------------------------------------

export async function addPeopleNote(
  cycleId: string,
  employeeId: string,
  authorId: string,
  note: string,
  clock: Clock = systemClock
): Promise<PeopleNote> {
  const now = isoNow(clock);
  const record: PeopleNote = {
    cycle_id: cycleId,
    employee_id: employeeId,
    id: randomUUID(),
    author_id: authorId,
    note,
    created_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${CYCLE_PREFIX}${cycleId}`,
        SK: `${NOTE_SK_PREFIX}${employeeId}#${now}#${record.id}`,
        type: 'PEOPLE_NOTE',
        ...record,
      },
    })
  );
  return record;
}

export async function listPeopleNotes(cycleId: string, employeeId: string): Promise<PeopleNote[]> {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${CYCLE_PREFIX}${cycleId}`, ':sk': `${NOTE_SK_PREFIX}${employeeId}#` },
  });
  return items.map((i) => i as unknown as PeopleNote);
}

// ---------------------------------------------------------------------------
// Approvals (recommend / primary approve) — distinct from release
// ---------------------------------------------------------------------------

export async function recordApproval(
  cycleId: string,
  employeeId: string,
  action: ApprovalAction,
  actorId: string,
  reviewVersion: number,
  notes: string | undefined,
  clock: Clock = systemClock
): Promise<Approval> {
  const now = isoNow(clock);
  const approval: Approval = {
    id: randomUUID(),
    cycle_id: cycleId,
    employee_id: employeeId,
    action,
    actor_id: actorId,
    review_version: reviewVersion,
    notes,
    created_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${CYCLE_PREFIX}${cycleId}`,
        SK: `${APPROVAL_SK_PREFIX}${employeeId}#${now}#${approval.id}`,
        type: 'APPROVAL',
        ...approval,
      },
    })
  );
  return approval;
}

export async function listApprovals(cycleId: string, employeeId: string): Promise<Approval[]> {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${CYCLE_PREFIX}${cycleId}`, ':sk': `${APPROVAL_SK_PREFIX}${employeeId}#` },
  });
  return items.map((i) => i as unknown as Approval);
}
