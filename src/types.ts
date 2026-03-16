// Employee directory (Slack = identity)
export interface Employee {
  id: string;
  slack_id: string;
  name: string;
  email: string;
  manager_id: string | null;
  department: string;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

// Review cycle
export interface ReviewCycle {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: 'draft' | 'open' | 'closed';
  created_at: string;
  updated_at: string;
}

// Manager review (decision tree: Great / Needs Focus / At Risk)
export type ReviewStatus = 'on_track' | 'needs_focus' | 'at_risk';

export interface ManagerReview {
  id: string;
  cycle_id: string;
  employee_id: string;
  manager_id: string;
  status: ReviewStatus;
  strengths?: string;
  focus_areas?: string;
  examples?: string;
  development_areas?: string;
  next_cycle_expectations?: string;
  manager_support?: string;
  primary_concerns?: string;
  communicated_previously?: boolean;
  required_improvement?: string;
  improvement_timeline?: string;
  hr_review_required?: boolean;
  submitted_at: string;
  acknowledged_at?: string;
  acknowledgment_comment?: string;
  created_at: string;
  updated_at: string;
}

// Peer feedback request
export interface PeerRequest {
  id: string;
  cycle_id: string;
  requester_id: string;
  peer_id: string;
  status: 'pending' | 'accepted' | 'declined';
  focus_area?: string;
  requested_at: string;
  responded_at?: string;
  created_at: string;
  updated_at: string;
}

// Peer feedback submission
export interface PeerFeedback {
  id: string;
  cycle_id: string;
  employee_id: string;
  peer_id: string;
  request_id: string;
  strengths?: string;
  growth_areas?: string;
  example?: string;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

// Upward (manager) feedback
export interface UpwardFeedback {
  id: string;
  cycle_id: string;
  employee_id: string;
  manager_id: string;
  strengths?: string;
  improvements?: string;
  hr_notes?: string;
  allow_hr_followup: boolean;
  submitted_at: string;
  created_at: string;
  updated_at: string;
}

// Stored document reference
export interface DocumentRecord {
  id: string;
  employee_id: string;
  cycle_id: string;
  type: 'manager_review' | 'peer_feedback' | 'upward_feedback' | 'final_packet';
  file_url: string;
  s3_key: string;
  created_at: string;
}

// Audit log entry (compliance)
export interface AuditLog {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_slack_id?: string;
  details?: Record<string, unknown>;
  created_at: string;
}
