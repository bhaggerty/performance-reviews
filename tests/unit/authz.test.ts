import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildEmployee, buildActor, buildPeerRequest } from '../fixtures/builders';

const mockConfig = {
  people: {
    primaryApproverEmail: null as string | null,
    peopleAdminEmails: new Set<string>(),
  },
};

vi.mock('../../src/config', () => ({ config: mockConfig }));

const mockDb = {
  getEmployeeById: vi.fn(),
  getEmployeeBySlackId: vi.fn(),
  getEmployeeByEmail: vi.fn(),
};
vi.mock('../../src/db/employees', () => mockDb);

// Imported after mocks so the mocked modules are the ones actually wired in.
const {
  computeRoles,
  resolveSlackActor,
  resolveWebActor,
  requireActiveEmployee,
  requirePeopleAdmin,
  requirePrimaryApprover,
  requireCurrentManagerRelationship,
  requireManagerOfEmployee,
  requirePeerRequestOwner,
  requirePeerRequestRecipient,
  requireSubmissionOwner,
  requireReviewVisibility,
  requireReleasedReviewAccess,
  AuthorizationError,
} = await import('../../src/domain/authz');

function resetConfig() {
  mockConfig.people.primaryApproverEmail = null;
  mockConfig.people.peopleAdminEmails = new Set();
}

beforeEach(() => {
  resetConfig();
  vi.clearAllMocks();
});

describe('computeRoles', () => {
  it('plain employee has no admin/approver roles', () => {
    const roles = computeRoles(buildEmployee());
    expect(roles).toEqual({ isEmployee: true, isPeopleAdmin: false, isPrimaryApprover: false });
  });

  it('is_people_admin flag grants isPeopleAdmin', () => {
    const roles = computeRoles(buildEmployee({ is_people_admin: true }));
    expect(roles.isPeopleAdmin).toBe(true);
    expect(roles.isPrimaryApprover).toBe(false);
  });

  it('email present in config allowlist grants isPeopleAdmin even without the flag', () => {
    mockConfig.people.peopleAdminEmails = new Set(['admin@example.com']);
    const roles = computeRoles(buildEmployee({ email: 'Admin@Example.com', is_people_admin: false }));
    expect(roles.isPeopleAdmin).toBe(true);
  });

  it('matching primary approver email AND is_people_admin grants isPrimaryApprover', () => {
    mockConfig.people.primaryApproverEmail = 'approver@example.com';
    const roles = computeRoles(buildEmployee({ email: 'approver@example.com', is_people_admin: true }));
    expect(roles.isPrimaryApprover).toBe(true);
  });

  it('matching primary approver email WITHOUT being a people admin does NOT grant isPrimaryApprover', () => {
    mockConfig.people.primaryApproverEmail = 'approver@example.com';
    const roles = computeRoles(buildEmployee({ email: 'approver@example.com', is_people_admin: false }));
    expect(roles.isPrimaryApprover).toBe(false);
  });

  it('no primary approver configured means nobody is the primary approver', () => {
    mockConfig.people.primaryApproverEmail = null;
    const roles = computeRoles(buildEmployee({ email: 'anyone@example.com', is_people_admin: true }));
    expect(roles.isPrimaryApprover).toBe(false);
  });

  it('non-matching email does not grant isPrimaryApprover even if a people admin', () => {
    mockConfig.people.primaryApproverEmail = 'approver@example.com';
    const roles = computeRoles(buildEmployee({ email: 'someone-else@example.com', is_people_admin: true }));
    expect(roles.isPrimaryApprover).toBe(false);
  });
});

