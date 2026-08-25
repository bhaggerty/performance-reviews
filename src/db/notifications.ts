import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAME, isConditionalCheckFailed } from './client';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'NOTIFY#';

/**
 * Records that a given notification (dedupe_key scoped to employee+type) has been sent.
 * Returns false if it was already sent — callers use this to avoid duplicate Slack DMs from
 * a retried job or an overlapping reminder run.
 */
export async function claimNotification(
  employeeId: string,
  type: string,
  dedupeKey: string,
  clock: Clock = systemClock
): Promise<boolean> {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `${PREFIX}${employeeId}`,
          SK: `${type}#${dedupeKey}`,
          type: 'NOTIFICATION_RECORD',
          id: randomUUID(),
          employee_id: employeeId,
          notification_type: type,
          dedupe_key: dedupeKey,
          sent_at: isoNow(clock),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}
