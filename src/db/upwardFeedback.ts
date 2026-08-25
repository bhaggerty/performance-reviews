import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, queryAll, isConditionalCheckFailed } from './client';
import type { UpwardFeedback, UpwardFeedbackRelease, UpwardReleaseMode } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const CYCLE_PREFIX = 'CYCLE#';
const UPWARD_SK_PREFIX = 'UPWARD#';
const RELEASE_SK_PREFIX = 'UPWARDRELEASE#';

function key(cycleId: string, employeeId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${UPWARD_SK_PREFIX}${employeeId}` };
}

function toItem(f: UpwardFeedback) {
  return {
    ...key(f.cycle_id, f.employee_id),
    GSI2PK: `MANAGER_UPWARD#${f.manager_id}`,
    GSI2SK: `${f.cycle_id}#${f.employee_id}`,
    type: 'UPWARD_FEEDBACK',
    ...f,
  };
}

function fromItem(item: Record<string, unknown>): UpwardFeedback {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    manager_id: item.manager_id as string,
    strengths: item.strengths as string | undefined,
    improvements: item.improvements as string | undefined,
    hr_notes: item.hr_notes as string | undefined,
    follow_up_notes: item.follow_up_notes as string | undefined,
    allow_hr_followup: Boolean(item.allow_hr_followup),
    submitted_at: item.submitted_at as string,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

/** One immutable final submission per employee per cycle — conditional create, never overwritten. */
export async function saveUpwardFeedback(
  cycleId: string,
  employeeId: string,
  managerId: string,
  data: {
    strengths?: string;
    improvements?: string;
    hr_notes?: string;
    follow_up_notes?: string;
    allow_hr_followup: boolean;
  },
  clock: Clock = systemClock
): Promise<UpwardFeedback> {
  const now = isoNow(clock);
  const feedback: UpwardFeedback = {
    id: `${cycleId}:${employeeId}`,
    cycle_id: cycleId,
    employee_id: employeeId,
    manager_id: managerId,
    ...data,
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };
  try {
    await docClient.send(
      new PutCommand({ TableName: TABLE_NAME, Item: toItem(feedback), ConditionExpression: 'attribute_not_exists(PK)' })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new Error('Upward feedback has already been submitted for this cycle.');
    }
    throw error;
  }
  return feedback;
}

export async function getUpwardFeedbackForEmployee(
  cycleId: string,
  employeeId: string
): Promise<UpwardFeedback | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: key(cycleId, employeeId) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

/** People-only: raw submissions received about a manager in a cycle. Never surfaced to the manager directly. */
export async function getUpwardFeedbackByManager(cycleId: string, managerId: string): Promise<UpwardFeedback[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
    ExpressionAttributeValues: { ':pk': `MANAGER_UPWARD#${managerId}`, ':sk': `${cycleId}#` },
  });
  return items.map((i) => fromItem(i));
}

// ---------------------------------------------------------------------------
// Upward feedback release (manager-facing, versioned, Primary-Approver-gated)
// ---------------------------------------------------------------------------

function releaseVersionKey(cycleId: string, managerId: string, version: number) {
  return {
    PK: `${CYCLE_PREFIX}${cycleId}`,
    SK: `${RELEASE_SK_PREFIX}${managerId}#${String(version).padStart(6, '0')}`,
  };
}

function latestReleaseKey(cycleId: string, managerId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${RELEASE_SK_PREFIX}${managerId}#LATEST` };
}

function releaseToItem(r: UpwardFeedbackRelease) {
  return { type: 'UPWARD_FEEDBACK_RELEASE', ...r };
}

function releaseFromItem(item: Record<string, unknown>): UpwardFeedbackRelease {
  return {
    cycle_id: item.cycle_id as string,
    manager_id: item.manager_id as string,
    version: item.version as number,
    mode: item.mode as UpwardReleaseMode,
    summary_text: item.summary_text as string | undefined,
    selected_comment_ids: (item.selected_comment_ids as string[]) ?? [],
    respondent_count: item.respondent_count as number,
    below_threshold: Boolean(item.below_threshold),
    threshold_override_reason: item.threshold_override_reason as string | undefined,
    prepared_by: item.prepared_by as string,
    released_by: item.released_by as string,
    released_at: item.released_at as string,
    created_at: item.created_at as string,
  };
}

export async function getLatestUpwardFeedbackRelease(
  cycleId: string,
  managerId: string
): Promise<UpwardFeedbackRelease | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: latestReleaseKey(cycleId, managerId) }));
  return r.Item ? releaseFromItem(r.Item as Record<string, unknown>) : null;
}

/**
 * Records a new, immutable, versioned release. Requires Primary Approver authorization at the
 * call site (see requireUpwardReleasePermission) — this function only persists the decision.
 */
export async function recordUpwardFeedbackRelease(
  input: Omit<UpwardFeedbackRelease, 'version' | 'created_at' | 'released_at'>,
  clock: Clock = systemClock
): Promise<UpwardFeedbackRelease> {
  const previous = await getLatestUpwardFeedbackRelease(input.cycle_id, input.manager_id);
  const version = (previous?.version ?? 0) + 1;
  const now = isoNow(clock);
  const release: UpwardFeedbackRelease = { ...input, version, created_at: now, released_at: now };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...releaseVersionKey(input.cycle_id, input.manager_id, version), ...releaseToItem(release) },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...latestReleaseKey(input.cycle_id, input.manager_id), ...releaseToItem(release) },
    })
  );
  return release;
}
