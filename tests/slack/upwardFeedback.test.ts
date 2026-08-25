import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildActor, buildCycle, buildEmployee } from '../fixtures/builders';

const mockMiddleware = { getActorForSlackUser: vi.fn() };
vi.mock('../../src/slack/middleware', () => mockMiddleware);

const mockEmployees = { getEmployeeById: vi.fn() };
vi.mock('../../src/db/employees', () => mockEmployees);

const mockCycles = { getActiveCycle: vi.fn(), getCycleById: vi.fn() };
vi.mock('../../src/db/cycles', () => mockCycles);

const mockUpwardFeedback = { getUpwardFeedbackForEmployee: vi.fn(), saveUpwardFeedback: vi.fn() };
vi.mock('../../src/db/upwardFeedback', () => mockUpwardFeedback);

const mockAudit = { logAudit: vi.fn() };
vi.mock('../../src/db/audit', () => mockAudit);

const mockDocuments = { generateAndStoreUpwardFeedback: vi.fn() };
vi.mock('../../src/services/documents', () => mockDocuments);

const mockIdempotency = { claimSlackDelivery: vi.fn() };
vi.mock('../../src/slack/idempotency', () => mockIdempotency);

const { openUpwardFeedbackModal, handleUpwardFeedbackSubmit } = await import('../../src/slack/upwardFeedback');

function fakeClient() {
  return { views: { open: vi.fn(), update: vi.fn(), push: vi.fn(), publish: vi.fn() }, chat: { postMessage: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdempotency.claimSlackDelivery.mockResolvedValue(true);
});

describe('openUpwardFeedbackModal — manager re-resolved fresh from the live record', () => {
  it("uses the actor employee record's CURRENT manager_id, ignoring any stale value", async () => {
    // The actor's manager was reassigned since any prior modal render; the handler must look
    // up the manager fresh via getEmployeeById(actor.employee.manager_id), not trust a cache.
    const actor = buildActor({ id: 'emp-1', manager_id: 'mgr-new' });
    mockMiddleware.getActorForSlackUser.mockResolvedValue(actor);
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    mockUpwardFeedback.getUpwardFeedbackForEmployee.mockResolvedValue(null);
    mockEmployees.getEmployeeById.mockResolvedValue(buildEmployee({ id: 'mgr-new', name: 'New Manager' }));

    const client = fakeClient();
    await openUpwardFeedbackModal({ body: { user: { id: 'U1' }, trigger_id: 't1' }, client, ack: vi.fn() } as never);

    expect(mockEmployees.getEmployeeById).toHaveBeenCalledWith('mgr-new');
    const view = client.views.open.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/New Manager/);
  });

  it('shows a fallback when the employee has no manager set', async () => {
    const actor = buildActor({ id: 'emp-1', manager_id: null });
    mockMiddleware.getActorForSlackUser.mockResolvedValue(actor);
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ status: 'collecting_feedback' }));
    const client = fakeClient();
    await openUpwardFeedbackModal({ body: { user: { id: 'U1' }, trigger_id: 't1' }, client, ack: vi.fn() } as never);
    expect(mockEmployees.getEmployeeById).not.toHaveBeenCalled();
    const view = client.views.open.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/no manager set/);
  });

  it('blocks a second submission when upward feedback was already submitted this cycle', async () => {
    const actor = buildActor({ id: 'emp-1', manager_id: 'mgr-1' });
    mockMiddleware.getActorForSlackUser.mockResolvedValue(actor);
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    mockEmployees.getEmployeeById.mockResolvedValue(buildEmployee({ id: 'mgr-1' }));
    mockUpwardFeedback.getUpwardFeedbackForEmployee.mockResolvedValue({ id: 'existing' });
    const client = fakeClient();
    await openUpwardFeedbackModal({ body: { user: { id: 'U1' }, trigger_id: 't1' }, client, ack: vi.fn() } as never);
    const view = client.views.open.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/already submitted/);
  });
});

describe('handleUpwardFeedbackSubmit — manager re-resolved fresh at submit time too', () => {
  function submitArgs(overrides: Record<string, unknown> = {}) {
    return {
      body: { user: { id: 'U1' } },
      view: {
        private_metadata: JSON.stringify({ cycle_id: 'cycle-1', cycle_name: '2026-H1', employee_id: 'emp-1' }),
        state: {
          values: {
            'upward::strengths': { strengths: { value: 'Clear and direct.' } },
            'upward::improvements': { improvements: { value: 'More 1:1 time.' } },
            'upward::followup': { allow_hr_followup: { selected_option: { value: 'yes' } } },
          },
        },
      },
      client: fakeClient(),
      ack: vi.fn(),
      ...overrides,
    };
  }

  it("uses the actor's current manager_id at submit time, not whatever the stale modal metadata implies", async () => {
    const actor = buildActor({ id: 'emp-1', manager_id: 'mgr-current' });
    mockMiddleware.getActorForSlackUser.mockResolvedValue(actor);
    mockEmployees.getEmployeeById.mockResolvedValue(buildEmployee({ id: 'mgr-current' }));
    mockCycles.getCycleById.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    mockUpwardFeedback.saveUpwardFeedback.mockResolvedValue({ id: 'fb-1' });

    await handleUpwardFeedbackSubmit(submitArgs() as never);

    expect(mockUpwardFeedback.saveUpwardFeedback).toHaveBeenCalledWith(
      'cycle-1',
      'emp-1',
      'mgr-current',
      expect.objectContaining({ allow_hr_followup: true })
    );
  });

  it('does not submit when the actor identity does not match the metadata employee_id', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'someone-else' }));
    await handleUpwardFeedbackSubmit(submitArgs() as never);
    expect(mockUpwardFeedback.saveUpwardFeedback).not.toHaveBeenCalled();
  });

  it('does not submit when the employee has no manager (defensive re-check)', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1', manager_id: null }));
    await handleUpwardFeedbackSubmit(submitArgs() as never);
    expect(mockUpwardFeedback.saveUpwardFeedback).not.toHaveBeenCalled();
  });

  it('does not submit outside the collecting_feedback phase', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1', manager_id: 'mgr-1' }));
    mockEmployees.getEmployeeById.mockResolvedValue(buildEmployee({ id: 'mgr-1' }));
    mockCycles.getCycleById.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'manager_reviews' }));
    await handleUpwardFeedbackSubmit(submitArgs() as never);
    expect(mockUpwardFeedback.saveUpwardFeedback).not.toHaveBeenCalled();
  });

  it('a duplicate delivery is a no-op', async () => {
    mockIdempotency.claimSlackDelivery.mockResolvedValue(false);
    await handleUpwardFeedbackSubmit(submitArgs() as never);
    expect(mockMiddleware.getActorForSlackUser).not.toHaveBeenCalled();
    expect(mockUpwardFeedback.saveUpwardFeedback).not.toHaveBeenCalled();
  });
});
