import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildActor, buildCycle } from '../fixtures/builders';

const mockMiddleware = { getActorForSlackUser: vi.fn() };
vi.mock('../../src/slack/middleware', () => mockMiddleware);

const mockCycles = { getActiveCycle: vi.fn() };
vi.mock('../../src/db/cycles', () => mockCycles);

const mockSelfReflections = {
  getSelfReflection: vi.fn(),
  saveSelfReflectionDraft: vi.fn(),
  submitSelfReflection: vi.fn(),
};
vi.mock('../../src/db/selfReflections', () => mockSelfReflections);

const mockAudit = { logAudit: vi.fn() };
vi.mock('../../src/db/audit', () => mockAudit);

const mockIdempotency = { claimSlackDelivery: vi.fn() };
vi.mock('../../src/slack/idempotency', () => mockIdempotency);

const mockHome = { refreshHomeForUser: vi.fn() };
vi.mock('../../src/slack/home', () => mockHome);

const { openSelfReflectionModal, handleSelfReflectionSubmit } = await import('../../src/slack/selfReflection');

function fakeClient() {
  return {
    views: { open: vi.fn(), update: vi.fn(), push: vi.fn(), publish: vi.fn() },
    chat: { postMessage: vi.fn() },
    conversations: { open: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdempotency.claimSlackDelivery.mockResolvedValue(true);
});

describe('openSelfReflectionModal', () => {
  it('shows a fallback view when the Slack user is not an employee', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(null);
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle());
    const client = fakeClient();
    await openSelfReflectionModal({ body: { trigger_id: 't1', user: { id: 'U1' } }, client, ack: vi.fn() } as never);
    expect(client.views.open).toHaveBeenCalledOnce();
    const view = client.views.open.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/not in the employee directory/);
  });

  it('shows a fallback view when there is no active cycle', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor());
    mockCycles.getActiveCycle.mockResolvedValue(null);
    const client = fakeClient();
    await openSelfReflectionModal({ body: { trigger_id: 't1', user: { id: 'U1' } }, client, ack: vi.fn() } as never);
    const view = client.views.open.mock.calls[0][0].view;
    expect(JSON.stringify(view)).toMatch(/No active review cycle/);
  });

  it('returns without opening any view when trigger_id is missing (stale/expired interaction)', async () => {
    const client = fakeClient();
    await openSelfReflectionModal({ body: { user: { id: 'U1' } }, client, ack: vi.fn() } as never);
    expect(client.views.open).not.toHaveBeenCalled();
  });

  it('opens the real self-reflection form for a valid actor + active cycle', async () => {
    const actor = buildActor();
    mockMiddleware.getActorForSlackUser.mockResolvedValue(actor);
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle());
    mockSelfReflections.getSelfReflection.mockResolvedValue(null);
    const client = fakeClient();
    await openSelfReflectionModal({ body: { trigger_id: 't1', user: { id: 'U1' } }, client, ack: vi.fn() } as never);
    const view = client.views.open.mock.calls[0][0].view;
    expect(view.callback_id).toBe('self_reflection_submit');
  });
});

function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    view: {
      private_metadata: JSON.stringify({ cycle_id: 'cycle-1', employee_id: 'emp-1', prompt_version: 1 }),
      state: { values: { 'self_reflection::submit_mode': { mode: { selected_option: { value: 'draft' } } } } },
    },
    ack: vi.fn(),
    body: { user: { id: 'U1' } },
    client: fakeClient(),
    ...overrides,
  };
}

describe('handleSelfReflectionSubmit', () => {
  it('does nothing but ack when the actor does not match the submission owner', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'someone-else' }));
    const args = submitBody();
    await handleSelfReflectionSubmit(args as never);
    expect(args.ack).toHaveBeenCalled();
    expect(mockSelfReflections.saveSelfReflectionDraft).not.toHaveBeenCalled();
  });

  it('saves a draft (not a final submit) when mode is draft', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    const args = submitBody();
    await handleSelfReflectionSubmit(args as never);
    expect(mockSelfReflections.saveSelfReflectionDraft).toHaveBeenCalledOnce();
    expect(mockSelfReflections.submitSelfReflection).not.toHaveBeenCalled();
  });

  it('submits as final when mode is submit', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    const args = submitBody({
      view: {
        private_metadata: JSON.stringify({ cycle_id: 'cycle-1', employee_id: 'emp-1', prompt_version: 1 }),
        state: {
          values: {
            'self_reflection::prompt::accomplishments': { value: { value: 'Shipped a major feature end to end.' } },
            'self_reflection::prompt::impact': { value: { value: 'Improved reliability for the whole team.' } },
            'self_reflection::prompt::strengths': { value: { value: 'Strong ownership and follow-through.' } },
            'self_reflection::prompt::challenges': { value: { value: 'Scope crept mid-cycle, adjusted plan.' } },
            'self_reflection::prompt::development': { value: { value: 'Want to grow in systems design.' } },
            'self_reflection::prompt::priorities': { value: { value: 'Lead the next major migration project.' } },
            'self_reflection::submit_mode': { mode: { selected_option: { value: 'submit' } } },
          },
        },
      },
    });
    await handleSelfReflectionSubmit(args as never);
    expect(mockSelfReflections.submitSelfReflection).toHaveBeenCalledOnce();
    expect(mockHome.refreshHomeForUser).toHaveBeenCalledOnce();
  });

  it('a duplicate delivery (idempotency claim already used) does not save a second time', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'collecting_feedback' }));
    mockIdempotency.claimSlackDelivery.mockResolvedValue(false);
    const args = submitBody();
    await handleSelfReflectionSubmit(args as never);
    expect(mockSelfReflections.saveSelfReflectionDraft).not.toHaveBeenCalled();
  });

  it('does nothing when the cycle phase does not allow editing (e.g. manager_reviews)', async () => {
    mockMiddleware.getActorForSlackUser.mockResolvedValue(buildActor({ id: 'emp-1' }));
    mockCycles.getActiveCycle.mockResolvedValue(buildCycle({ id: 'cycle-1', status: 'manager_reviews' }));
    const args = submitBody();
    await handleSelfReflectionSubmit(args as never);
    expect(mockSelfReflections.saveSelfReflectionDraft).not.toHaveBeenCalled();
  });
});
