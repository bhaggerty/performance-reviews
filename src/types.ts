// Core domain types. See docs/DATA_MODEL.md for the DynamoDB key design behind these.

export type ISODateString = string;

// ---------------------------------------------------------------------------
// Employee directory
// ---------------------------------------------------------------------------

export type EmployeeStatus = 'active' | 'inactive';

export interface Employee {
  id: string;
  slack_id: string | null;
  name: string;
  email: string; // normalized (lowercased, trimmed) — stable external identity
  manager_id: string | null;
  department: string;
  status: EmployeeStatus;
  is_people_admin: boolean;
  schema_version: number;
  created_at: ISODateString;
  updated_at: ISODateString;
}

/** Server-derived role set for a resolved actor. Primary Approver is NEVER stored — it is
 * computed from (authenticated email === config.people.primaryApproverEmail) AND
 * is_people_admin, every time. */
export interface ActorRoles {
  isEmployee: boolean;
  isPeopleAdmin: boolean;
  isPrimaryApprover: boolean;
}

export interface Actor {
  employee: Employee;
  roles: ActorRoles;
}

// ---------------------------------------------------------------------------
// Review cycle state machine
// ---------------------------------------------------------------------------

export type CycleStatus =
  'draft' | 'collecting_feedback' | 'manager_reviews' | 'people_review' | 'released' | 'closed' | 'cancelled';

export interface CycleDeadlines {
  cycle_start?: ISODateString;
  self_reflection_due?: ISODateString;
  peer_requests_due?: ISODateString;
  peer_feedback_due?: ISODateString;
  upward_feedback_due?: ISODateString;
  manager_reviews_due?: ISODateString;
  target_release_date?: ISODateString;
  acknowledgement_due?: ISODateString;
  cycle_close?: ISODateString;
}

export interface SelfReflectionPromptConfig {
  key: string;
  label: string;
  required: boolean;
}

export const DEFAULT_SELF_REFLECTION_PROMPTS: SelfReflectionPromptConfig[] = [
  { key: 'accomplishments', label: 'Accomplishments and outcomes', required: true },
  { key: 'impact', label: 'Impact on customers, the company, or the team', required: true },
  { key: 'strengths', label: 'Strengths demonstrated', required: true },
  { key: 'challenges', label: 'Challenges and lessons learned', required: true },
  { key: 'development', label: 'Development opportunities', required: true },
  { key: 'priorities', label: 'Priorities for the next cycle', required: true },
  { key: 'support_needed', label: 'Support needed from the manager or company', required: false },
];

export interface ReviewCycle {
  id: string;
  name: string;
  status: CycleStatus;
  timezone: string;
  deadlines: CycleDeadlines;
  self_reflection_prompts: SelfReflectionPromptConfig[];
  max_peers: number;
  schema_version: number;
  created_at: ISODateString;
  updated_at: ISODateString;
  created_by: string;
}

export const CYCLE_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  draft: ['collecting_feedback', 'cancelled'],
  collecting_feedback: ['manager_reviews', 'cancelled'],
  manager_reviews: ['people_review', 'cancelled'],
  people_review: ['released', 'cancelled'],
  released: ['closed'],
  closed: [],
  cancelled: [],
};

// ---------------------------------------------------------------------------
// Self reflection
// ---------------------------------------------------------------------------

export type SelfReflectionState = 'draft' | 'submitted' | 'reopened';

export interface SelfReflection {
  cycle_id: string;
  employee_id: string;
  prompt_version: number;
  answers: Record<string, string>;
  state: SelfReflectionState;
  version: number;
  created_at: ISODateString;
  updated_at: ISODateString;
  submitted_at?: ISODateString;
  reopened_at?: ISODateString;
  reopened_by?: string;
}

// ---------------------------------------------------------------------------
// Peer feedback
// ---------------------------------------------------------------------------

export type PeerRequestStatus = 'pending' | 'accepted' | 'declined' | 'submitted' | 'expired' | 'cancelled';

