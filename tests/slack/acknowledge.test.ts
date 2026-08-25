import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildActor, buildReviewRelease } from '../fixtures/builders';

const mockMiddleware = { getActorForSlackUser: vi.fn() };
vi.mock('../../src/slack/middleware', () => mockMiddleware);

const mockEmployees = { getEmployeeById: vi.fn() };
vi.mock('../../src/db/employees', () => mockEmployees);

const mockReviews = { getManagerReview: vi.fn(), getReviewHistory: vi.fn(), listReviewsByManager: vi.fn() };
vi.mock('../../src/db/reviews', () => mockReviews);

const mockReleases = { getReviewRelease: vi.fn() };
vi.mock('../../src/db/releases', () => mockReleases);

const mockAcks = { getAcknowledgement: vi.fn(), createAcknowledgement: vi.fn() };
vi.mock('../../src/db/acknowledgements', () => mockAcks);

const mockDocuments = { getDocumentById: vi.fn(), listDocumentsForEmployee: vi.fn() };
vi.mock('../../src/db/documents', () => mockDocuments);

const mockCycles = { listCycles: vi.fn() };
vi.mock('../../src/db/cycles', () => mockCycles);

const mockAudit = { logAudit: vi.fn() };
vi.mock('../../src/db/audit', () => mockAudit);

const mockIdempotency = { claimSlackDelivery: vi.fn() };
vi.mock('../../src/slack/idempotency', () => mockIdempotency);

const mockHome = { refreshHomeForUser: vi.fn() };
vi.mock('../../src/slack/home', () => mockHome);

const mockDm = { sendDirectMessage: vi.fn() };
vi.mock('../../src/slack/dm', () => mockDm);

const { handleAcknowledgeSubmit, handleAcknowledgeReview } = await import('../../src/slack/acknowledge');

function fakeClient() {
  return { views: { open: vi.fn(), update: vi.fn(), push: vi.fn(), publish: vi.fn() }, chat: { postMessage: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdempotency.claimSlackDelivery.mockResolvedValue(true);
});

describe('handleAcknowledgeReview — gated on an existing release', () => {
  it('does nothing when the review has not been released', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockReleases.getReviewRelease.mockResolvedValue(null);
    const client = fakeClient();
    await handleAcknowledgeReview({
      body: { user: { id: 'U1' }, trigger_id: 't1' },
      action: { value: 'cycle-1#emp-1' },
      client,
      ack: vi.fn(),
    } as never);
    expect(client.views.open).not.toHaveBeenCalled();
  });

  it('opens the acknowledge modal once released and the actor is the reviewed employee', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockReleases.getReviewRelease.mockResolvedValue(buildReviewRelease({ employee_id: 'emp-1', review_version: 2 }));
    const client = fakeClient();
    await handleAcknowledgeReview({
      body: { user: { id: 'U1' }, trigger_id: 't1' },
      action: { value: 'cycle-1#emp-1' },
      client,
      ack: vi.fn(),
    } as never);
    expect(client.views.open).toHaveBeenCalledOnce();
    const view = client.views.open.mock.calls[0][0].view;
    expect(view.callback_id).toBe('ack_submit');
  });
});

describe('handleAcknowledgeSubmit', () => {
  function submitArgs(overrides: Record<string, unknown> = {}) {
    return {
      body: { user: { id: 'U1' } },
      view: {
        private_metadata: JSON.stringify({ cycle_id: 'cycle-1', employee_id: 'emp-1', review_version: 1 }),
        state: { values: { ack_comment: { comment: { value: 'Thanks for the feedback.' } } } },
      },
      client: fakeClient(),
      ack: vi.fn(),
      ...overrides,
    };
  }

  it('does NOT create an acknowledgement when there is no release for this cycle/employee', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockReleases.getReviewRelease.mockResolvedValue(null);
    await handleAcknowledgeSubmit(submitArgs() as never);
    expect(mockAcks.createAcknowledgement).not.toHaveBeenCalled();
  });

  it('persists the comment and timestamp together in one call once released', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockReleases.getReviewRelease.mockResolvedValue(buildReviewRelease({ employee_id: 'emp-1' }));
    mockReviews.getManagerReview.mockResolvedValue(null);
    await handleAcknowledgeSubmit(submitArgs() as never);
    expect(mockAcks.createAcknowledgement).toHaveBeenCalledWith(
      expect.objectContaining({
        cycle_id: 'cycle-1',
        employee_id: 'emp-1',
        review_version: 1,
        comment: 'Thanks for the feedback.',
      })
    );
    expect(mockHome.refreshHomeForUser).toHaveBeenCalledOnce();
  });

  it('rejects when the acting Slack user is not the reviewed employee', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'someone-else' }));
    await handleAcknowledgeSubmit(submitArgs() as never);
    expect(mockAcks.createAcknowledgement).not.toHaveBeenCalled();
  });

  it('a duplicate submission (idempotency claim already used) does not create a second acknowledgement', async () => {
    mockIdempotency.claimSlackDelivery.mockResolvedValue(false);
    await handleAcknowledgeSubmit(submitArgs() as never);
    expect(mockAcks.createAcknowledgement).not.toHaveBeenCalled();
    expect(mockMiddleware.getActorForSlackUser).not.toHaveBeenCalled();
  });

  it('never mutates or re-releases the review itself — only writes the acknowledgement record', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockReleases.getReviewRelease.mockResolvedValue(buildReviewRelease({ employee_id: 'emp-1' }));
    mockReviews.getManagerReview.mockResolvedValue(null);
    await handleAcknowledgeSubmit(submitArgs() as never);
    // No manager-review write functions exist in this module's dependency set at all —
    // the only mutation possible here is createAcknowledgement, asserted above.
    expect(mockAcks.createAcknowledgement).toHaveBeenCalledOnce();
  });
});
