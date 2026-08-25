# Web Console

The People-admin console: a Vite/React SPA (`web/`) served from `web/dist` by the same Express
process that runs the Slack integration, behind Slack-based authentication and a JSON API under
`/api/console`.

## Authentication

"Sign in with Slack" (OpenID Connect), hand-rolled in `src/web/slackOidc.ts` — no third-party OIDC
client library, so the flow is small and auditable:

1. `GET /auth/slack/login` (`src/web/authRoutes.ts`) generates `state`, `nonce`, and a PKCE
   verifier/challenge pair, stashes them in a short-lived signed cookie (`src/web/oauthState.ts`,
   5-minute expiry), and redirects to Slack's authorize endpoint.
2. `GET /auth/slack/callback` reads back the stashed state, exchanges the code for an `id_token`
   (`exchangeCodeForClaims`), verifies it against Slack's published JWKS (issuer, audience, nonce,
   workspace/team ID when `SLACK_WORKSPACE_ID` is set, `email_verified`), and resolves the claimed
   email to an `Employee` via `resolveWebActor`. **Only People admins can complete login** — a
   valid Slack identity that isn't a People admin gets a 403, not a session.
3. On success, `establishSession` (`src/web/session.ts`) writes two cookies: `pr_session`
   (`httpOnly`, `secure` in production, `sameSite=lax`, HMAC-signed, 12h) pointing at a
   `WebSession` row in DynamoDB (`src/db/webSessions.ts`), and `pr_csrf` (readable by JS, same
   flags minus `httpOnly`) for double-submit CSRF.
4. Every request re-resolves the actor from the session (`attachActor` in `authMiddleware.ts`) —
   nothing about role/identity is trusted from the browser itself.
5. `POST /auth/logout` deletes the DynamoDB session row and clears both cookies.

**CSRF**: `requireCsrf` (mounted on the whole `/api/console` router) rejects any non-GET/HEAD/OPTIONS
request whose `X-CSRF-Token` header doesn't match the `pr_csrf` cookie
(`src/web/session.ts#verifyCsrf`).

**Dev escape hatch**: `WEB_AUTH_DISABLED_INSECURE=true` lets `attachActor` resolve the actor from
an `X-Dev-Actor-Email` request header instead of a real session. `src/config.ts` makes this
impossible to enable in production (`isProduction` forces the real auth path regardless of the
env var), and it defaults to resolving `PRIMARY_APPROVER_EMAIL` if no header is sent, purely for
local development convenience.

## Pages (`web/src`)

The SPA is built around `AuthContext` (`web/src/AuthContext.tsx`), which calls `GET
/api/console/me` on load and gates every route on `authenticated`. Pages call the typed client in
`web/src/api.ts`, which attaches `X-CSRF-Token` automatically on mutating requests.

- **Dashboard** — active cycle, phase, completion counts, and every queue depth (People-review
  waiting, Primary-approval waiting, At Risk waiting, ready-for-release, released-unacknowledged,
  failed jobs) from `GET /api/console/dashboard`.
- **Employee Directory** — current roster, CSV dry-run/commit import with a validation report.
- **Cycle Management** — create/configure cycles (deadlines, prompts, max peers), start/advance/
  cancel/close (sensitive transitions require the Primary Approver — enforced server-side, not
  just hidden in the UI).
- **Review Queue** — `GET /api/console/cycles/:cycleId/reviews`, filterable to At Risk only.
- **Review Detail** — self-reflection, named peer feedback, manager review, version history,
  People notes, approvals, release/acknowledgement status, and audit events for one employee.
- **At Risk Queue** — the same review-detail data filtered to `status === 'at_risk'`; approval
  there is still gated by `requirePrimaryApproverMiddleware` like any other approval.
- **Upward Feedback** — managers with eligible submissions, respondent counts and the
  <3-respondent warning, raw (anonymized) submissions, AI-assisted draft summary, and the release
  form (mode + selected comments + override reason when required).
- **Reminders** — preview recipients/message per type, then send (with an exclude list) or defer
  to the daily automatic run.
- **Exports** — CSV downloads for completion, employee directory, review status, upward-feedback
  admin report, audit report, plus a per-employee final-packet JSON view.
- **Audit** — searchable by actor or by entity type + entity ID, filterable by cycle/action/date.
- **Operations** — pending/processing/failed/dead-letter outbox jobs, with a retry action for
  dead-letter jobs.

## API reference

All routes below are mounted under `/api/console` (`src/api/console/index.ts`) and require an
authenticated **People Administrator** session at minimum (`requirePeopleAdminMiddleware` on the
whole router); routes marked **PA** additionally require the **Primary Approver**
(`requirePrimaryApproverMiddleware`). Mutating routes also require a valid CSRF token.

