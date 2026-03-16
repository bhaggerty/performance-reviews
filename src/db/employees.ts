import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { Employee } from '../types';
import { randomUUID } from 'crypto';

const PREFIX = 'EMP#';
const SLACK_PREFIX = 'SLACK#';
const MANAGER_PREFIX = 'MANAGER#';

function toItem(emp: Employee) {
  return {
    PK: `${PREFIX}${emp.id}`,
    SK: 'METADATA',
    GSI1PK: `${SLACK_PREFIX}${emp.slack_id}`,
    GSI1SK: `${PREFIX}${emp.id}`,
    GSI2PK: `${MANAGER_PREFIX}${emp.manager_id ?? 'none'}`,
    GSI2SK: `${PREFIX}${emp.id}`,
    type: 'EMPLOYEE',
    id: emp.id,
    slack_id: emp.slack_id,
    name: emp.name,
    email: emp.email,
    manager_id: emp.manager_id ?? null,
    department: emp.department,
    status: emp.status,
    created_at: emp.created_at,
    updated_at: emp.updated_at,
  };
}

function fromItem(item: Record<string, unknown>): Employee {
  return {
    id: item.id as string,
    slack_id: item.slack_id as string,
    name: item.name as string,
    email: item.email as string,
    manager_id: (item.manager_id as string) || null,
    department: (item.department as string) ?? '',
    status: (item.status as Employee['status']) ?? 'active',
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

function isMissingIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('The table does not have the specified index');
}

export async function getEmployeeById(id: string): Promise<Employee | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `${PREFIX}${id}`, SK: 'METADATA' },
    })
  );
  if (!r.Item) return null;
  return fromItem(r.Item as Record<string, unknown>);
}

export async function getEmployeeBySlackId(slackId: string): Promise<Employee | null> {
  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `${SLACK_PREFIX}${slackId}` },
        Limit: 1,
      })
    );
    if (!r.Items?.length) return null;
    const item = r.Items[0] as Record<string, unknown>;
    return getEmployeeById((item.id as string) ?? '');
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;

    const fallback = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: '#type = :type AND slack_id = :slackId',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: {
          ':type': 'EMPLOYEE',
          ':slackId': slackId,
        },
        Limit: 1,
      })
    );
    if (!fallback.Items?.length) return null;
    return fromItem(fallback.Items[0] as Record<string, unknown>);
  }
}

export async function getDirectReports(managerId: string): Promise<Employee[]> {
  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `${MANAGER_PREFIX}${managerId}` },
      })
    );
    if (!r.Items?.length) return [];
    const ids = r.Items.map((i) => (i as Record<string, unknown>).id as string).filter(Boolean);
    const employees: Employee[] = [];
    for (const id of ids) {
      const emp = await getEmployeeById(id);
      if (emp) employees.push(emp);
    }
    return employees;
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;

    const fallback = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: '#type = :type AND manager_id = :managerId',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: {
          ':type': 'EMPLOYEE',
          ':managerId': managerId,
        },
      })
    );
    return (fallback.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  }
}

export async function listEmployees(): Promise<Employee[]> {
  const r = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':type': 'EMPLOYEE' },
    })
  );
  return (r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
}

export async function upsertEmployee(emp: Omit<Employee, 'id' | 'created_at' | 'updated_at'>): Promise<Employee> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const full: Employee = {
    ...emp,
    id,
    manager_id: emp.manager_id ?? null,
    status: emp.status ?? 'active',
    created_at: now,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(full),
    })
  );
  return full;
}

export async function updateEmployee(
  id: string,
  updates: Partial<Pick<Employee, 'name' | 'email' | 'manager_id' | 'department' | 'status'>>
): Promise<Employee | null> {
  const existing = await getEmployeeById(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: Employee = { ...existing, ...updates, updated_at: now };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(updated),
    })
  );
  return updated;
}

export async function setManager(employeeId: string, managerId: string | null): Promise<Employee | null> {
  return updateEmployee(employeeId, { manager_id: managerId });
}

export async function findOrCreateEmployeeBySlack(slackId: string, name: string, email: string): Promise<Employee> {
  const existing = await getEmployeeBySlackId(slackId);
  if (existing) return existing;
  return upsertEmployee({
    slack_id: slackId,
    name,
    email,
    manager_id: null,
    department: '',
    status: 'active',
  });
}
