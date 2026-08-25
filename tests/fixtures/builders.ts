import type {
  Acknowledgement,
  Actor,
  ActorRoles,
  Employee,
  ManagerReview,
  PeerFeedback,
  PeerRequest,
  ReviewCycle,
  ReviewRelease,
  SelfReflection,
  UpwardFeedback,
} from '../../src/types';
import { DEFAULT_SELF_REFLECTION_PROMPTS } from '../../src/types';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function buildEmployee(overrides: Partial<Employee> = {}): Employee {
  const id = overrides.id ?? nextId('emp');
  return {
    id,
    slack_id: `U${id}`,
    name: `Employee ${id}`,
    email: `${id}@example.com`,
    manager_id: null,
    department: 'Engineering',
    status: 'active',
    is_people_admin: false,
    schema_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildActorRoles(overrides: Partial<ActorRoles> = {}): ActorRoles {
  return { isEmployee: true, isPeopleAdmin: false, isPrimaryApprover: false, ...overrides };
}

export function buildActor(employeeOverrides: Partial<Employee> = {}, roleOverrides: Partial<ActorRoles> = {}): Actor {
  return { employee: buildEmployee(employeeOverrides), roles: buildActorRoles(roleOverrides) };
}

export function buildCycle(overrides: Partial<ReviewCycle> = {}): ReviewCycle {
  return {
    id: overrides.id ?? nextId('cycle'),
    name: '2026-H1',
    status: 'collecting_feedback',
    timezone: 'UTC',
    deadlines: {},
    self_reflection_prompts: DEFAULT_SELF_REFLECTION_PROMPTS,
    max_peers: 3,
    schema_version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'admin-1',
    ...overrides,
  };
}

export function buildManagerReview(overrides: Partial<ManagerReview> = {}): ManagerReview {
  return {
    id: overrides.id ?? nextId('review'),
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    manager_id: 'mgr-1',
    version: 1,
    status: 'on_track',
    strengths: 'Great work',
    people_state: 'not_submitted',
    submitted_at: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildPeerRequest(overrides: Partial<PeerRequest> = {}): PeerRequest {
  return {
    id: overrides.id ?? nextId('req'),
    cycle_id: 'cycle-1',
    requester_id: 'emp-1',
    peer_id: 'emp-2',
    status: 'pending',
    requested_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildPeerFeedback(overrides: Partial<PeerFeedback> = {}): PeerFeedback {
  return {
    id: overrides.id ?? nextId('feedback'),
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    peer_id: 'emp-2',
    request_id: 'req-1',
    strengths: 'Solid collaborator',
    submitted_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildUpwardFeedback(overrides: Partial<UpwardFeedback> = {}): UpwardFeedback {
  return {
    id: overrides.id ?? nextId('upward'),
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    manager_id: 'mgr-1',
    strengths: 'Clear communicator',
    allow_hr_followup: false,
    submitted_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildSelfReflection(overrides: Partial<SelfReflection> = {}): SelfReflection {
  return {
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    prompt_version: 1,
    answers: {},
    state: 'draft',
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function buildReviewRelease(overrides: Partial<ReviewRelease> = {}): ReviewRelease {
  return {
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    review_version: 1,
    document_id: 'doc-1',
    released_by: 'approver-1',
    released_at: '2026-01-05T00:00:00.000Z',
    ...overrides,
  };
}

export function buildAcknowledgement(overrides: Partial<Acknowledgement> = {}): Acknowledgement {
  return {
    cycle_id: 'cycle-1',
    employee_id: 'emp-1',
    review_version: 1,
    acknowledged_at: '2026-01-06T00:00:00.000Z',
    ...overrides,
  };
}

export function fakeClock(iso = '2026-01-15T00:00:00.000Z') {
  return { now: () => new Date(iso) };
}
