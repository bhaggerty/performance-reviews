import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { AuditLog } from '../types';
import { randomUUID } from 'crypto';

const PREFIX = 'AUDIT#';

export async function logAudit(entry: {
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_slack_id?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const item: Record<string, unknown> = {
    PK: `${PREFIX}${id}`,
    SK: 'METADATA',
    type: 'AUDIT_LOG',
    id,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    action: entry.action,
    actor_id: entry.actor_id,
    created_at: now,
  };
  if (entry.actor_slack_id) item.actor_slack_id = entry.actor_slack_id;
  if (entry.details) item.details = entry.details;
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
    })
  );
}
