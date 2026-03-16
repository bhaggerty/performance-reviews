import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { ReviewCycle } from '../types';
import { randomUUID } from 'crypto';

const PREFIX = 'CYCLE#';

function toItem(c: ReviewCycle) {
  return {
    PK: `${PREFIX}${c.id}`,
    SK: 'METADATA',
    type: 'REVIEW_CYCLE',
    id: c.id,
    name: c.name,
    start_date: c.start_date,
    end_date: c.end_date,
    status: c.status,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function fromItem(item: Record<string, unknown>): ReviewCycle {
  return {
    id: item.id as string,
    name: item.name as string,
    start_date: item.start_date as string,
    end_date: item.end_date as string,
    status: (item.status as ReviewCycle['status']) ?? 'draft',
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function getCycleById(id: string): Promise<ReviewCycle | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `${PREFIX}${id}`, SK: 'METADATA' },
    })
  );
  if (!r.Item) return null;
  return fromItem(r.Item as Record<string, unknown>);
}

export async function listCycles(): Promise<ReviewCycle[]> {
  const r = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':type': 'REVIEW_CYCLE' },
    })
  );
  const cycles = (r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  return cycles.sort((a, b) => b.start_date.localeCompare(a.start_date));
}

export async function getActiveCycle(): Promise<ReviewCycle | null> {
  const cycles = await listCycles();
  return cycles.find((c) => c.status === 'open') ?? null;
}

export async function createCycle(
  name: string,
  start_date: string,
  end_date: string,
  status: ReviewCycle['status'] = 'draft'
): Promise<ReviewCycle> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const cycle: ReviewCycle = {
    id,
    name,
    start_date,
    end_date,
    status,
    created_at: now,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(cycle),
    })
  );
  return cycle;
}

export async function updateCycleStatus(id: string, status: ReviewCycle['status']): Promise<ReviewCycle | null> {
  const existing = await getCycleById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: ReviewCycle = { ...existing, status, updated_at: now };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(updated),
    })
  );
  return updated;
}
