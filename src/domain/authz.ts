import { config } from '../config';
import { getEmployeeById, getEmployeeBySlackId, getEmployeeByEmail } from '../db/employees';
import type { Actor, ActorRoles, Employee, PeerRequest } from '../types';

export class AuthorizationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

function deny(code: string, message: string): never {
  throw new AuthorizationError(code, message);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function computeRoles(employee: Employee): ActorRoles {
  const email = normalizeEmail(employee.email);
  const isPeopleAdmin = employee.is_people_admin || config.people.peopleAdminEmails.has(email);
  const isPrimaryApprover = Boolean(
    config.people.primaryApproverEmail && email === config.people.primaryApproverEmail && isPeopleAdmin
  );
  return {
    isEmployee: true,
    isPeopleAdmin,
    isPrimaryApprover,
  };
}

function toActor(employee: Employee): Actor {
  return { employee, roles: computeRoles(employee) };
}

/** Untrusted input: a Slack user ID from an event/action/view payload. Always re-resolved here. */
export async function resolveSlackActor(slackUserId: string | undefined | null): Promise<Actor | null> {
  if (!slackUserId) return null;
  const employee = await getEmployeeBySlackId(slackUserId);
  if (!employee) return null;
  return toActor(employee);
}

/** Untrusted input: an authenticated email claim from the web console's OIDC session. */
export async function resolveWebActor(email: string | undefined | null): Promise<Actor | null> {
  if (!email) return null;
  const employee = await getEmployeeByEmail(normalizeEmail(email));
  if (!employee) return null;
  return toActor(employee);
}

export function requireActiveEmployee(actor: Actor | null): asserts actor is Actor {
  if (!actor) deny('not_an_employee', 'This Slack/web identity does not map to an active employee.');
  if (actor.employee.status !== 'active') {
    deny('inactive_employee', 'This employee is not active.');
  }
}

export function requirePeopleAdmin(actor: Actor | null): asserts actor is Actor {
  requireActiveEmployee(actor);
  if (!actor.roles.isPeopleAdmin) deny('not_people_admin', 'Requires a People administrator.');
}

export function requirePrimaryApprover(actor: Actor | null): asserts actor is Actor {
  requireActiveEmployee(actor);
  if (!config.people.primaryApproverEmail) {
    deny('no_primary_approver_configured', 'No Primary Approver is configured; refusing to authorize.');
  }
  if (!actor.roles.isPrimaryApprover) deny('not_primary_approver', 'Requires the Primary Approver.');
}

/**
 * Re-derives the current manager relationship from the authoritative Employee record —
 * never trust a manager/employee id pairing carried in Slack metadata or a request body.
 */
export async function requireCurrentManagerRelationship(managerId: string, employeeId: string): Promise<Employee> {
  const employee = await getEmployeeById(employeeId);
  if (!employee) deny('employee_not_found', 'Employee not found.');
  if (employee.manager_id !== managerId) {
    deny('not_current_manager', 'You are not the current manager of this employee.');
  }
  if (employee.status !== 'active') deny('inactive_employee', 'This employee is not active.');
  return employee;
}

export function requireManagerOfEmployee(actor: Actor, employee: Employee): void {
  requireActiveEmployee(actor);
  if (employee.manager_id !== actor.employee.id) {
    deny('not_current_manager', 'You are not the current manager of this employee.');
  }
}

export function requirePeerRequestOwner(actor: Actor, request: PeerRequest): void {
  requireActiveEmployee(actor);
  if (request.requester_id !== actor.employee.id) {
    deny('not_request_owner', 'You did not create this peer request.');
  }
}

export function requirePeerRequestRecipient(actor: Actor, request: PeerRequest): void {
  requireActiveEmployee(actor);
  if (request.peer_id !== actor.employee.id) {
    deny('not_request_recipient', 'This peer request was not sent to you.');
  }
}

export function requireSubmissionOwner(actor: Actor, ownerEmployeeId: string): void {
  requireActiveEmployee(actor);
  if (actor.employee.id !== ownerEmployeeId) {
    deny('not_submission_owner', 'You do not own this submission.');
  }
}

/**
 * Employees may see their own review only after release; managers may see reviews they
 * authored while still in progress; People admins may always see it.
 */
export function requireReviewVisibility(
  actor: Actor,
  review: { employee_id: string; manager_id: string; people_state: string },
  opts: { released: boolean }
): void {
  requireActiveEmployee(actor);
  if (actor.roles.isPeopleAdmin) return;
  if (actor.employee.id === review.manager_id) return;
  if (actor.employee.id === review.employee_id) {
    if (!opts.released) deny('review_not_released', 'This review has not been released yet.');
    return;
  }
  deny('no_review_access', 'You do not have access to this review.');
}

export function requireReleasedReviewAccess(actor: Actor, employeeId: string, released: boolean): void {
  requireActiveEmployee(actor);
  requireSubmissionOwner(actor, employeeId);
  if (!released) deny('review_not_released', 'This review has not been released yet.');
}

export const requireApprovalPermission = requirePrimaryApprover;
export const requireUpwardReleasePermission = requirePrimaryApprover;
