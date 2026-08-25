import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, queryAll, isConditionalCheckFailed } from './client';
import type { PeerFeedback, PeerRequest, PeerRequestStatus } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const CYCLE_PREFIX = 'CYCLE#';
const REQUEST_SK_PREFIX = 'PEERREQUEST#';
const FEEDBACK_SK_PREFIX = 'PEERFEEDBACK#';

/** Deterministic ID: one request per (cycle, requester, peer), which is also what makes
 * request creation naturally idempotent (a resend collapses onto the same row). */
export function peerRequestId(cycleId: string, requesterId: string, peerId: string): string {
  return `${cycleId}:${requesterId}:${peerId}`;
}

function requestKey(cycleId: string, requesterId: string, peerId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${REQUEST_SK_PREFIX}${requesterId}#${peerId}` };
}

const RESUMABLE_STATUSES: PeerRequestStatus[] = ['pending', 'accepted'];

function requestToItem(r: PeerRequest) {
  const item: Record<string, unknown> = {
    ...requestKey(r.cycle_id, r.requester_id, r.peer_id),
    GSI2PK: `PEER_REQUESTER#${r.requester_id}`,
    GSI2SK: `${r.requested_at}#${r.id}`,
    type: 'PEER_REQUEST',
    ...r,
  };
  if (RESUMABLE_STATUSES.includes(r.status)) {
    item.GSI1PK = `PEER_RECIPIENT#${r.peer_id}`;
    item.GSI1SK = `${r.requested_at}#${r.id}`;
  }
  return item;
}

function requestFromItem(item: Record<string, unknown>): PeerRequest {
  return {
    id: item.id as string,
    cycle_id: item.cycle_id as string,
    requester_id: item.requester_id as string,
    peer_id: item.peer_id as string,
    status: item.status as PeerRequestStatus,
    focus_area: item.focus_area as string | undefined,
    requested_at: item.requested_at as string,
    responded_at: item.responded_at as string | undefined,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

export async function getPeerRequestById(
  cycleId: string,
  requesterId: string,
  peerId: string
): Promise<PeerRequest | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: requestKey(cycleId, requesterId, peerId) })
  );
  return r.Item ? requestFromItem(r.Item as Record<string, unknown>) : null;
}

/** Requests are looked up by their public id via a scoped query since Slack only carries the id. */
export async function getPeerRequestByPublicId(id: string): Promise<PeerRequest | null> {
  const [cycleId, requesterId, peerId] = id.split(':');
  if (!cycleId || !requesterId || !peerId) return null;
  return getPeerRequestById(cycleId, requesterId, peerId);
}

export async function listPendingRequestsForPeer(peerId: string): Promise<PeerRequest[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `PEER_RECIPIENT#${peerId}` },
  });
  return items.map((i) => requestFromItem(i));
}

export async function listRequestsSentByEmployee(requesterId: string): Promise<PeerRequest[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `PEER_REQUESTER#${requesterId}` },
  });
  return items.map((i) => requestFromItem(i));
}

export async function listPeerRequestsForCycle(cycleId: string): Promise<PeerRequest[]> {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${CYCLE_PREFIX}${cycleId}`, ':sk': REQUEST_SK_PREFIX },
  });
  return items.map((i) => requestFromItem(i));
}

/** Idempotent by construction: re-requesting the same peer returns the existing row untouched. */
export async function createPeerRequest(
  cycleId: string,
  requesterId: string,
  peerId: string,
  focusArea: string | undefined,
  clock: Clock = systemClock
): Promise<{ request: PeerRequest; created: boolean }> {
  const existing = await getPeerRequestById(cycleId, requesterId, peerId);
  if (existing) return { request: existing, created: false };

  const now = isoNow(clock);
  const request: PeerRequest = {
    id: peerRequestId(cycleId, requesterId, peerId),
    cycle_id: cycleId,
    requester_id: requesterId,
    peer_id: peerId,
    status: 'pending',
    focus_area: focusArea,
    requested_at: now,
    created_at: now,
    updated_at: now,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: requestToItem(request),
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const raced = await getPeerRequestById(cycleId, requesterId, peerId);
      if (raced) return { request: raced, created: false };
    }
    throw error;
  }
  return { request, created: true };
}

export async function updatePeerRequestStatus(
  request: PeerRequest,
  status: PeerRequestStatus,
  clock: Clock = systemClock
): Promise<PeerRequest> {
  const now = isoNow(clock);
  const updated: PeerRequest = { ...request, status, responded_at: now, updated_at: now };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: requestToItem(updated) }));
  return updated;
}

// ---------------------------------------------------------------------------
// Peer feedback (final submission)
// ---------------------------------------------------------------------------

function feedbackKey(cycleId: string, employeeId: string, peerId: string) {
  return { PK: `${CYCLE_PREFIX}${cycleId}`, SK: `${FEEDBACK_SK_PREFIX}${employeeId}#${peerId}` };
}

function feedbackToItem(f: PeerFeedback) {
  return {
    ...feedbackKey(f.cycle_id, f.employee_id, f.peer_id),
    GSI2PK: `EMP_PEER_RECEIVED#${f.employee_id}`,
    GSI2SK: `${CYCLE_PREFIX}${f.cycle_id}#${f.id}`,
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
    follow_up_notes: item.follow_up_notes as string | undefined,
    redacted_for_employee: Boolean(item.redacted_for_employee),
    redaction_note: item.redaction_note as string | undefined,
    submitted_at: item.submitted_at as string,
    created_at: item.created_at as string,
    updated_at: item.updated_at as string,
  };
}

/** Conditional create: a second final submission for the same (employee, peer, cycle) is rejected, not overwritten. */
export async function savePeerFeedback(
  cycleId: string,
  employeeId: string,
  peerId: string,
  requestId: string,
  data: { strengths?: string; growth_areas?: string; example?: string; follow_up_notes?: string },
  clock: Clock = systemClock
): Promise<PeerFeedback> {
  const now = isoNow(clock);
  const feedback: PeerFeedback = {
    id: `${cycleId}:${employeeId}:${peerId}`,
    cycle_id: cycleId,
    employee_id: employeeId,
    peer_id: peerId,
    request_id: requestId,
    ...data,
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: feedbackToItem(feedback),
        ConditionExpression: 'attribute_not_exists(PK)',
      })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      throw new Error('Peer feedback for this employee has already been submitted.');
    }
    throw error;
  }
  return feedback;
}

export async function getPeerFeedbackForEmployee(cycleId: string, employeeId: string): Promise<PeerFeedback[]> {
  const items = await queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `${CYCLE_PREFIX}${cycleId}`, ':sk': `${FEEDBACK_SK_PREFIX}${employeeId}#` },
  });
  return items.map((i) => feedbackFromItem(i));
}

export async function setPeerFeedbackRedaction(
  cycleId: string,
  employeeId: string,
  peerId: string,
  redactionNote: string,
  clock: Clock = systemClock
): Promise<PeerFeedback | null> {
  const r = await docClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: feedbackKey(cycleId, employeeId, peerId) })
  );
  if (!r.Item) return null;
  const existing = feedbackFromItem(r.Item as Record<string, unknown>);
  const updated: PeerFeedback = {
    ...existing,
    redacted_for_employee: true,
    redaction_note: redactionNote,
    updated_at: isoNow(clock),
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: feedbackToItem(updated) }));
  return updated;
}
