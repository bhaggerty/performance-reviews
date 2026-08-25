import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildActor, buildCycle, buildEmployee, buildManagerReview } from '../fixtures/builders';
import type { Actor } from '../../src/types';

// --- db/service mocks (every module transitively imported by src/api/console/index.ts) ---
const mockCycles = {
  getActiveCycle: vi.fn(),
  getCycleById: vi.fn(),
  listCycles: vi.fn(),
  createCycle: vi.fn(),
  updateCycleConfig: vi.fn(),
  transitionCycle: vi.fn(),
};
vi.mock('../../src/db/cycles', () => mockCycles);

const mockEmployees = { listEmployees: vi.fn(), getEmployeeById: vi.fn(), getEmployeeBySlackId: vi.fn() };
vi.mock('../../src/db/employees', () => mockEmployees);

const mockReviews = {
  getReviewsByCycle: vi.fn(),
  getManagerReview: vi.fn(),
  addPeopleNote: vi.fn(),
  beginPeopleReview: vi.fn(),
  getReviewHistory: vi.fn(),
  listApprovals: vi.fn(),
  listPeopleNotes: vi.fn(),
  markApproved: vi.fn(),
  markAwaitingPrimaryApproval: vi.fn(),
  markPeopleReviewComplete: vi.fn(),
  markReleased: vi.fn(),
  recordApproval: vi.fn(),
  returnToManager: vi.fn(),
};
vi.mock('../../src/db/reviews', () => mockReviews);

const mockSelfReflections = { getSelfReflection: vi.fn() };
vi.mock('../../src/db/selfReflections', () => mockSelfReflections);

const mockPeerFeedback = { listPeerRequestsForCycle: vi.fn(), getPeerFeedbackForEmployee: vi.fn() };
vi.mock('../../src/db/peerFeedback', () => mockPeerFeedback);

const mockUpwardFeedback = {
  getUpwardFeedbackForEmployee: vi.fn(),
  getUpwardFeedbackByManager: vi.fn(),
  getLatestUpwardFeedbackRelease: vi.fn(),
  recordUpwardFeedbackRelease: vi.fn(),
};
vi.mock('../../src/db/upwardFeedback', () => mockUpwardFeedback);

const mockOutbox = { listJobsByStatus: vi.fn(), retryDeadLetterJob: vi.fn(), enqueueJob: vi.fn() };
vi.mock('../../src/db/outbox', () => mockOutbox);

const mockReleases = { getReviewRelease: vi.fn(), createReviewRelease: vi.fn() };
vi.mock('../../src/db/releases', () => mockReleases);

const mockAcks = { getAcknowledgement: vi.fn() };
vi.mock('../../src/db/acknowledgements', () => mockAcks);

const mockAudit = { logAudit: vi.fn(), searchAudit: vi.fn(), listAuditByEntity: vi.fn(), listAuditByActor: vi.fn() };
vi.mock('../../src/db/audit', () => mockAudit);

const mockDocumentsDb = { listDocumentsForEmployee: vi.fn() };
vi.mock('../../src/db/documents', () => mockDocumentsDb);

const mockDirectoryImports = { listDirectoryImports: vi.fn() };
vi.mock('../../src/db/directoryImports', () => mockDirectoryImports);

const mockDocumentsService = { generateAndStoreManagerReview: vi.fn() };
vi.mock('../../src/services/documents', () => mockDocumentsService);

vi.mock('../../src/services/directoryImport/importer', () => ({ planImport: vi.fn(), commitImport: vi.fn() }));

// src/api/console/directory.ts imports the real Slack Bolt app (module-level ExpressReceiver
// construction requires a real signing secret / socket-mode config) purely to call
// slackApp.client.users.lookupByEmail — stub it out so importing the console router never
// requires real Slack credentials or makes a real Slack API call.
vi.mock('../../src/slack/app', () => ({ slackApp: { client: { users: { lookupByEmail: vi.fn() } } } }));

