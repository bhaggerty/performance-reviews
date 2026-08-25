import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, queryAll, isConditionalCheckFailed } from './client';
import type { OutboxJob, OutboxJobStatus, OutboxJobType } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'JOB#';
const DEFAULT_MAX_ATTEMPTS = 5;

function key(id: string) {
  return { PK: `${PREFIX}${id}`, SK: 'METADATA' };
}

function toItem(job: OutboxJob) {
  return {
    GSI1PK: `JOB_STATUS#${job.status}`,
    GSI1SK: `${job.run_after}#${job.id}`,
    record_type: 'OUTBOX_JOB',
    ...job,
  };
}

function fromItem(item: Record<string, unknown>): OutboxJob {
  return {
    id: item.id as string,
    type: item.type as OutboxJobType,
    status: item.status as OutboxJobStatus,
    payload: (item.payload as Record<string, unknown>) ?? {},
    attempts: (item.attempts as number) ?? 0,
    max_attempts: (item.max_attempts as number) ?? DEFAULT_MAX_ATTEMPTS,
    run_after: item.run_after as string,
    last_error: item.last_error as string | undefined,
    idempotency_key: item.idempotency_key as string,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

/** Enqueue a job idempotently — a duplicate enqueue with the same idempotency_key is a no-op. */
export async function enqueueJob(
  type: OutboxJobType,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  opts: { runAfter?: string; maxAttempts?: number } = {},
  clock: Clock = systemClock
): Promise<OutboxJob> {
  const id = idempotencyKey; // deterministic id makes re-enqueue naturally idempotent
  const now = isoNow(clock);
  const job: OutboxJob = {
    id,
    type,
    status: 'pending',
    payload,
    attempts: 0,
    max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    run_after: opts.runAfter ?? now,
    idempotency_key: idempotencyKey,
    created_at: now,
    updated_at: now,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...key(id), ...toItem(job) },
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const existing = await getJob(id);
      if (existing) return existing;
    }
    throw error;
  }
  return job;
}

export async function getJob(id: string): Promise<OutboxJob | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: key(id) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

export async function listJobsByStatus(status: OutboxJobStatus): Promise<OutboxJob[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `JOB_STATUS#${status}` },
  });
  return items.map((i) => fromItem(i));
}

/** Ready-to-run pending jobs whose run_after has passed. */
export async function listDueJobs(clock: Clock = systemClock): Promise<OutboxJob[]> {
  const pending = await listJobsByStatus('pending');
  const now = isoNow(clock);
  return pending.filter((job) => job.run_after <= now);
}

export async function markJobProcessing(job: OutboxJob, clock: Clock = systemClock): Promise<OutboxJob> {
  const updated: OutboxJob = { ...job, status: 'processing', attempts: job.attempts + 1, updated_at: isoNow(clock) };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...key(job.id), ...toItem(updated) } }));
  return updated;
}

export async function markJobSucceeded(job: OutboxJob, clock: Clock = systemClock): Promise<OutboxJob> {
  const updated: OutboxJob = { ...job, status: 'succeeded', updated_at: isoNow(clock) };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...key(job.id), ...toItem(updated) } }));
  return updated;
}

export async function markJobFailed(job: OutboxJob, error: string, clock: Clock = systemClock): Promise<OutboxJob> {
  const status: OutboxJobStatus = job.attempts >= job.max_attempts ? 'dead_letter' : 'pending';
  const backoffMs = Math.min(60_000 * 2 ** job.attempts, 30 * 60_000);
  const updated: OutboxJob = {
    ...job,
    status,
    last_error: error,
    run_after: status === 'pending' ? new Date(clock.now().getTime() + backoffMs).toISOString() : job.run_after,
    updated_at: isoNow(clock),
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...key(job.id), ...toItem(updated) } }));
  return updated;
}

export async function retryDeadLetterJob(id: string, clock: Clock = systemClock): Promise<OutboxJob | null> {
  const job = await getJob(id);
  if (!job || job.status !== 'dead_letter') return null;
  const updated: OutboxJob = {
    ...job,
    status: 'pending',
    attempts: 0,
    run_after: isoNow(clock),
    updated_at: isoNow(clock),
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: { ...key(job.id), ...toItem(updated) } }));
  return updated;
}
