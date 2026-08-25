import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, isConditionalCheckFailed } from './client';
import type { Acknowledgement } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const CYCLE_PREFIX = 'CYCLE#';
const SK_PREFIX = 'ACK#';

function key(cycleId: string, employeeId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${SK_PREFIX}${employeeId}` };
}

function toItem(a: Acknowledgement) {
  return { GSI2PK: `EMP_ACKS#${a.employee_id}`, GSI2SK: `${CYCLE_PREFIX}${a.cycle_id}`, type: 'ACKNOWLEDGEMENT', ...a };
}

function fromItem(item: Record<string, unknown>): Acknowledgement {
  return {
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    review_version: item.review_version as number,
    comment: item.comment as string | undefined,
    acknowledged_at: item.acknowledged_at as string,
  };
}

export async function getAcknowledgement(cycleId: string, employeeId: string): Promise<Acknowledgement | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: key(cycleId, employeeId) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

/**
 * Append-only: acknowledgement timestamp and optional comment are written atomically in one
 * conditional PutItem. A duplicate acknowledge (retry, double-click) is idempotent — it
 * returns the original record rather than throwing or overwriting it.
 */
export async function createAcknowledgement(
  input: Omit<Acknowledgement, 'acknowledged_at'>,
  clock: Clock = systemClock
): Promise<Acknowledgement> {
  const existing = await getAcknowledgement(input.cycle_id, input.employee_id);
  if (existing) return existing;

  const ack: Acknowledgement = { ...input, acknowledged_at: isoNow(clock) };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...key(input.cycle_id, input.employee_id), ...toItem(ack) },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const raced = await getAcknowledgement(input.cycle_id, input.employee_id);
      if (raced) return raced;
    }
    throw error;
  }
  return ack;
}
