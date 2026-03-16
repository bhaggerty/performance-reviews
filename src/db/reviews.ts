import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { ManagerReview, ReviewStatus } from '../types';
import { randomUUID } from 'crypto';

const CYCLE_PREFIX = 'CYCLE#';
const REVIEW_SK_PREFIX = 'REVIEW#';
const EMP_PREFIX = 'EMP#';

function toItem(r: ManagerReview) {
  const item: Record<string, unknown> = {
    PK: `${CYCLE_PREFIX}${r.cycle_id}`,
    SK: `${REVIEW_SK_PREFIX}${r.employee_id}`,
    GSI2PK: `${EMP_PREFIX}${r.employee_id}`,
    GSI2SK: `${CYCLE_PREFIX}${r.cycle_id}`,
    type: 'MANAGER_REVIEW',
    id: r.id,
    cycle_id: r.cycle_id,
    employee_id: r.employee_id,
    manager_id: r.manager_id,
    status: r.status,
    submitted_at: r.submitted_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
  if (r.strengths != null) item.strengths = r.strengths;
  if (r.focus_areas != null) item.focus_areas = r.focus_areas;
  if (r.examples != null) item.examples = r.examples;
  if (r.development_areas != null) item.development_areas = r.development_areas;
  if (r.next_cycle_expectations != null) item.next_cycle_expectations = r.next_cycle_expectations;
  if (r.manager_support != null) item.manager_support = r.manager_support;
  if (r.primary_concerns != null) item.primary_concerns = r.primary_concerns;
  if (r.communicated_previously != null) item.communicated_previously = r.communicated_previously;
  if (r.required_improvement != null) item.required_improvement = r.required_improvement;
  if (r.improvement_timeline != null) item.improvement_timeline = r.improvement_timeline;
  if (r.hr_review_required != null) item.hr_review_required = r.hr_review_required;
  if (r.follow_up_notes != null) item.follow_up_notes = r.follow_up_notes;
  if (r.acknowledged_at != null) item.acknowledged_at = r.acknowledged_at;
  if (r.acknowledgment_comment != null) item.acknowledgment_comment = r.acknowledgment_comment;
  return item;
}

function fromItem(item: Record<string, unknown>): ManagerReview {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    manager_id: item.manager_id as string,
    status: item.status as ReviewStatus,
    strengths: item.strengths as string | undefined,
    focus_areas: item.focus_areas as string | undefined,
    examples: item.examples as string | undefined,
    development_areas: item.development_areas as string | undefined,
    next_cycle_expectations: item.next_cycle_expectations as string | undefined,
    manager_support: item.manager_support as string | undefined,
    primary_concerns: item.primary_concerns as string | undefined,
    communicated_previously: item.communicated_previously as boolean | undefined,
    required_improvement: item.required_improvement as string | undefined,
    improvement_timeline: item.improvement_timeline as string | undefined,
    hr_review_required: item.hr_review_required as boolean | undefined,
    follow_up_notes: item.follow_up_notes as string | undefined,
    submitted_at: item.submitted_at as string,
    acknowledged_at: item.acknowledged_at as string | undefined,
    acknowledgment_comment: item.acknowledgment_comment as string | undefined,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

function isMissingIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('The table does not have the specified index');
}

export async function getManagerReview(cycleId: string, employeeId: string): Promise<ManagerReview | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `${CYCLE_PREFIX}${cycleId}`,
        SK: `${REVIEW_SK_PREFIX}${employeeId}`,
      },
    })
  );
  if (!r.Item) return null;
  return fromItem(r.Item as Record<string, unknown>);
}

export async function getReviewsByCycle(cycleId: string): Promise<ManagerReview[]> {
  const r = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `${CYCLE_PREFIX}${cycleId}`,
        ':sk': REVIEW_SK_PREFIX,
      },
    })
  );
  return (r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
}

export async function getReviewsByEmployee(employeeId: string): Promise<ManagerReview[]> {
  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: { ':pk': `${EMP_PREFIX}${employeeId}` },
      })
    );
    return (r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;

    const fallback = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: '#type = :type AND employee_id = :employeeId',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: {
          ':type': 'MANAGER_REVIEW',
          ':employeeId': employeeId,
        },
      })
    );
    return (fallback.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  }
}

export async function getReviewsAuthoredByManager(managerId: string): Promise<ManagerReview[]> {
  const r = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: '#type = :type AND manager_id = :managerId',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: {
        ':type': 'MANAGER_REVIEW',
        ':managerId': managerId,
      },
    })
  );
  return (r.Items ?? [])
    .map((i) => fromItem(i as Record<string, unknown>))
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
}

export async function saveManagerReview(
  cycleId: string,
  employeeId: string,
  managerId: string,
  data: {
    status: ReviewStatus;
    strengths?: string;
    focus_areas?: string;
    examples?: string;
    development_areas?: string;
    next_cycle_expectations?: string;
    manager_support?: string;
    primary_concerns?: string;
    communicated_previously?: boolean;
    required_improvement?: string;
    improvement_timeline?: string;
    hr_review_required?: boolean;
    follow_up_notes?: string;
  }
): Promise<ManagerReview> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const review: ManagerReview = {
    id,
    cycle_id: cycleId,
    employee_id: employeeId,
    manager_id: managerId,
    status: data.status,
    strengths: data.strengths,
    focus_areas: data.focus_areas,
    examples: data.examples,
    development_areas: data.development_areas,
    next_cycle_expectations: data.next_cycle_expectations,
    manager_support: data.manager_support,
    primary_concerns: data.primary_concerns,
    communicated_previously: data.communicated_previously,
    required_improvement: data.required_improvement,
    improvement_timeline: data.improvement_timeline,
    hr_review_required: data.hr_review_required,
    follow_up_notes: data.follow_up_notes,
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(review),
    })
  );
  return review;
}

export async function acknowledgeReview(
  cycleId: string,
  employeeId: string,
  comment?: string
): Promise<ManagerReview | null> {
  const existing = await getManagerReview(cycleId, employeeId);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: ManagerReview = {
    ...existing,
    acknowledged_at: now,
    acknowledgment_comment: comment,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(updated),
    })
  );
  return updated;
}
