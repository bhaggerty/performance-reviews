import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAME } from './client';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'WEBSESSION#';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h; rotated on privileged actions, cleared on logout

export interface WebSession {
  id: string;
  employee_email: string;
  created_at: string;
  ttl: number;
}

export async function createWebSession(employeeEmail: string, clock: Clock = systemClock): Promise<WebSession> {
  const id = randomUUID();
  const now = clock.now();
  const session: WebSession = {
    id,
    employee_email: employeeEmail,
    created_at: isoNow(clock),
    ttl: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { PK: `${PREFIX}${id}`, SK: 'METADATA', type: 'WEB_SESSION', ...session },
    })
  );
  return session;
}

export async function getWebSession(id: string): Promise<WebSession | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `${PREFIX}${id}`, SK: 'METADATA' } })
  );
  if (!r.Item) return null;
  const session = r.Item as unknown as WebSession;
  if (session.ttl * 1000 < Date.now()) return null; // expired; DynamoDB TTL sweep may lag
  return session;
}

export async function deleteWebSession(id: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `${PREFIX}${id}`, SK: 'METADATA' } }));
}
