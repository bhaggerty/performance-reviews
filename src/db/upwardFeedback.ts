import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { UpwardFeedback } from '../types';
import { randomUUID } from 'crypto';

const CYCLE_PREFIX = 'CYCLE#';
const UPWARD_SK_PREFIX = 'UPWARD#';
const EMP_PREFIX = 'EMP#';

function toItem(f: UpwardFeedback) {
  return {
    PK: `${CYCLE_PREFIX}${f.cycle_id}`,
    SK: `${UPWARD_SK_PREFIX}${f.employee_id}`,
    GSI2PK: `${EMP_PREFIX}${f.employee_id}`,
    GSI2SK: `UPWARD#${f.id}`,
    type: 'UPWARD_FEEDBACK',
    ...f,
  };
}

function fromItem(item: Record<string, unknown>): UpwardFeedback {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    manager_id: item.manager_id as string,
    strengths: item.strengths as string | undefined,
    improvements: item.improvements as string | undefined,
    hr_notes: item.hr_notes as string | undefined,
    allow_hr_followup: item.allow_hr_followup as boolean,
    submitted_at: item.submitted_at as string,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function saveUpwardFeedback(
  cycleId: string,
  employeeId: string,
  managerId: string,
  data: {
    strengths?: string;
    improvements?: string;
    hr_notes?: string;
    allow_hr_followup: boolean;
  }
): Promise<UpwardFeedback> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const feedback: UpwardFeedback = {
    id,
    cycle_id: cycleId,
    employee_id: employeeId,
    manager_id: managerId,
    strengths: data.strengths,
    improvements: data.improvements,
    hr_notes: data.hr_notes,
    allow_hr_followup: data.allow_hr_followup,
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(feedback),
    })
  );
  return feedback;
}

export async function getUpwardFeedbackForEmployee(cycleId: string, employeeId: string): Promise<UpwardFeedback | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${CYCLE_PREFIX}${cycleId}`,
        SK: `${UPWARD_SK_PREFIX}${employeeId}`,
      },
    })
  );
  if (!r.Item) return null;
  return fromItem(r.Item as Record<string, unknown>);
}

export async function getUpwardFeedbackByManager(cycleId: string, managerId: string): Promise<UpwardFeedback[]> {
  const r = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `${CYCLE_PREFIX}${cycleId}`,
        ':sk': UPWARD_SK_PREFIX,
      },
    })
  );
  const all = (r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  return all.filter((f) => f.manager_id === managerId);
}
