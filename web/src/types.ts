// Shared API types mirroring the backend console API contract.

export interface Me {
  employee: { id: string; name: string; email: string };
  roles: { isEmployee: boolean; isPeopleAdmin: boolean; isPrimaryApprover: boolean };
}

export interface Employee {
  id: string;
  slack_id: string;
  name: string;
  email: string;
  manager_id: string | null;
  department: string | null;
  status: 'active' | 'inactive';
  is_people_admin: boolean;
  created_at: string;
  updated_at: string;
}

export interface DirectoryImportSummary {
  id: string;
  status: string;
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
  created_at: string;
}

export interface ImportPlanRow {
  row: number;
  email: string;
  action: 'create' | 'update' | 'unchanged' | 'deactivate' | 'unresolved' | 'error';
  changes?: Record<string, { from: unknown; to: unknown }>;
  slack_resolved?: boolean;
}

export interface ImportPlanMessage {
  row?: number;
  email?: string;
  message: string;
}

export interface ImportPlan {
  rows: ImportPlanRow[];
  warnings: ImportPlanMessage[];
  errors: ImportPlanMessage[];
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  deactivatedCount: number;
  unresolvedCount: number;
}

export type CycleStatus =
  | 'draft'
  | 'collecting_feedback'
  | 'manager_reviews'
  | 'people_review'
  | 'released'
  | 'closed'
  | 'cancelled';

export interface CycleDeadlines {
  cycle_start?: string;
  self_reflection_due?: string;
  peer_requests_due?: string;
  peer_feedback_due?: string;
  upward_feedback_due?: string;
  manager_reviews_due?: string;
  target_release_date?: string;
  acknowledgement_due?: string;
  cycle_close?: string;
}

export interface SelfReflectionPrompt {
  key: string;
  label: string;
  required: boolean;
}

export interface ReviewCycle {
  id: string;
  name: string;
  status: CycleStatus;
  timezone: string;
  deadlines: CycleDeadlines;
  self_reflection_prompts: SelfReflectionPrompt[];
  max_peers: number;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export interface EligiblePopulation {
  count: number;
  employees: Array<{ id: string; name: string; department: string | null; manager_id: string | null }>;
}

export type PeopleState =
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

export interface AtRiskDetail {
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
  status: 'on_track' | 'needs_focus' | 'at_risk';
  strengths?: string;
  focus_areas?: string;
  examples?: string;
  development_areas?: string;
  next_cycle_expectations?: string;
  manager_support?: string;
  at_risk?: AtRiskDetail;
  follow_up_notes?: string;
  people_state: PeopleState;
  return_reason?: string;
  submitted_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseRecord {
  cycle_id: string;
  employee_id: string;
  review_version: number;
  document_id: string;
  released_by: string;
  released_at: string;
}

export interface AcknowledgementRecord {
  cycle_id: string;
  employee_id: string;
  review_version: number;
  comment?: string;
  acknowledged_at: string;
}

export interface ReviewQueueRow {
  review: ManagerReview;
  employee: Employee;
  manager: Employee | null;
  release: ReleaseRecord | null;
  acknowledgement: AcknowledgementRecord | null;
}

export interface SelfReflection {
  employee_id: string;
  cycle_id: string;
  responses: Record<string, string>;
  submitted_at?: string;
}

export interface PeerFeedback {
  id: string;
  cycle_id: string;
  employee_id: string;
  reviewer_name?: string;
  reviewer_id?: string;
  strengths?: string;
  improvements?: string;
  submitted_at?: string;
}

export interface PeopleNote {
  id: string;
  author_id: string;
  note: string;
  created_at: string;
}

export interface Approval {
  id: string;
  action: string;
  actor_id: string;
  review_version: number;
  notes?: string;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_slack_id?: string;
  cycle_id?: string;
  manager_id?: string;
  details?: unknown;
  created_at: string;
}

export interface ReviewDetail {
  review: ManagerReview;
  employee: Employee;
  manager: Employee | null;
  selfReflection: SelfReflection | null;
  peerFeedback: PeerFeedback[];
  history: ManagerReview[];
  notes: PeopleNote[];
  approvals: Approval[];
  release: ReleaseRecord | null;
  acknowledgement: AcknowledgementRecord | null;
  auditEvents: AuditEvent[];
}

export interface DashboardData {
  cycle: ReviewCycle | null;
  completion: Record<string, number>;
  queues: {
    people_review_waiting: number;
    primary_approval_waiting: number;
    at_risk_waiting: number;
    ready_for_release: number;
    released_unacknowledged: number;
  };
  operations: { failed_jobs: number };
}

export type UpwardFeedbackMode = 'none' | 'summary_only' | 'comments_only' | 'summary_and_comments';

export interface UpwardFeedbackRelease {
  cycle_id: string;
  manager_id: string;
  version: number;
  mode: UpwardFeedbackMode;
  summary_text?: string;
  selected_comment_ids: string[];
  respondent_count: number;
  below_threshold: boolean;
  threshold_override_reason?: string;
  prepared_by: string;
  released_by: string;
  released_at: string;
  created_at: string;
}

export interface UpwardFeedbackManagerSummary {
  manager: { id: string; name: string };
  respondentCount: number;
  belowThreshold: boolean;
  released: boolean;
  release: UpwardFeedbackRelease | null;
}

export interface UpwardFeedbackSubmission {
  anonymousId: string;
  strengths?: string;
  improvements?: string;
  hr_notes?: string;
  allow_hr_followup: boolean;
}

export type ReminderType =
  | 'self_reflection_missing'
  | 'peer_request_pending'
  | 'peer_feedback_incomplete'
  | 'upward_feedback_missing'
  | 'manager_review_missing'
  | 'manager_review_returned'
  | 'people_review_waiting'
  | 'primary_approval_waiting'
  | 'released_unacknowledged';

export interface ReminderRecipient {
  id: string;
  name: string;
  reason: string;
}

export interface ReminderPreview {
  message: string;
  recipients: ReminderRecipient[];
}

export interface OutboxJob {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error?: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface OperationsJobs {
  pending: OutboxJob[];
  processing: OutboxJob[];
  failed: OutboxJob[];
  deadLetter: OutboxJob[];
}
