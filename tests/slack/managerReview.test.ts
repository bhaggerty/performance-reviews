import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildActor, buildCycle, buildEmployee, buildManagerReview } from '../fixtures/builders';

const mockMiddleware = { getActorForSlackUser: vi.fn() };
vi.mock('../../src/slack/middleware', () => mockMiddleware);

const mockEmployees = { getDirectReports: vi.fn(), getEmployeeById: vi.fn() };
vi.mock('../../src/db/employees', () => mockEmployees);

const mockCycles = { getActiveCycle: vi.fn() };
vi.mock('../../src/db/cycles', () => mockCycles);

const mockReviews = { getManagerReview: vi.fn(), saveManagerReviewDraft: vi.fn(), submitManagerReview: vi.fn() };
vi.mock('../../src/db/reviews', () => mockReviews);

const mockAudit = { logAudit: vi.fn() };
vi.mock('../../src/db/audit', () => mockAudit);

const mockAuthz = { requireCurrentManagerRelationship: vi.fn() };
vi.mock('../../src/domain/authz', () => mockAuthz);

const mockIdempotency = { claimSlackDelivery: vi.fn() };
vi.mock('../../src/slack/idempotency', () => mockIdempotency);

const mockReviewCoach = { reviewCoach: { reviewDraft: vi.fn(), draftUpwardSummary: vi.fn() } };
vi.mock('../../src/services/reviewCoach', () => mockReviewCoach);

const { handleReviewStatusChoice, handleManagerReviewSubmit, handleAiCoachRequest } =
  await import('../../src/slack/managerReview');

function fakeClient() {
  return { views: { open: vi.fn(), update: vi.fn(), push: vi.fn(), publish: vi.fn() }, chat: { postMessage: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdempotency.claimSlackDelivery.mockResolvedValue(true);
});

describe('handleReviewStatusChoice', () => {
  function statusBody() {
    return {
      body: {
        user: { id: 'U-MGR' },
        trigger_id: 't1',
        view: {
          id: 'view-1',
          private_metadata: JSON.stringify({ cycle_id: 'cycle-1', cycle_name: '2026-H1' }),
          state: { values: { 'review::employee': { employee_select: { selected_option: { value: 'emp-1' } } } } },
        },
      },
      action: { value: 'on_track' },
      client: fakeClient(),
      ack: vi.fn(),
    };
  }

  it('rejects (shows "not allowed") when requireCurrentManagerRelationship throws — actor is not the current manager', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockRejectedValue(new Error('not_current_manager'));
    const args = statusBody();
    await handleReviewStatusChoice(args as never);
    expect(args.client.views.update).toHaveBeenCalledOnce();
    const view = args.client.views.update.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/not currently one of your direct reports/);
    expect(args.client.views.push).not.toHaveBeenCalled();
  });

  it('pushes the review form when the manager relationship is current and no existing review blocks editing', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', name: 'Report One' }));
    mockReviews.getManagerReview.mockResolvedValue(null);
    const args = statusBody();
    await handleReviewStatusChoice(args as never);
    expect(args.client.views.push).toHaveBeenCalledOnce();
    const view = args.client.views.push.mock.calls[0][0].view;
    expect(view.callback_id).toBe('manager_review_submit');
  });

  it('blocks re-editing an already-submitted review', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', name: 'Report One' }));
    mockReviews.getManagerReview.mockResolvedValue(buildManagerReview({ people_state: 'submitted' }));
    const args = statusBody();
    await handleReviewStatusChoice(args as never);
    const view = args.client.views.push.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/already been submitted/);
  });
});

function submitArgs(overrides: Record<string, unknown> = {}) {
  return {
    view: {
      private_metadata: JSON.stringify({ cycle_id: 'cycle-1', employee_id: 'emp-1', status: 'on_track' }),
      state: {
        values: {
          'review::strengths': { strengths: { value: 'Great work all cycle.' } },
          'review::mode': { mode: { selected_option: { value: 'draft' } } },
        },
      },
    },
    body: { user: { id: 'U-MGR' } },
    ack: vi.fn(),
    client: fakeClient(),
    ...overrides,
  };
}

