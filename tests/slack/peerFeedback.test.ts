import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildActor, buildPeerRequest } from '../fixtures/builders';

const mockMiddleware = { getActorForSlackUser: vi.fn() };
vi.mock('../../src/slack/middleware', () => mockMiddleware);

const mockEmployees = { getEmployeeById: vi.fn(), listEmployees: vi.fn() };
vi.mock('../../src/db/employees', () => mockEmployees);

const mockCycles = { getActiveCycle: vi.fn(), getCycleById: vi.fn() };
vi.mock('../../src/db/cycles', () => mockCycles);

const mockPeerFeedback = {
  createPeerRequest: vi.fn(),
  getPeerRequestByPublicId: vi.fn(),
  listPendingRequestsForPeer: vi.fn(),
  listRequestsSentByEmployee: vi.fn(),
  savePeerFeedback: vi.fn(),
  updatePeerRequestStatus: vi.fn(),
};
vi.mock('../../src/db/peerFeedback', () => mockPeerFeedback);

const mockAudit = { logAudit: vi.fn() };
vi.mock('../../src/db/audit', () => mockAudit);

const mockDocuments = { generateAndStorePeerFeedback: vi.fn() };
vi.mock('../../src/services/documents', () => mockDocuments);

const mockIdempotency = { claimSlackDelivery: vi.fn() };
vi.mock('../../src/slack/idempotency', () => mockIdempotency);

const mockDm = { sendDirectMessage: vi.fn() };
vi.mock('../../src/slack/dm', () => mockDm);

const { handlePeerAccept, handlePeerDecline, handlePeerFeedbackRequestSubmit } =
  await import('../../src/slack/peerFeedback');

function fakeClient() {
  return { views: { open: vi.fn(), update: vi.fn(), push: vi.fn(), publish: vi.fn() }, chat: { postMessage: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdempotency.claimSlackDelivery.mockResolvedValue(true);
});

describe('handlePeerAccept / handlePeerDecline — recipient-only', () => {
  it('handlePeerAccept does nothing when the actor is not the request peer_id', async () => {
    mockPeerFeedback.getPeerRequestByPublicId.mockResolvedValue(buildPeerRequest({ peer_id: 'emp-2' }));
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-99' }));
    const client = fakeClient();
    await handlePeerAccept({
      body: { user: { id: 'U-X' }, trigger_id: 't1' },
      action: { value: 'req-1' },
      client,
      ack: vi.fn(),
    } as never);
    expect(mockPeerFeedback.updatePeerRequestStatus).not.toHaveBeenCalled();
    expect(client.views.open).not.toHaveBeenCalled();
  });

  it('handlePeerAccept accepts and opens the feedback form for the actual peer', async () => {
    const request = buildPeerRequest({ id: 'req-1', peer_id: 'emp-2', status: 'pending' });
    mockPeerFeedback.getPeerRequestByPublicId.mockResolvedValue(request);
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-2' }));
    mockEmployees.getEmployeeById.mockResolvedValue(buildActor({ id: 'emp-1' }).employee);
    mockCycles.getCycleById.mockResolvedValue(null);
    const client = fakeClient();
    await handlePeerAccept({
      body: { user: { id: 'U-2' }, trigger_id: 't1' },
      action: { value: 'req-1' },
      client,
      ack: vi.fn(),
    } as never);
    expect(mockPeerFeedback.updatePeerRequestStatus).toHaveBeenCalledWith(request, 'accepted');
    expect(client.views.open).toHaveBeenCalledOnce();
  });

  it('handlePeerDecline does nothing when the actor is not the request peer_id', async () => {
    mockPeerFeedback.getPeerRequestByPublicId.mockResolvedValue(buildPeerRequest({ peer_id: 'emp-2' }));
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-99' }));
    await handlePeerDecline({ body: { user: { id: 'U-X' } }, action: { value: 'req-1' }, ack: vi.fn() } as never);
    expect(mockPeerFeedback.updatePeerRequestStatus).not.toHaveBeenCalled();
  });

  it('handlePeerDecline declines for the actual peer', async () => {
    const request = buildPeerRequest({ id: 'req-1', peer_id: 'emp-2', status: 'pending' });
    mockPeerFeedback.getPeerRequestByPublicId.mockResolvedValue(request);
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-2' }));
    await handlePeerDecline({ body: { user: { id: 'U-2' } }, action: { value: 'req-1' }, ack: vi.fn() } as never);
    expect(mockPeerFeedback.updatePeerRequestStatus).toHaveBeenCalledWith(request, 'declined');
  });
});

describe('handlePeerFeedbackRequestSubmit — idempotent request creation', () => {
  function requestSubmitArgs() {
    return {
      body: { user: { id: 'U-REQ' } },
      view: {
        private_metadata: JSON.stringify({ cycle_id: 'cycle-1', requester_id: 'emp-1' }),
        state: { values: { 'peer::peers': { peers: { selected_options: [{ value: 'emp-2' }] } } } },
      },
      client: fakeClient(),
      ack: vi.fn(),
    };
  }

  it('does not send a duplicate Slack DM when createPeerRequest reports created:false (already requested)', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockCycles.getActiveCycle.mockResolvedValue({ id: 'cycle-1' });
    mockEmployees.getEmployeeById.mockImplementation((id: string) => buildActor({ id }).employee);
    mockPeerFeedback.createPeerRequest.mockResolvedValue({
      request: buildPeerRequest({ id: 'req-1' }),
      created: false,
    });

    await handlePeerFeedbackRequestSubmit(requestSubmitArgs() as never);

    expect(mockPeerFeedback.createPeerRequest).toHaveBeenCalledOnce();
    expect(mockDm.sendDirectMessage).not.toHaveBeenCalled();
  });

  it('sends exactly one Slack DM when the request is newly created', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockCycles.getActiveCycle.mockResolvedValue({ id: 'cycle-1' });
    mockEmployees.getEmployeeById.mockImplementation((id: string) => buildActor({ id, slack_id: `U${id}` }).employee);
    mockPeerFeedback.createPeerRequest.mockResolvedValue({ request: buildPeerRequest({ id: 'req-1' }), created: true });

    await handlePeerFeedbackRequestSubmit(requestSubmitArgs() as never);

    expect(mockDm.sendDirectMessage).toHaveBeenCalledOnce();
  });

  it('a duplicate delivery of the request-submit view is a no-op', async () => {
    mockIdempotency.claimSlackDelivery.mockResolvedValue(false);
    await handlePeerFeedbackRequestSubmit(requestSubmitArgs() as never);
    expect(mockPeerFeedback.createPeerRequest).not.toHaveBeenCalled();
  });
});
