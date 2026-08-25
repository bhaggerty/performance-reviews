import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { docClient, TABLE_NAME, isConditionalCheckFailed } from './client';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'IDEMPOTENCY#';
const TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export function hashKey(...parts: (string | undefined)[]): string {
  return createHash('sha256').update(parts.filter(Boolean).join('|')).digest('hex');
}

/**
 * Claims a one-time key for a scoped operation (a Slack view/action delivery, a web approval
 * request, a bulk release, an import commit, ...). Returns true the first time a given key is
 * seen, false on every subsequent (duplicate/retried) attempt — callers should skip the side
 * effect and return the same outcome without re-running it.
 */
export async function claimIdempotencyKey(scope: string, key: string, clock: Clock = systemClock): Promise<boolean> {
  const now = clock.now();
  const ttl = Math.floor(now.getTime() / 1000) + TTL_SECONDS;
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `${PREFIX}${scope}`,
          SK: key,
          type: 'IDEMPOTENCY_RECORD',
          scope,
          key,
          created_at: isoNow(clock),
          ttl,
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