describe('handleManagerReviewSubmit', () => {
  it('re-validates the manager relationship and cycle phase before saving; rejects with a modal error when invalid', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockRejectedValue(new Error('not_current_manager'));
    const args = submitArgs();
    await handleManagerReviewSubmit(args as never);
    expect(args.ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' }));
    expect(mockReviews.saveManagerReviewDraft).not.toHaveBeenCalled();
    expect(mockReviews.submitManagerReview).not.toHaveBeenCalled();
  });

  it('rejects when the cycle is no longer in the manager_reviews phase', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', manager_id: 'mgr-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    const args = submitArgs();
    await handleManagerReviewSubmit(args as never);
    expect(args.ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' }));
    expect(mockReviews.saveManagerReviewDraft).not.toHaveBeenCalled();
  });

  it('saves a draft when validation passes and mode is draft', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', manager_id: 'mgr-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'manager_reviews' }));
    const args = submitArgs();
    await handleManagerReviewSubmit(args as never);
    expect(mockReviews.saveManagerReviewDraft).toHaveBeenCalledOnce();
    expect(mockReviews.submitManagerReview).not.toHaveBeenCalled();
  });

  it('submits final when mode is submit', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', manager_id: 'mgr-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'manager_reviews' }));
    const args = submitArgs({
      view: {
        private_metadata: JSON.stringify({ cycle_id: 'cycle-1', employee_id: 'emp-1', status: 'on_track' }),
        state: {
          values: {
            'review::strengths': { strengths: { value: 'Great work all cycle.' } },
            'review::focus_areas': { focus_areas: { value: 'Keep scaling the platform.' } },
            'review::mode': { mode: { selected_option: { value: 'submit' } } },
          },
        },
      },
    });
    await handleManagerReviewSubmit(args as never);
    expect(mockReviews.submitManagerReview).toHaveBeenCalledOnce();
    expect(mockAudit.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'submit' }));
  });

  it('rejects a final submit with a required field missing for the selected status (on_track needs focus_areas too)', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', manager_id: 'mgr-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'manager_reviews' }));
    const args = submitArgs({
      view: {
        private_metadata: JSON.stringify({ cycle_id: 'cycle-1', employee_id: 'emp-1', status: 'on_track' }),
        state: {
          values: {
            'review::strengths': { strengths: { value: 'Great work all cycle.' } },
            'review::mode': { mode: { selected_option: { value: 'submit' } } },
          },
        },
      },
    });
    await handleManagerReviewSubmit(args as never);
    expect(args.ack).toHaveBeenCalledWith(expect.objectContaining({ response_action: 'errors' }));
    expect(mockReviews.submitManagerReview).not.toHaveBeenCalled();
  });

  it('duplicate delivery (idempotency claim already used) is a no-op — nothing is saved', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'mgr-1' }));
    mockAuthz.requireCurrentManagerRelationship.mockResolvedValue(buildEmployee({ id: 'emp-1', manager_id: 'mgr-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'manager_reviews' }));
    mockIdempotency.claimSlackDelivery.mockResolvedValue(false);
    const args = submitArgs();
    await handleManagerReviewSubmit(args as never);
    expect(mockReviews.saveManagerReviewDraft).not.toHaveBeenCalled();
    expect(mockReviews.submitManagerReview).not.toHaveBeenCalled();
  });
});

describe('handleAiCoachRequest', () => {
  it('acks the button click, then calls the AI coach and updates the view with suggestions (never blocks ack)', async () => {
    mockEmployees.getEmployeeById.mockResolvedValue(buildEmployee({ id: 'emp-1', name: 'Report One' }));
    mockReviewCoach.reviewCoach.reviewDraft.mockResolvedValue({
      needsFollowup: true,
      questions: ['Can you give a concrete example?'],
    });
    const ack = vi.fn();
    const client = fakeClient();
    const args = {
      body: {
        view: {
          id: 'view-1',
          hash: 'hash-1',
          private_metadata: JSON.stringify({
            cycle_id: 'cycle-1',
            cycle_name: '2026-H1',
            employee_id: 'emp-1',
            status: 'on_track',
          }),
          state: { values: { 'review::strengths': { strengths: { value: 'ok' } } } },
        },
      },
      ack,
      client,
    };
    await handleAiCoachRequest(args as never);
    expect(ack).toHaveBeenCalled();
    expect(mockReviewCoach.reviewCoach.reviewDraft).toHaveBeenCalledOnce();
    expect(client.views.update).toHaveBeenCalledOnce();
    const view = client.views.update.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/Can you give a concrete example/);
  });
});
