# Permissions

All authorization lives in `src/domain/authz.ts` and is re-checked server-side on every sensitive
read/write — Slack action values, modal `private_metadata`, URL/query params, and browser request
bodies are all treated as untrusted input, used only to look records up, never trusted as proof of
identity or relationship.

## Roles

- **Employee** — every active `Employee` record. Base role; everyone else is additionally this.
- **Manager** — an employee with at least one current direct report (`Employee.manager_id`
  pointing at them). Not a stored flag; derived by querying `getDirectReports`/`manager_id` fresh
  each time.
- **People Administrator** — `Employee.is_people_admin === true`, or listed in the
  `PEOPLE_ADMIN_EMAILS` config allowlist (`computeRoles` in `authz.ts`).
- **Primary Approver** — computed, never stored: authenticated email equals
  `config.people.primaryApproverEmail` (from `PRIMARY_APPROVER_EMAIL`) **and** that same employee
  is also a People Administrator. See `docs/PRIMARY_APPROVER.md`.

## Authorization helpers (`src/domain/authz.ts`)

| Function                                                       | Checks                                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveSlackActor(slackUserId)`                               | Untrusted Slack user ID → live `Employee` + `ActorRoles`, or `null`                                                                                             |
| `resolveWebActor(email)`                                       | Untrusted OIDC email claim → live `Employee` + `ActorRoles`, or `null`                                                                                          |
| `requireActiveEmployee(actor)`                                 | Actor exists and `status === 'active'`                                                                                                                          |
| `requirePeopleAdmin(actor)`                                    | Active employee + `roles.isPeopleAdmin`                                                                                                                         |
| `requirePrimaryApprover(actor)`                                | Active employee + `roles.isPrimaryApprover`; also throws if no `PRIMARY_APPROVER_EMAIL` is configured at all (fail closed, never "any People admin")            |
| `requireCurrentManagerRelationship(managerId, employeeId)`     | Re-fetches the employee by ID and checks `employee.manager_id === managerId` **right now** — never trusts a manager/employee pairing carried in a Slack payload |
| `requireManagerOfEmployee(actor, employee)`                    | Same check when the employee record is already in hand                                                                                                          |
| `requirePeerRequestOwner(actor, request)`                      | `request.requester_id === actor.employee.id`                                                                                                                    |
| `requirePeerRequestRecipient(actor, request)`                  | `request.peer_id === actor.employee.id`                                                                                                                         |
| `requireSubmissionOwner(actor, ownerEmployeeId)`               | Generic "this is your own submission" check                                                                                                                     |
| `requireReviewVisibility(actor, review, opts)`                 | People admins: always; manager: always (their own authored review); employee: only once released                                                                |
| `requireReleasedReviewAccess(actor, employeeId, released)`     | Submission-owner check + released-only gate, used by the Slack view/acknowledge flows                                                                           |
| `requireApprovalPermission` / `requireUpwardReleasePermission` | Aliases of `requirePrimaryApprover`                                                                                                                             |

`requireCyclePhase` (a related check, but phase- not identity-based) lives in
`src/domain/cycleStateMachine.ts` and gates actions by the cycle's current `CycleStatus`.

## Who can do what

| Action                                                                                                         | Employee                                         | Manager                   | People Admin                   | Primary Approver                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| Save/submit own self-reflection                                                                                | ✅                                               | ✅ (as employee)          | ✅ (as employee)               | ✅ (as employee)                                                          |
| See own peer-feedback author identity                                                                          | ❌                                               | ❌                        | —                              | —                                                                         |
| Accept/decline/submit own peer request                                                                         | ✅ (recipient only)                              | ✅                        | ✅                             | ✅                                                                        |
| Submit upward feedback about current manager                                                                   | ✅                                               | —                         | —                              | —                                                                         |
| See raw upward feedback                                                                                        | ❌                                               | ❌ (never, even released) | ✅ (People-only view)          | ✅                                                                        |
| Write/save/return a manager review for a _current_ direct report                                               | —                                                | ✅                        | — (recommend only, not author) | —                                                                         |
| See a review before release                                                                                    | ❌ (unless it's their own submission as manager) | ✅ (own authored reviews) | ✅                             | ✅                                                                        |
| Add a People note / return to manager / mark People review complete                                            | ❌                                               | ❌                        | ✅                             | ✅                                                                        |
| Recommend approval                                                                                             | ❌                                               | ❌                        | ✅                             | ✅                                                                        |
| **Approve** a review (incl. At Risk)                                                                           | ❌                                               | ❌                        | ❌                             | ✅ only                                                                   |
| **Release** a review (single or bulk)                                                                          | ❌                                               | ❌                        | ❌                             | ✅ only                                                                   |
| **Release** upward feedback (any mode)                                                                         | ❌                                               | ❌                        | ❌ (prepare/draft only)        | ✅ only                                                                   |
| Override the <3-respondent upward-feedback warning                                                             | ❌                                               | ❌                        | ❌                             | ✅ only                                                                   |
| Start / cancel / close a live cycle                                                                            | ❌                                               | ❌                        | ❌                             | ✅ only                                                                   |
| Reopen a finalized self-reflection                                                                             | ❌                                               | ❌                        | ❌                             | ✅ only (not yet exposed in console UI — see `docs/GO_LIVE_CHECKLIST.md`) |
| Import/validate directory, configure draft cycles, send routine reminders, view queues/audit, generate reports | ❌                                               | ❌                        | ✅                             | ✅                                                                        |
| Grant themselves Primary Approver                                                                              | ❌                                               | ❌                        | ❌ (no such feature exists)    | n/a                                                                       |

Enforcement points: Slack handlers call the `require*` functions directly; console API routes
enforce via `src/web/authMiddleware.ts`'s `requireConsoleSession` (any authenticated console user),
`requirePeopleAdminMiddleware` (mounted on the whole `/api/console` router in
`src/api/console/index.ts` — every console route requires People Admin at minimum), and
`requirePrimaryApproverMiddleware` (mounted per-route on `/approve`, `/release`, `/bulk-release`,
upward-feedback `/release`, and the sensitive cycle transitions in `src/api/console/cycles.ts`).
