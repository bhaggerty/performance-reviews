import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, queryAll, TABLE_NAME, isConditionalCheckFailed } from './client';
import {
  CycleDeadlines,
  CycleStatus,
  DEFAULT_SELF_REFLECTION_PROMPTS,
  ReviewCycle,
  SelfReflectionPromptConfig,
} from '../types';
import { assertValidCycleTransition, holdsActiveLock } from '../domain/cycleStateMachine';
import { isoNow, systemClock, type Clock } from '../domain/clock';
import type { TransactWriteItem } from './identities';

const PREFIX = 'CYCLE#';
const ACTIVE_LOCK_KEY = { PK: 'SYSTEM#ACTIVE_CYCLE', SK: 'METADATA' };

function toItem(c: ReviewCycle) {
  return {
    PK: `${PREFIX}${c.id}`,
    SK: 'METADATA',
    GSI1PK: 'CYCLE_DIRECTORY',
    GSI1SK: `${c.created_at}#${c.id}`,
    type: 'REVIEW_CYCLE',
    ...c,
  };
}

function fromItem(item: Record<string, unknown>): ReviewCycle {
  return {
    id: item.id as string,
    name: item.name as string,
    status: (item.status as CycleStatus) ?? 'draft',
    timezone: (item.timezone as string) ?? 'UTC',
    deadlines: (item.deadlines as CycleDeadlines) ?? {},
    self_reflection_prompts:
      (item.self_reflection_prompts as SelfReflectionPromptConfig[]) ?? DEFAULT_SELF_REFLECTION_PROMPTS,
    max_peers: (item.max_peers as number) ?? 3,
    schema_version: (item.schema_version as number) ?? 1,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
    created_by: (item.created_by as string) ?? '',
  };
}

export async function getCycleById(id: string): Promise<ReviewCycle | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `${PREFIX}${id}`, SK: 'METADATA' } })
  );
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

export async function listCycles(): Promise<ReviewCycle[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'CYCLE_DIRECTORY' },
    ScanIndexForward: false,
  });
  return items.map((i) => fromItem(i));
}

export async function getActiveCycle(): Promise<ReviewCycle | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: ACTIVE_LOCK_KEY }));
  const activeCycleId = r.Item?.active_cycle_id as string | undefined;
  return activeCycleId ? getCycleById(activeCycleId) : null;
}

export interface CreateCycleInput {
  name: string;
  timezone?: string;
  deadlines?: CycleDeadlines;
  self_reflection_prompts?: SelfReflectionPromptConfig[];
  max_peers?: number;
}

export async function createCycle(
  input: CreateCycleInput,
  actorId: string,
  clock: Clock = systemClock
): Promise<ReviewCycle> {
  const id = randomUUID();
  const now = isoNow(clock);
  const cycle: ReviewCycle = {
    id,
    name: input.name,
    status: 'draft',
    timezone: input.timezone ?? 'UTC',
    deadlines: input.deadlines ?? {},
    self_reflection_prompts: input.self_reflection_prompts ?? DEFAULT_SELF_REFLECTION_PROMPTS,
    max_peers: input.max_peers ?? 3,
    schema_version: 1,
    created_at: now,
    updated_at: now,
    created_by: actorId,
  };
  await docClient.send(
    new PutCommand({ TableName: TABLE_NAME, Item: toItem(cycle), ConditionExpression: 'attribute_not_exists(PK)' })
  );
  return cycle;
}

export async function updateCycleConfig(
  id: string,
  updates: Partial<Pick<CreateCycleInput, 'name' | 'timezone' | 'deadlines' | 'self_reflection_prompts' | 'max_peers'>>,
  clock: Clock = systemClock
): Promise<ReviewCycle | null> {
  const existing = await getCycleById(id);
  if (!existing) return null;
  const updated: ReviewCycle = { ...existing, ...updates, updated_at: isoNow(clock) };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(updated),
      ConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': existing.status },
    })
  );
  return updated;
}

/**
 * Explicit, conditional lifecycle transition. Acquires or releases the singleton
 * "one active cycle" lock as needed so a second cycle can never enter
 * collecting_feedback/manager_reviews/people_review/released while another already holds it.
 */
export async function transitionCycle(
  id: string,
  toStatus: CycleStatus,
  actorId: string,
  clock: Clock = systemClock
): Promise<ReviewCycle> {
  const existing = await getCycleById(id);
  if (!existing) throw new Error(`Cycle ${id} not found.`);
  assertValidCycleTransition(existing.status, toStatus);

  const now = isoNow(clock);
  const updated: ReviewCycle = { ...existing, status: toStatus, updated_at: now };
  const enteringLock = !holdsActiveLock(existing.status) && holdsActiveLock(toStatus);
  const leavingLock = holdsActiveLock(existing.status) && !holdsActiveLock(toStatus);

  const cyclePut: TransactWriteItem = {
    Put: {
      TableName: TABLE_NAME,
      Item: toItem(updated),
      ConditionExpression: '#status = :expected',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':expected': existing.status },
    },
  };

  const transactItems: TransactWriteItem[] = [cyclePut];
  if (enteringLock) {
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: { ...ACTIVE_LOCK_KEY, active_cycle_id: id, updated_at: now },
        ConditionExpression: 'attribute_not_exists(PK)',
      },
    });
  } else if (leavingLock) {
    transactItems.push({
      Put: {
        TableName: TABLE_NAME,
        Item: { ...ACTIVE_LOCK_KEY, active_cycle_id: null, updated_at: now },
        ConditionExpression: 'active_cycle_id = :id',
        ExpressionAttributeValues: { ':id': id },
      },
    });
  }

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      if (enteringLock) {
        throw new Error('Another cycle is already active. Close or cancel it before starting this one.');
      }
      throw new Error('This cycle was modified concurrently. Reload and try again.');
    }
    throw error;
  }
  void actorId; // recorded by the caller in the audit log, not on the cycle row itself
  return updated;
}
