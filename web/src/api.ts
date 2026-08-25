import type {
  Me,
  Employee,
  DirectoryImportSummary,
  ImportPlan,
  ReviewCycle,
  EligiblePopulation,
  ReviewQueueRow,
  ReviewDetail,
  DashboardData,
  UpwardFeedbackManagerSummary,
  UpwardFeedbackSubmission,
  UpwardFeedbackRelease,
  UpwardFeedbackMode,
  ReminderType,
  ReminderPreview,
  OperationsJobs,
  OutboxJob,
  PeopleNote,
  Approval,
  AuditEvent,
  CycleDeadlines,
  SelfReflectionPrompt,
  ManagerReview,
} from './types';

const CONSOLE_BASE = '/api/console';

export class ApiRequestError extends Error {
  status: number;
  body: { error?: string; message?: string } | undefined;

  constructor(status: number, body: { error?: string; message?: string } | undefined) {
    super(body?.message || body?.error || `Request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = new Headers();

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = getCookie('pr_csrf');
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers.set('Content-Type', 'text/plain');
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    throw new ApiRequestError(res.status, data);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
const patch = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body });
const postRaw = <T>(path: string, rawBody: string) => request<T>(path, { method: 'POST', rawBody });

export const api = {
  me: () => get<Me>(`${CONSOLE_BASE}/me`),

  dashboard: () => get<DashboardData>(`${CONSOLE_BASE}/dashboard`),

  // Directory
  listEmployees: () => get<{ employees: Employee[] }>(`${CONSOLE_BASE}/directory/employees`),
  listImports: () => get<{ imports: DirectoryImportSummary[] }>(`${CONSOLE_BASE}/directory/imports`),
  importDryRun: (csv: string, authoritative: boolean) =>
    postRaw<{ plan: ImportPlan }>(
      `${CONSOLE_BASE}/directory/import/dry-run?authoritative=${authoritative}`,
      csv
    ),
  importCommit: (csv: string, authoritative: boolean, confirm: boolean) =>
    postRaw<{ summary: DirectoryImportSummary }>(
      `${CONSOLE_BASE}/directory/import/commit?authoritative=${authoritative}&confirm=${confirm}`,
      csv
    ),

  // Cycles
  listCycles: () => get<{ cycles: ReviewCycle[] }>(`${CONSOLE_BASE}/cycles`),
  getCycle: (id: string) => get<{ cycle: ReviewCycle }>(`${CONSOLE_BASE}/cycles/${id}`),
  eligiblePopulation: (id: string) =>
    get<EligiblePopulation>(`${CONSOLE_BASE}/cycles/${id}/eligible-population`),
  createCycle: (body: {
    name: string;
    timezone?: string;
    deadlines?: CycleDeadlines;
    max_peers?: number;
    self_reflection_prompts?: SelfReflectionPrompt[];
  }) => post<{ cycle: ReviewCycle }>(`${CONSOLE_BASE}/cycles`, body),
  updateCycleConfig: (
    id: string,
    body: Partial<{
      name: string;
      timezone: string;
      deadlines: CycleDeadlines;
      max_peers: number;
      self_reflection_prompts: SelfReflectionPrompt[];
    }>
  ) => patch<{ cycle: ReviewCycle }>(`${CONSOLE_BASE}/cycles/${id}/config`, body),
  transitionCycle: (id: string, status: string) =>
    post<{ cycle: ReviewCycle }>(`${CONSOLE_BASE}/cycles/${id}/transition`, { status }),

  // Reviews
  listReviews: (cycleId: string, atRisk?: boolean) =>
    get<{ reviews: ReviewQueueRow[] }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/reviews${atRisk ? '?at_risk=true' : ''}`
    ),
  getReview: (cycleId: string, employeeId: string) =>
    get<ReviewDetail>(`${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}`),
  addNote: (cycleId: string, employeeId: string, note: string) =>
    post<{ note: PeopleNote }>(`${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/notes`, {
      note,
    }),
  beginReview: (cycleId: string, employeeId: string) =>
    post<{ review: ManagerReview }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/begin-review`
    ),
  returnReview: (cycleId: string, employeeId: string, reason: string) =>
    post<{ review: ManagerReview }>(`${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/return`, {
      reason,
    }),
  completeReview: (cycleId: string, employeeId: string) =>
    post<{ review: ManagerReview }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/complete`
    ),
  recommendReview: (cycleId: string, employeeId: string, notes?: string) =>
    post<{ approval: Approval }>(`${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/recommend`, {
      notes,
    }),
  approveReview: (cycleId: string, employeeId: string, notes?: string) =>
    post<{ review: ManagerReview; approval: Approval }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/approve`,
      { notes }
    ),
  releaseReview: (cycleId: string, employeeId: string) =>
    post<{ ok: true }>(`${CONSOLE_BASE}/cycles/${cycleId}/reviews/${employeeId}/release`),
  bulkRelease: (cycleId: string, employeeIds: string[]) =>
    post<{ results: Array<{ employeeId: string; ok: boolean; error?: string }> }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/reviews/bulk-release`,
      { employee_ids: employeeIds }
    ),