// --- config mock (drives requirePrimaryApprover / requirePeopleAdmin via real domain/authz).
// Full shape provided because src/db/client.ts (transitively loaded via src/web/session.ts,
// even though this test app never calls attachActor/establishSession) reads config.aws.* at
// module load time.
const mockConfig = {
  env: 'development' as const,
  isProduction: false,
  port: 3000,
  logLevel: 'error',
  slack: {
    botToken: '',
    signingSecret: '',
    appToken: undefined,
    useSocketMode: false,
    workspaceId: '',
    clientId: '',
    clientSecret: '',
  },
  app: { url: 'http://localhost:3000' },
  aws: {
    region: 'us-east-1',
    tableName: 'performance-reviews-test',
    endpoint: undefined,
    s3Bucket: '',
    s3Prefix: 'Performance Reviews',
  },
  documents: { archiveWebhookUrl: '', archiveWebhookSecret: '' },
  ai: {
    provider: 'none' as const,
    anthropic: { apiKey: '', model: '' },
    openai: { apiKey: '', model: '' },
    timeoutMs: 4000,
    maxRetries: 1,
  },
  people: { primaryApproverEmail: 'approver@example.com', peopleAdminEmails: new Set<string>() },
  web: { authConfigured: false, authDisabledInsecure: false, sessionSecret: 'test-secret', cookieSecure: false },
  automationApi: { enabled: false, token: '' },
  cycle: { defaultMaxPeers: 3 },
};
vi.mock('../../src/config', () => ({ config: mockConfig }));

const consoleRouter = (await import('../../src/api/console')).default;

// One shared test actor per request, injected ahead of the real router — bypasses real
// Slack OIDC/session handling while exercising the REAL requireConsoleSession /
// requirePeopleAdminMiddleware / requirePrimaryApproverMiddleware / requireCsrf middleware.
let currentActor: Actor | null = null;

function buildApp() {
  const app = express();
  app.use((req: express.Request & { actor?: Actor }, _res, next) => {
    if (currentActor) req.actor = currentActor;
    next();
  });
  app.use('/api/console', consoleRouter);
  return app;
}

const CSRF_TOKEN = 'test-csrf-token';
function withCsrf(req: request.Test): request.Test {
  return req.set('Cookie', `pr_csrf=${CSRF_TOKEN}`).set('X-CSRF-Token', CSRF_TOKEN);
}

const peopleAdmin = buildActor(
  { id: 'admin-1', email: 'admin@example.com', is_people_admin: true },
  { isPeopleAdmin: true, isPrimaryApprover: false }
);
const primaryApprover = buildActor(
  { id: 'approver-1', email: 'approver@example.com', is_people_admin: true },
  { isPeopleAdmin: true, isPrimaryApprover: true }
);
const plainEmployee = buildActor(
  { id: 'emp-1', email: 'emp@example.com' },
  { isPeopleAdmin: false, isPrimaryApprover: false }
);

beforeEach(() => {
  vi.clearAllMocks();
  currentActor = null;
  mockReviews.getManagerReview.mockResolvedValue(
    buildManagerReview({
      id: 'rev-1',
      cycle_id: 'cycle-1',
      employee_id: 'emp-1',
      status: 'on_track',
      people_state: 'approved',
      version: 3,
    })
  );
  mockCycles.getCycleById.mockResolvedValue(buildCycle({ id: 'cycle-1' }));
  mockDocumentsService.generateAndStoreManagerReview.mockResolvedValue({ id: 'doc-1' });
  mockReleases.createReviewRelease.mockResolvedValue({
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    review_version: 3,
    document_id: 'doc-1',
  });
  mockEmployees.getEmployeeById.mockResolvedValue(buildEmployee({ id: 'emp-1', slack_id: null }));
  mockReviews.markAwaitingPrimaryApproval.mockResolvedValue(undefined);
});

describe('authentication and authorization gate', () => {
  it('401s an unauthenticated request', async () => {
    const res = await request(buildApp()).get('/api/console/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('not_authenticated');
  });

  it('403s an authenticated non-People-admin', async () => {
    currentActor = plainEmployee;
    const res = await request(buildApp()).get('/api/console/dashboard');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_people_admin');
  });

  it('allows a People admin to reach a non-sensitive route', async () => {
    currentActor = peopleAdmin;
    mockCycles.getActiveCycle.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/console/dashboard');
    expect(res.status).toBe(200);
  });
});

describe('CSRF protection', () => {
  it('rejects a POST without a matching CSRF header/cookie pair', async () => {
    currentActor = peopleAdmin;
    const res = await request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/notes').send({ note: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_check_failed');
  });

  it('accepts a POST with a matching CSRF header/cookie pair', async () => {
    currentActor = peopleAdmin;
    mockReviews.addPeopleNote.mockResolvedValue({ id: 'note-1' });
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/notes')).send({
      note: 'hi',
    });
    expect(res.status).toBe(201);
  });
});

