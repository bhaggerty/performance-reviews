import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { PeerRequest, PeerFeedback } from '../types';
import { randomUUID } from 'crypto';

const REQ_PREFIX = 'REQ#';
const CYCLE_PREFIX = 'CYCLE#';
const PEER_SK_PREFIX = 'PEER#';
const EMP_PREFIX = 'EMP#';

// PeerRequest: stored as REQ#<id> / METADATA, GSI2 = CYCLE#<id> / REQ#<id>
function requestToItem(r: PeerRequest) {
  return {
    PK: `${REQ_PREFIX}${r.id}`,
    SK: 'METADATA',
    GSI2PK: `${CYCLE_PREFIX}${r.cycle_id}`,
    GSI2SK: `REQ#${r.id}`,
    type: 'PEER_REQUEST',
    ...r,
  };
}

function requestFromItem(item: Record<string, unknown>): PeerRequest {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    requester_id: item.requester_id as string,
    peer_id: item.peer_id as string,
    status: item.status as PeerRequest['status'],
    focus_area: item.focus_area as string | undefined,
    requested_at: item.requested_at as string,
    responded_at: item.responded_at as string | undefined,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function createPeerRequest(
  cycleId: string,
  requesterId: string,
  peerId: string,
  focusArea?: string
): Promise<PeerRequest> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const req: PeerRequest = {
    id,
    cycle_id: cycleId,
    requester_id: requesterId,
    peer_id: peerId,
    status: 'pending',
    focus_area: focusArea,
    requested_at: now,
    created_at: now,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: requestToItem(req),
    })
  );
  return req;
}

export async function getPeerRequest(id: string): Promise<PeerRequest | null> {
  const r = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `${REQ_PREFIX}${id}`, SK: 'METADATA' },
    })
  );
  if (!r.Item) return null;
  return requestFromItem(r.Item as Record<string, unknown>);
}

export async function updatePeerRequestStatus(
  id: string,
  status: 'accepted' | 'declined'
): Promise<PeerRequest | null> {
  const existing = await getPeerRequest(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const updated: PeerRequest = { ...existing, status, responded_at: now, updated_at: now };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: requestToItem(updated),
    })
  );
  return updated;
}

// PeerFeedback: CYCLE#<id> / PEER#<employee_id>#<peer_id>
function feedbackToItem(f: PeerFeedback) {
  return {
    PK: `${CYCLE_PREFIX}${f.cycle_id}`,
    SK: `${PEER_SK_PREFIX}${f.employee_id}#${f.peer_id}`,
    GSI2PK: `${EMP_PREFIX}${f.employee_id}`,
    GSI2SK: `PEER#${f.id}`,
    type: 'PEER_FEEDBACK',
    ...f,
  };
}

function feedbackFromItem(item: Record<string, unknown>): PeerFeedback {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    employee_id: item.employee_id as string,
    peer_id: item.peer_id as string,
    request_id: item.request_id as string,
    strengths: item.strengths as string | undefined,
    growth_areas: item.growth_areas as string | undefined,
    example: item.example as string | undefined,
    submitted_at: item.submitted_at as string,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function savePeerFeedback(
  cycleId: string,
  employeeId: string,
  peerId: string,
  requestId: string,
  data: { strengths?: string; growth_areas?: string; example?: string }
): Promise<PeerFeedback> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const feedback: PeerFeedback = {
    id,
    cycle_id: cycleId,
    employee_id: employeeId,
    peer_id: peerId,
    request_id: requestId,
    strengths: data.strengths,
    growth_areas: data.growth_areas,
    example: data.example,
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: feedbackToItem(feedback),
    })
  );
  return feedback;
}

export async function getPeerFeedbackForEmployee(cycleId: string, employeeId: string): Promise<PeerFeedback[]> {
  const r = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `${CYCLE_PREFIX}${cycleId}`,
        ':sk': `${PEER_SK_PREFIX}${employeeId}#`,
      },
    })
  );
  return (r.Items ?? []).map((i) => feedbackFromItem(i as Record<string, unknown>));
}