describe('resolveSlackActor / resolveWebActor', () => {
  it('resolveSlackActor returns null for a falsy slack id', async () => {
    expect(await resolveSlackActor(undefined)).toBeNull();
    expect(await resolveSlackActor(null)).toBeNull();
    expect(mockDb.getEmployeeBySlackId).not.toHaveBeenCalled();
  });

  it('resolveSlackActor returns null when no employee matches', async () => {
    mockDb.getEmployeeBySlackId.mockResolvedValue(null);
    expect(await resolveSlackActor('U123')).toBeNull();
  });

  it('resolveSlackActor returns an Actor with computed roles on a match', async () => {
    const emp = buildEmployee({ is_people_admin: true });
    mockDb.getEmployeeBySlackId.mockResolvedValue(emp);
    const actor = await resolveSlackActor('U123');
    expect(actor?.employee.id).toBe(emp.id);
    expect(actor?.roles.isPeopleAdmin).toBe(true);
  });

  it('resolveWebActor normalizes email before lookup and returns null for falsy input', async () => {
    expect(await resolveWebActor(undefined)).toBeNull();
    mockDb.getEmployeeByEmail.mockResolvedValue(buildEmployee());
    await resolveWebActor('  Foo@Example.com  ');
    expect(mockDb.getEmployeeByEmail).toHaveBeenCalledWith('foo@example.com');
  });
});

describe('requireActiveEmployee', () => {
  it('throws not_an_employee for a null actor', () => {
    expect(() => requireActiveEmployee(null)).toThrow(AuthorizationError);
    try {
      requireActiveEmployee(null);
    } catch (e) {
      expect((e as InstanceType<typeof AuthorizationError>).code).toBe('not_an_employee');
    }
  });

  it('throws inactive_employee for a non-active employee', () => {
    const actor = buildActor({ status: 'inactive' });
    expect(() => requireActiveEmployee(actor)).toThrow(/not active/);
  });

  it('does not throw for an active employee', () => {
    expect(() => requireActiveEmployee(buildActor())).not.toThrow();
  });
});

describe('requirePeopleAdmin / requirePrimaryApprover', () => {
  it('requirePeopleAdmin denies a non-admin', () => {
    const actor = buildActor({}, { isPeopleAdmin: false });
    expect(() => requirePeopleAdmin(actor)).toThrow(AuthorizationError);
  });

  it('requirePeopleAdmin allows an admin', () => {
    const actor = buildActor({}, { isPeopleAdmin: true });
    expect(() => requirePeopleAdmin(actor)).not.toThrow();
  });

  it('requirePrimaryApprover fails closed with code no_primary_approver_configured when unset', () => {
    mockConfig.people.primaryApproverEmail = null;
    const actor = buildActor({}, { isPeopleAdmin: true, isPrimaryApprover: true });
    try {
      requirePrimaryApprover(actor);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as InstanceType<typeof AuthorizationError>).code).toBe('no_primary_approver_configured');
    }
  });

  it('requirePrimaryApprover denies a people admin who is not the primary approver', () => {
    mockConfig.people.primaryApproverEmail = 'approver@example.com';
    const actor = buildActor({}, { isPeopleAdmin: true, isPrimaryApprover: false });
    expect(() => requirePrimaryApprover(actor)).toThrow(AuthorizationError);
  });

  it('requirePrimaryApprover allows the primary approver', () => {
    mockConfig.people.primaryApproverEmail = 'approver@example.com';
    const actor = buildActor({}, { isPeopleAdmin: true, isPrimaryApprover: true });
    expect(() => requirePrimaryApprover(actor)).not.toThrow();
  });
});

describe('requireCurrentManagerRelationship', () => {
  it('throws employee_not_found when the employee does not exist', async () => {
    mockDb.getEmployeeById.mockResolvedValue(null);
    await expect(requireCurrentManagerRelationship('mgr-1', 'emp-1')).rejects.toThrow(AuthorizationError);
  });

  it('throws not_current_manager when manager_id does not match', async () => {
    mockDb.getEmployeeById.mockResolvedValue(buildEmployee({ manager_id: 'mgr-2' }));
    await expect(requireCurrentManagerRelationship('mgr-1', 'emp-1')).rejects.toThrow(/not the current manager/);
  });

  it('throws inactive_employee when the employee is inactive', async () => {
    mockDb.getEmployeeById.mockResolvedValue(buildEmployee({ manager_id: 'mgr-1', status: 'inactive' }));
    await expect(requireCurrentManagerRelationship('mgr-1', 'emp-1')).rejects.toThrow(/not active/);
  });

  it('returns the employee when the manager relationship is current', async () => {
    const emp = buildEmployee({ manager_id: 'mgr-1' });
    mockDb.getEmployeeById.mockResolvedValue(emp);
    await expect(requireCurrentManagerRelationship('mgr-1', emp.id)).resolves.toEqual(emp);
  });
});

