import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, isConditionalCheckFailed } from './client';
import type { ReviewRelease } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const CYCLE_PREFIX = 'CYCLE#';
const SK_PREFIX = 'RELEASE#';

function key(cycleId: string, employeeId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${SK_PREFIX}${employeeId}` };
}

function toItem(r: ReviewRelease) {
  return {
    GSI2PK: `EMP_RELEASES#${r.employee_id}`,
    GSI2SK: `${CYCLE_PREFIX}${r.cycle_id}`,
    type: 'REVIEW_RELEASE',
    ...r,
  };
}

function fromItem(item: Record<string, unknown>): ReviewRelease {
  return {
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    review_version: item.review_version as number,
    document_id: item.document_id as string,
    released_by: item.released_by as string,
    released_at: item.released_at as string,
  };
}

export async function getReviewRelease(cycleId: string, employeeId: string): Promise<ReviewRelease | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: key(cycleId, employeeId) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

/** Conditional create: a review can only be released once. Re-release after a version change
 * requires a new cycle/entity path — this call never overwrites an existing release. */
export async function createReviewRelease(
  input: Omit<ReviewRelease, 'released_at'>,
  clock: Clock = systemClock
): Promise<ReviewRelease> {
  const release: ReviewRelease = { ...input, released_at: isoNow(clock) };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...key(input.cycle_id, input.employee_id), ...toItem(release) },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) throw new Error('This review has already been released.');
    throw error;
  }
  return release;
}