describe('Primary Approver enforcement on sensitive review actions', () => {
  it('a non-primary People admin recommending approval succeeds (not gated)', async () => {
    currentActor = peopleAdmin;
    mockReviews.recordApproval.mockResolvedValue({ id: 'appr-1' });
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/recommend')).send(
      {}
    );
    expect(res.status).toBe(201);
  });

  it('a non-primary People admin is denied at /approve', async () => {
    currentActor = peopleAdmin;
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/approve')).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_primary_approver');
  });

  it('a non-primary People admin is denied at /release', async () => {
    currentActor = peopleAdmin;
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/release')).send({});
    expect(res.status).toBe(403);
  });

  it('a non-primary People admin is denied at bulk-release', async () => {
    currentActor = peopleAdmin;
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/bulk-release')).send({
      employee_ids: ['emp-1'],
    });
    expect(res.status).toBe(403);
  });

  it('a non-primary People admin is denied at upward-feedback release', async () => {
    currentActor = peopleAdmin;
    const res = await withCsrf(
      request(buildApp()).post('/api/console/cycles/cycle-1/upward-feedback/mgr-1/release')
    ).send({ mode: 'none' });
    expect(res.status).toBe(403);
  });

  it('a non-primary People admin is denied on a sensitive cycle transition (collecting_feedback)', async () => {
    currentActor = peopleAdmin;
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/transition')).send({
      status: 'collecting_feedback',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('requires_primary_approver');
  });

  it('the Primary Approver CAN approve', async () => {
    currentActor = primaryApprover;
    mockReviews.markApproved.mockResolvedValue({ ...buildManagerReview(), people_state: 'approved' });
    mockReviews.recordApproval.mockResolvedValue({ id: 'appr-2' });
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/approve')).send({});
    expect(res.status).toBe(200);
  });

  it('the Primary Approver CAN release', async () => {
    currentActor = primaryApprover;
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/emp-1/release')).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('the Primary Approver CAN transition a cycle to collecting_feedback', async () => {
    currentActor = primaryApprover;
    mockCycles.transitionCycle.mockResolvedValue(buildCycle({ status: 'collecting_feedback' }));
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/transition')).send({
      status: 'collecting_feedback',
    });
    expect(res.status).toBe(200);
  });
});

describe('bulk release excludes At Risk reviews', () => {
  it('an At Risk employee in the batch comes back ok:false while others succeed', async () => {
    currentActor = primaryApprover;
    mockReviews.getManagerReview.mockImplementation((_cycleId: string, employeeId: string) =>
      employeeId === 'emp-at-risk'
        ? buildManagerReview({ employee_id: 'emp-at-risk', status: 'at_risk', people_state: 'approved', version: 1 })
        : buildManagerReview({ employee_id: 'emp-ok', status: 'on_track', people_state: 'approved', version: 1 })
    );
    const res = await withCsrf(request(buildApp()).post('/api/console/cycles/cycle-1/reviews/bulk-release')).send({
      employee_ids: ['emp-at-risk', 'emp-ok'],
    });
    expect(res.status).toBe(200);
    const atRiskResult = res.body.results.find((r: { employeeId: string }) => r.employeeId === 'emp-at-risk');
    const okResult = res.body.results.find((r: { employeeId: string }) => r.employeeId === 'emp-ok');
    expect(atRiskResult.ok).toBe(false);
    expect(atRiskResult.error).toMatch(/individually/);
    expect(okResult.ok).toBe(true);
  });
});

describe('upward feedback release — fewer-than-3-respondents threshold', () => {
  it('400s without an override reason when below threshold', async () => {
    currentActor = primaryApprover;
    mockUpwardFeedback.getUpwardFeedbackByManager.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]); // 2 respondents
    const res = await withCsrf(
      request(buildApp()).post('/api/console/cycles/cycle-1/upward-feedback/mgr-1/release')
    ).send({ mode: 'summary_only', summary_text: 'draft summary' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('below_threshold_confirmation_required');
  });

  it('succeeds below threshold once an explicit override reason is supplied', async () => {
    currentActor = primaryApprover;
    mockUpwardFeedback.getUpwardFeedbackByManager.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    mockUpwardFeedback.recordUpwardFeedbackRelease.mockResolvedValue({ version: 1 });
    const res = await withCsrf(
      request(buildApp()).post('/api/console/cycles/cycle-1/upward-feedback/mgr-1/release')
    ).send({
      mode: 'summary_only',
      summary_text: 'draft summary',
      threshold_override_reason: 'Small team; approved by leadership.',
    });
    expect(res.status).toBe(201);
  });

  it('succeeds at or above threshold with no override reason needed', async () => {
    currentActor = primaryApprover;
    mockUpwardFeedback.getUpwardFeedbackByManager.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }]);
    mockUpwardFeedback.recordUpwardFeedbackRelease.mockResolvedValue({ version: 1 });
    const res = await withCsrf(
      request(buildApp()).post('/api/console/cycles/cycle-1/upward-feedback/mgr-1/release')
    ).send({ mode: 'summary_only', summary_text: 'draft summary' });
    expect(res.status).toBe(201);
  });
});