describe('requireManagerOfEmployee', () => {
  it('denies when the actor is not the employee manager_id', () => {
    const actor = buildActor({ id: 'mgr-a' });
    const employee = buildEmployee({ manager_id: 'mgr-b' });
    expect(() => requireManagerOfEmployee(actor, employee)).toThrow(AuthorizationError);
  });

  it('allows when the actor is the employee manager_id', () => {
    const actor = buildActor({ id: 'mgr-a' });
    const employee = buildEmployee({ manager_id: 'mgr-a' });
    expect(() => requireManagerOfEmployee(actor, employee)).not.toThrow();
  });
});

describe('peer request ownership', () => {
  it('requirePeerRequestOwner denies a non-requester', () => {
    const actor = buildActor({ id: 'emp-x' });
    const req = buildPeerRequest({ requester_id: 'emp-y' });
    expect(() => requirePeerRequestOwner(actor, req)).toThrow(AuthorizationError);
  });

  it('requirePeerRequestOwner allows the requester', () => {
    const actor = buildActor({ id: 'emp-x' });
    const req = buildPeerRequest({ requester_id: 'emp-x' });
    expect(() => requirePeerRequestOwner(actor, req)).not.toThrow();
  });

  it('requirePeerRequestRecipient denies a non-peer', () => {
    const actor = buildActor({ id: 'emp-x' });
    const req = buildPeerRequest({ peer_id: 'emp-y' });
    expect(() => requirePeerRequestRecipient(actor, req)).toThrow(AuthorizationError);
  });

  it('requirePeerRequestRecipient allows the peer', () => {
    const actor = buildActor({ id: 'emp-x' });
    const req = buildPeerRequest({ peer_id: 'emp-x' });
    expect(() => requirePeerRequestRecipient(actor, req)).not.toThrow();
  });
});

describe('requireSubmissionOwner', () => {
  it('denies a different owner', () => {
    const actor = buildActor({ id: 'emp-x' });
    expect(() => requireSubmissionOwner(actor, 'emp-y')).toThrow(AuthorizationError);
  });

  it('allows the matching owner', () => {
    const actor = buildActor({ id: 'emp-x' });
    expect(() => requireSubmissionOwner(actor, 'emp-x')).not.toThrow();
  });
});

describe('requireReviewVisibility', () => {
  const review = { employee_id: 'emp-1', manager_id: 'mgr-1', people_state: 'submitted' };

  it('People admin can always see it', () => {
    const actor = buildActor({}, { isPeopleAdmin: true });
    expect(() => requireReviewVisibility(actor, review, { released: false })).not.toThrow();
  });

  it('the manager who authored it can see it before release', () => {
    const actor = buildActor({ id: 'mgr-1' });
    expect(() => requireReviewVisibility(actor, review, { released: false })).not.toThrow();
  });

  it('the reviewed employee cannot see it before release', () => {
    const actor = buildActor({ id: 'emp-1' });
    expect(() => requireReviewVisibility(actor, review, { released: false })).toThrow(/not.*released/i);
  });

  it('the reviewed employee can see it after release', () => {
    const actor = buildActor({ id: 'emp-1' });
    expect(() => requireReviewVisibility(actor, review, { released: true })).not.toThrow();
  });

  it('an unrelated employee is denied regardless of release state', () => {
    const actor = buildActor({ id: 'someone-else' });
    expect(() => requireReviewVisibility(actor, review, { released: true })).toThrow(/no_review_access|access/i);
  });
});

describe('requireReleasedReviewAccess', () => {
  it('denies a non-owner even if released', () => {
    const actor = buildActor({ id: 'emp-x' });
    expect(() => requireReleasedReviewAccess(actor, 'emp-y', true)).toThrow(AuthorizationError);
  });

  it('denies the owner when not released', () => {
    const actor = buildActor({ id: 'emp-x' });
    expect(() => requireReleasedReviewAccess(actor, 'emp-x', false)).toThrow(/not.*released/i);
  });

  it('allows the owner once released', () => {
    const actor = buildActor({ id: 'emp-x' });
    expect(() => requireReleasedReviewAccess(actor, 'emp-x', true)).not.toThrow();
  });
});