export interface PeerRequest {
  id: string;
  cycle_id: string;
  requester_id: string;
  peer_id: string;
  status: PeerRequestStatus;
  focus_area?: string;
  requested_at: ISODateString;
  responded_at?: ISODateString;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface PeerFeedback {
  id: string;
  cycle_id: string;
  employee_id: string;
  peer_id: string;
  request_id: string;
  strengths?: string;
  growth_areas?: string;
  example?: string;
  follow_up_notes?: string;
  redacted_for_employee?: boolean;
  redaction_note?: string;
  submitted_at: ISODateString;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Upward feedback
// ---------------------------------------------------------------------------

export interface UpwardFeedback {
  id: string;
  cycle_id: string;
  employee_id: string; // author
  manager_id: string; // subject
  strengths?: string;
  improvements?: string;
  hr_notes?: string;
  follow_up_notes?: string;
  allow_hr_followup: boolean;
  submitted_at: ISODateString;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export type UpwardReleaseMode = 'none' | 'summary_only' | 'comments_only' | 'summary_and_comments';

export interface UpwardFeedbackRelease {
  cycle_id: string;
  manager_id: string;
  version: number;
  mode: UpwardReleaseMode;
  summary_text?: string;
  selected_comment_ids: string[]; // UpwardFeedback ids whose text is quoted verbatim, anonymized
  respondent_count: number;
  below_threshold: boolean; // fewer than 3 respondents
  threshold_override_reason?: string;
  prepared_by: string;
  released_by: string;
  released_at: ISODateString;
  created_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Manager review / People review / Approval / Release
// ---------------------------------------------------------------------------

export type ReviewStatus = 'on_track' | 'needs_focus' | 'at_risk';

export type PeopleReviewState =
  | 'not_submitted'
  | 'manager_draft'
  | 'submitted'
  | 'people_reviewing'
  | 'returned_to_manager'
  | 'people_review_complete'
  | 'awaiting_primary_approval'
  | 'approved'
  | 'released'
  | 'acknowledged';

export interface AtRiskDetails {
  concrete_examples?: string;
  prior_communication?: string;
  support_provided?: string;
  expected_improvement?: string;
  timeline?: string;
  people_involvement?: string;
}

export interface ManagerReview {
  id: string;
  cycle_id: string;
  employee_id: string;
  manager_id: string;
  version: number;
  status: ReviewStatus;
  strengths?: string;
  focus_areas?: string;
  examples?: string;
  development_areas?: string;
  next_cycle_expectations?: string;
  manager_support?: string;
  at_risk?: AtRiskDetails;
  follow_up_notes?: string;
  people_state: PeopleReviewState;
  return_reason?: string;
  submitted_at: ISODateString;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface PeopleNote {
  cycle_id: string;
  employee_id: string;
  id: string;
  author_id: string;
  note: string;
  created_at: ISODateString;
}

export type ApprovalAction = 'recommend' | 'primary_approve' | 'at_risk_primary_approve';

export interface Approval {
  id: string;
  cycle_id: string;
  employee_id: string;
  action: ApprovalAction;
  actor_id: string;
  review_version: number;
  notes?: string;
  created_at: ISODateString;
}

export interface ReviewRelease {
  cycle_id: string;
  employee_id: string;
  review_version: number;
  document_id: string;
  released_by: string;
  released_at: ISODateString;
}

export interface Acknowledgement {
  cycle_id: string;
  employee_id: string;
  review_version: number;
  comment?: string;
  acknowledged_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentVisibility = 'employee' | 'employee_and_manager' | 'hr';
export type DocumentArchiveBackend = 'none' | 's3' | 'webhook';
export type DocumentType = 'manager_review' | 'peer_feedback' | 'upward_feedback' | 'final_packet';

export interface DocumentRecord {
  id: string;
  employee_id: string;
  cycle_id: string;
  type: DocumentType;
  source_entity_id: string;
  source_version: number;
  content_hash: string;
  title: string;
  content: string;
  author_employee_id?: string;
  visibility: DocumentVisibility;
  archive_backend: DocumentArchiveBackend;
  archive_url?: string;
  archive_key?: string;
  created_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_slack_id?: string;
  cycle_id?: string;
  manager_id?: string;
  details?: Record<string, unknown>;
  created_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Outbox / jobs
// ---------------------------------------------------------------------------

export type OutboxJobType =
  'notify_slack_dm' | 'generate_document' | 'archive_document' | 'send_reminder' | 'ai_followup';

export type OutboxJobStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'dead_letter';

export interface OutboxJob {
  id: string;
  type: OutboxJobType;
  status: OutboxJobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  run_after: ISODateString;
  last_error?: string;
  idempotency_key: string;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  scope: string;
  key: string;
  created_at: ISODateString;
  ttl: number;
}

// ---------------------------------------------------------------------------
// Directory import
// ---------------------------------------------------------------------------

export type DirectoryImportStatus = 'dry_run' | 'committed';

export interface DirectoryImportSummary {
  id: string;
  status: DirectoryImportStatus;
  source: string;
  authoritative_snapshot: boolean;
  created_count: number;
  updated_count: number;
  unchanged_count: number;
  deactivated_count: number;
  unresolved_count: number;
  warning_count: number;
  error_count: number;
  actor_id: string;
  created_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationRecord {
  id: string;
  employee_id: string;
  type: string;
  dedupe_key: string;
  sent_at: ISODateString;
}