  // Upward feedback
  listUpwardFeedback: (cycleId: string) =>
    get<{ managers: UpwardFeedbackManagerSummary[] }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/upward-feedback`
    ),
  rawUpwardFeedback: (cycleId: string, managerId: string) =>
    get<{ submissions: UpwardFeedbackSubmission[] }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/upward-feedback/${managerId}/raw`
    ),
  draftUpwardSummary: (cycleId: string, managerId: string) =>
    post<{ draftSummary: string }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/upward-feedback/${managerId}/draft-summary`
    ),
  releaseUpwardFeedback: (
    cycleId: string,
    managerId: string,
    body: {
      mode: UpwardFeedbackMode;
      summary_text?: string;
      selected_comment_ids?: string[];
      threshold_override_reason?: string;
    }
  ) =>
    post<{ release: UpwardFeedbackRelease }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/upward-feedback/${managerId}/release`,
      body
    ),

  // Reminders
  previewReminder: (cycleId: string, type: ReminderType) =>
    get<ReminderPreview>(`${CONSOLE_BASE}/cycles/${cycleId}/reminders/${type}/preview`),
  sendReminder: (cycleId: string, type: ReminderType, excludeEmployeeIds?: string[]) =>
    post<{ enqueued: number; skipped: number }>(
      `${CONSOLE_BASE}/cycles/${cycleId}/reminders/${type}/send`,
      { exclude_employee_ids: excludeEmployeeIds }
    ),

  // Audit
  listAudit: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v) qs.set(k, v);
    });
    return get<{ events: AuditEvent[] }>(`${CONSOLE_BASE}/audit?${qs.toString()}`);
  },

  // Operations
  listJobs: () => get<OperationsJobs>(`${CONSOLE_BASE}/operations/jobs`),
  retryJob: (id: string) => post<{ job: OutboxJob }>(`${CONSOLE_BASE}/operations/jobs/${id}/retry`),
};

export const exportUrls = {
  completionReport: (cycleId: string) =>
    `${CONSOLE_BASE}/cycles/${cycleId}/exports/completion-report.csv`,
  employeeDirectory: () => `${CONSOLE_BASE}/exports/employee-directory.csv`,
  reviewStatus: (cycleId: string) => `${CONSOLE_BASE}/cycles/${cycleId}/exports/review-status.csv`,
  upwardFeedbackAdmin: (cycleId: string) =>
    `${CONSOLE_BASE}/cycles/${cycleId}/exports/upward-feedback-admin.csv`,
  finalPacket: (employeeId: string) => `${CONSOLE_BASE}/employees/${employeeId}/final-packet`,
  auditReport: (actorId?: string) =>
    `${CONSOLE_BASE}/exports/audit-report.csv${actorId ? `?actor_id=${encodeURIComponent(actorId)}` : ''}`,
};
