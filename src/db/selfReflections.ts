import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, queryAll } from './client';
import type { SelfReflection, SelfReflectionState } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const CYCLE_PREFIX = 'CYCLE#';
const SK_PREFIX = 'SELFREFLECTION#';

function key(cycleId: string, employeeId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${SK_PREFIX}${employeeId}` };
}

function toItem(r: SelfReflection) {
  return {
    ...key(r.cycle_id, r.employee_id),
    GSI2PK: `EMP_SELF_REFLECTIONS#${r.employee_id}`,
    GSI2SK: `${CYCLE_PREFIX}${r.cycle_id}`,
    type: 'SELF_REFLECTION',
    ...r,
  };
}

function fromItem(item: Record<string, unknown>): SelfReflection {
  return {
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    prompt_version: (item.prompt_version as number) ?? 1,
    answers: (item.answers as Record<string, string>) ?? {},
    state: (item.state as SelfReflectionState) ?? 'draft',
    version: (item.version as number) ?? 1,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
    submitted_at: item.submitted_at as string | undefined,
    reopened_at: item.reopened_at as string | undefined,
    reopened_by: item.reopened_by as string | undefined,
  };
}

export async function getSelfReflection(cycleId: string, employeeId: string): Promise<SelfReflection | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: key(cycleId, employeeId) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

export async function listSelfReflectionsForEmployee(employeeId: string): Promise<SelfReflection[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMP_SELF_REFLECTIONS#${employeeId}` },
  });
  return items.map((i) => fromItem(i));
}

/** Save-and-resume draft. Idempotent: writing the same answers again is harmless. Blocked once submitted (unless reopened). */
export async function saveSelfReflectionDraft(
  cycleId: string,
  employeeId: string,
  promptVersion: number,
  answers: Record<string, string>,
  clock: Clock = systemClock
): Promise<SelfReflection> {
  const existing = await getSelfReflection(cycleId, employeeId);
  if (existing && existing.state === 'submitted') {
    throw new Error('This self-reflection was already submitted and cannot be edited.');
  }
  const now = isoNow(clock);
  const next: SelfReflection = existing
    ? {
        ...existing,
        answers,
        prompt_version: promptVersion,
        state: 'draft',
        version: existing.version + 1,
        updated_at: now,
      }
    : {
        cycle_id: cycleId,
        employee_id: employeeId,
        prompt_version: promptVersion,
        answers,
        state: 'draft',
        version: 1,
        created_at: now,
        updated_at: now,
      };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: toItem(next) }));
  return next;
}

export async function submitSelfReflection(
  cycleId: string,
  employeeId: string,
  clock: Clock = systemClock
): Promise<SelfReflection> {
  const existing = await getSelfReflection(cycleId, employeeId);
  if (!existing) throw new Error('No self-reflection draft to submit.');
  if (existing.state === 'submitted') return existing; // idempotent: duplicate submit is a no-op
  const now = isoNow(clock);
  const next: SelfReflection = { ...existing, state: 'submitted', submitted_at: now, updated_at: now };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(next),
      ConditionExpression: '#state <> :submitted OR attribute_not_exists(#state)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':submitted': 'submitted' },
    })
  );
  return next;
}

export async function reopenSelfReflection(
  cycleId: string,
  employeeId: string,
  reopenedBy: string,
  clock: Clock = systemClock
): Promise<SelfReflection | null> {
  const existing = await getSelfReflection(cycleId, employeeId);
  if (!existing) return null;
  const now = isoNow(clock);
  const next: SelfReflection = {
    ...existing,
    state: 'reopened',
    reopened_at: now,
    reopened_by: reopenedBy,
    updated_at: now,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: toItem(next) }));
  return next;
}
