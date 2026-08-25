import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAME, queryAll } from './client';
import type { AuditEvent } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'AUDIT#';

export interface LogAuditInput {
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_slack_id?: string;
  cycle_id?: string;
  manager_id?: string;
  details?: Record<string, unknown>;
}

/** Never pass review/feedback text in `details` — audit entries are queryable and exported. */
export async function logAudit(entry: LogAuditInput, clock: Clock = systemClock): Promise<AuditEvent> {
  const id = randomUUID();
  const now = isoNow(clock);
  const event: AuditEvent = { id, created_at: now, ...entry };
  const item: Record<string, unknown> = {
    PK: `${PREFIX}${id}`,
    SK: 'METADATA',
    GSI1PK: `AUDIT_ACTOR#${entry.actor_id}`,
    GSI1SK: `${now}#${id}`,
    GSI2PK: `AUDIT_ENTITY#${entry.entity_type}#${entry.entity_id}`,
    GSI2SK: `${now}#${id}`,
    type: 'AUDIT_EVENT',
    ...event,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return event;
}

function fromItem(item: Record<string, unknown>): AuditEvent {
  return {
    id: item.id as string,
    entity_type: item.entity_type as string,
    entity_id: item.entity_id as string,
    action: item.action as string,
    actor_id: item.actor_id as string,
    actor_slack_id: item.actor_slack_id as string | undefined,
    cycle_id: item.cycle_id as string | undefined,
    manager_id: item.manager_id as string | undefined,
    details: item.details as Record<string, unknown> | undefined,
    created_at: item.created_at as string,
  };
}

export async function listAuditByActor(actorId: string): Promise<AuditEvent[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `AUDIT_ACTOR#${actorId}` },
    ScanIndexForward: false,
  });
  return items.map((i) => fromItem(i));
}

export async function listAuditByEntity(entityType: string, entityId: string): Promise<AuditEvent[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `AUDIT_ENTITY#${entityType}#${entityId}` },
    ScanIndexForward: false,
  });
  return items.map((i) => fromItem(i));
}

/**
 * Admin audit search across actor/entity/cycle/date-range. Backed by the actor index and
 * filtered server-side — acceptable because audit volume per actor is bounded and this is an
 * explicitly admin/reporting path (see docs/DATA_MODEL.md), not a normal user-facing query.
 */
export async function searchAudit(filters: {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  cycleId?: string;
  action?: string;
  from?: string;
  to?: string;
}): Promise<AuditEvent[]> {
  let base: AuditEvent[];
  if (filters.entityType && filters.entityId) {
    base = await listAuditByEntity(filters.entityType, filters.entityId);
  } else if (filters.actorId) {
    base = await listAuditByActor(filters.actorId);
  } else {
    throw new Error('searchAudit requires at least actorId or (entityType and entityId).');
  }
  return base.filter((event) => {
    if (filters.cycleId && event.cycle_id !== filters.cycleId) return false;
    if (filters.action && event.action !== filters.action) return false;
    if (filters.from && event.created_at < filters.from) return false;
    if (filters.to && event.created_at > filters.to) return false;
    return true;
  });
}
