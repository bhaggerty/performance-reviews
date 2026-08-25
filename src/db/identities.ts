import { PutCommand, DeleteCommand, GetCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';

/**
 * EmployeeIdentity uniqueness records: one row per normalized email, one row per Slack ID.
 * These are written/removed inside the same TransactWriteCommand as the Employee row so
 * uniqueness is enforced atomically (attribute_not_exists on create/rename).
 */

export type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

export function emailIdentityKey(normalizedEmail: string) {
  return { PK: `IDENTITY#EMAIL#${normalizedEmail}`, SK: 'METADATA' };
}

export function slackIdentityKey(slackId: string) {
  return { PK: `IDENTITY#SLACK#${slackId}`, SK: 'METADATA' };
}

export function putEmailIdentityItem(normalizedEmail: string, employeeId: string): TransactWriteItem {
  return {
    Put: {
      TableName: TABLE_NAME,
      Item: { ...emailIdentityKey(normalizedEmail), record_type: 'IDENTITY_EMAIL', employee_id: employeeId },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  };
}

export function putSlackIdentityItem(slackId: string, employeeId: string): TransactWriteItem {
  return {
    Put: {
      TableName: TABLE_NAME,
      Item: { ...slackIdentityKey(slackId), record_type: 'IDENTITY_SLACK', employee_id: employeeId },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  };
}

export function deleteEmailIdentityItem(normalizedEmail: string): TransactWriteItem {
  return { Delete: { TableName: TABLE_NAME, Key: emailIdentityKey(normalizedEmail) } };
}

export function deleteSlackIdentityItem(slackId: string): TransactWriteItem {
  return { Delete: { TableName: TABLE_NAME, Key: slackIdentityKey(slackId) } };
}

export async function getEmployeeIdByEmail(normalizedEmail: string): Promise<string | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: emailIdentityKey(normalizedEmail) }));
  return (r.Item?.employee_id as string | undefined) ?? null;
}

export async function getEmployeeIdBySlackId(slackId: string): Promise<string | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: slackIdentityKey(slackId) }));
  return (r.Item?.employee_id as string | undefined) ?? null;
}

/** Directly write/replace an identity pointer outside a transaction (used only for repair scripts). */
export async function forcePutEmailIdentity(normalizedEmail: string, employeeId: string): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: { ...emailIdentityKey(normalizedEmail), record_type: 'IDENTITY_EMAIL', employee_id: employeeId },
    })
  );
}

export async function forceDeleteSlackIdentity(slackId: string): Promise<void> {
  await docClient.send(new DeleteCommand({ TableName: TABLE_NAME, Key: slackIdentityKey(slackId) }));
}