| Method | Path                                                        | Purpose                                                                                                                     |
| ------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/me`                                                       | Current session's employee + roles (mounted at the app root, not under `/api/console`, but is the console's identity check) |
| GET    | `/dashboard`                                                | Cycle summary, completion, queue depths                                                                                     |
| GET    | `/directory/employees`                                      | Full employee directory                                                                                                     |
| GET    | `/directory/imports`                                        | Directory import history                                                                                                    |
| POST   | `/directory/import/dry-run`                                 | Validate a CSV upload without writing                                                                                       |
| POST   | `/directory/import/commit`                                  | Commit a CSV import (`authoritative=true&confirm=true` required to deactivate missing employees)                            |
| GET    | `/cycles`                                                   | List cycles                                                                                                                 |
| GET    | `/cycles/:id`                                               | One cycle                                                                                                                   |
| GET    | `/cycles/:id/eligible-population`                           | Active-employee count/preview for a cycle                                                                                   |
| POST   | `/cycles`                                                   | Create a draft cycle                                                                                                        |
| PATCH  | `/cycles/:id/config`                                        | Update name/timezone/deadlines/prompts/max peers                                                                            |
| POST   | `/cycles/:id/transition`                                    | Change `CycleStatus` — **PA** for `collecting_feedback`, `cancelled`, `closed`                                              |
| GET    | `/cycles/:cycleId/reviews`                                  | Review queue (optional `?at_risk=true`)                                                                                     |
| GET    | `/cycles/:cycleId/reviews/:employeeId`                      | Full review detail                                                                                                          |
| POST   | `/cycles/:cycleId/reviews/:employeeId/notes`                | Add an internal People note                                                                                                 |
| POST   | `/cycles/:cycleId/reviews/:employeeId/begin-review`         | Mark People review in progress                                                                                              |
| POST   | `/cycles/:cycleId/reviews/:employeeId/return`               | Return to manager with a reason                                                                                             |
| POST   | `/cycles/:cycleId/reviews/:employeeId/complete`             | Mark People review complete                                                                                                 |
| POST   | `/cycles/:cycleId/reviews/:employeeId/recommend`            | Recommend approval (does not approve/release)                                                                               |
| POST   | `/cycles/:cycleId/reviews/:employeeId/approve`              | **PA** — approve (incl. At Risk)                                                                                            |
| POST   | `/cycles/:cycleId/reviews/:employeeId/release`              | **PA** — release one review                                                                                                 |
| POST   | `/cycles/:cycleId/reviews/bulk-release`                     | **PA** — release many (At Risk always excluded)                                                                             |
| GET    | `/cycles/:cycleId/upward-feedback`                          | Managers with eligible submissions + threshold flags                                                                        |
| GET    | `/cycles/:cycleId/upward-feedback/:managerId/raw`           | Anonymized raw submissions (People-only)                                                                                    |
| POST   | `/cycles/:cycleId/upward-feedback/:managerId/draft-summary` | AI-assisted editable draft (never auto-released)                                                                            |
| POST   | `/cycles/:cycleId/upward-feedback/:managerId/release`       | **PA** — release (mode + override reason if `<3` respondents)                                                               |
| GET    | `/cycles/:cycleId/reminders/:type/preview`                  | Recipients + message preview                                                                                                |
| POST   | `/cycles/:cycleId/reminders/:type/send`                     | Send (with exclude list)                                                                                                    |
| GET    | `/audit`                                                    | Search audit events                                                                                                         |
| GET    | `/operations/jobs`                                          | Pending/processing/failed/dead-letter outbox jobs                                                                           |
| POST   | `/operations/jobs/:id/retry`                                | Retry a dead-letter job                                                                                                     |
| GET    | `/cycles/:cycleId/exports/completion-report.csv`            | Completion CSV                                                                                                              |
| GET    | `/exports/employee-directory.csv`                           | Directory CSV                                                                                                               |
| GET    | `/cycles/:cycleId/exports/review-status.csv`                | Review-status CSV                                                                                                           |
| GET    | `/cycles/:cycleId/exports/upward-feedback-admin.csv`        | Upward-feedback admin CSV                                                                                                   |
| GET    | `/employees/:employeeId/final-packet`                       | Employee-visible document set (JSON)                                                                                        |
| GET    | `/exports/audit-report.csv`                                 | Audit CSV                                                                                                                   |

Auth routes (not under `/api/console`, no CSRF/People-admin gate since they establish the
session): `GET /auth/slack/login`, `GET /auth/slack/callback`, `POST /auth/logout`.

The separate, disabled-by-default automation API (`/automation/*`, token-authenticated, no
approval/release routes) is documented in `docs/SECURITY.md`.
