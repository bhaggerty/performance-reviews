# FINISH_PLAN — Performance Reviews Productionization

Status date: 2026-08-19. This document is updated as work lands; see the Definition-of-Done
matrix at the end for current pass/fail/blocked status per requirement.

## 1. Current architecture (as found)

- Single Node.js/TypeScript service: Express (`src/index.ts`) hosting a Slack Bolt `App` via
  `ExpressReceiver` (`src/slack/app.ts`), plus an `/admin` router (`src/api/admin.ts`).
- DynamoDB single-table design (`src/db/schema.md`) with a bare `docClient` wrapper
  (`src/db/client.ts`) and one file per entity (`employees.ts`, `cycles.ts`, `reviews.ts`,
  `peerFeedback.ts`, `upwardFeedback.ts`, `documents.ts`, `audit.ts`). No transactions,
  no conditional writes, several `Scan` fallbacks, no pagination anywhere (`Items` is
  read as a single page and never follows `LastEvaluatedKey`).
- Document generation (`src/services/documents.ts`) renders plain-text snapshots, stores a
  canonical copy in DynamoDB, and optionally mirrors to S3 or a webhook (Google Apps Script).
- AI coach (`src/services/reviewCoach.ts`) is OpenAI-only, called synchronously from inside
  Slack view-submission handlers, and can run **before** `ack()` returns in the no-follow-up
  path only because `ack()` is called after the coach call completes — i.e. it **does**
  block `ack()` today.
- Slack flows: manager review decision tree (`managerReview.ts`), peer feedback
  (`peerFeedback.ts`), upward feedback (`upwardFeedback.ts`), acknowledge/view
  (`acknowledge.ts`), App Home (`home.ts`).
- No web console, no build tooling for a frontend, no auth layer beyond a static
  `ADMIN_SECRET` bearer/query-param check in `src/api/admin.ts`.
- No test files anywhere in the repo. No ESLint config (lint currently fails outright —
  see below). No CI workflows. No Union Station files of any kind exist in this repo or
  were discoverable — see the Union Station section below.

Verified tool results before making any change:

- `git status` → clean, `git log --oneline -10` → 8 commits, most recent
  `424a978 Add AI follow-up coaching for sparse reviews`.
- `npm ci` → succeeds (504 packages).
- `npm run build` (`tsc`) → **succeeds**, no compile errors.
- `npm run lint` → **fails**: no ESLint config file exists despite the `lint` script
  and `@typescript-eslint/*` devDependencies being present.
- `npm audit` → 21 vulnerabilities (16 high, 5 moderate), all inside
  `@typescript-eslint/*` 6.x and its transitive `minimatch`/`fast-xml-parser` chain —
  devDependency/tooling only, not runtime AWS SDK code paths. Fix requires a major
  version bump (6.x → 8.x) which also requires an ESLint flat config; both are done
  together in this pass (`npm audit fix --force` was intentionally **not** run; the
  upgrade is explicit and reviewed instead).

## 2. Confirmed defects (verified against source, not assumed)

All items below were confirmed by reading the file in question before this plan was written.

| #   | Defect                                                            | File                                                                                                                                                                       | Verified behavior                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Self-reflection is a placeholder                                  | `src/index.ts:67-88`                                                                                                                                                       | `self_reflection` action opens a static modal with no inputs, no submit, no persistence.                                                                                                                                                                                                                                                                 |
| 2   | No self-reflection entity/table access at all                     | `src/types.ts`, `src/db/*`                                                                                                                                                 | No `SelfReflection` type or repo exists.                                                                                                                                                                                                                                                                                                                 |
| 3   | Ack records before optional comment is collected                  | `src/slack/acknowledge.ts:89-99`                                                                                                                                           | `acknowledgeReview()` (which sets `acknowledged_at`) is called _before_ the comment modal is even shown; the comment collected in the second modal is never persisted anywhere.                                                                                                                                                                          |
| 4   | `ack_done` has no registered handler                              | `src/index.ts`, `src/slack/acknowledge.ts:129-134`                                                                                                                         | The second modal's button has `action_id: 'ack_done'`; no `slackApp.action('ack_done', ...)` exists anywhere, so clicking it does nothing and the comment is lost.                                                                                                                                                                                       |
| 5   | Socket Mode vars exist but unused                                 | `src/config.ts:5-6`, `src/slack/app.ts`                                                                                                                                    | `appToken`/`useSocketMode` are read into config but `App` is always constructed with an `ExpressReceiver`; Socket Mode is never actually enabled.                                                                                                                                                                                                        |
| 6   | Admin API fails **open** with no secret                           | `src/api/admin.ts:9-15`                                                                                                                                                    | `if (!ADMIN_SECRET) return true;` — with no `ADMIN_SECRET` env var, every admin route is unauthenticated.                                                                                                                                                                                                                                                |
| 7   | Admin secret accepted via query string                            | `src/api/admin.ts:13`                                                                                                                                                      | `req.query.secret` is accepted as a credential.                                                                                                                                                                                                                                                                                                          |
| 8   | Slack action values / `private_metadata` trusted as authorization | `managerReview.ts`, `peerFeedback.ts`, `upwardFeedback.ts` (throughout)                                                                                                    | `employee_id`, `manager_id`, `cycle_id`, `peer_id`, `request_id` all come from `private_metadata` or button `value` set by a prior (client-controlled) render step and are used directly in writes with no server-side re-derivation.                                                                                                                    |
| 9   | Manager submit doesn't recheck current management                 | `managerReview.ts:537-620`                                                                                                                                                 | `handleManagerReviewSubmit` trusts `employee_id` from metadata; never re-queries `getDirectReports(manager.id)` to confirm the target is _currently_ a report.                                                                                                                                                                                           |
| 10  | Peer accept/decline/submit don't re-authorize actor               | `peerFeedback.ts:301-425`                                                                                                                                                  | `handlePeerAccept`/`handlePeerDecline`/`handlePeerFeedbackSubmit` act on `request.peer_id` without checking that the clicking Slack user resolves to that same employee.                                                                                                                                                                                 |
| 11  | Upward feedback doesn't re-resolve manager                        | `upwardFeedback.ts:223-309`                                                                                                                                                | Manager/employee IDs come from modal metadata set at open time; no re-check that the manager is still current at submit time.                                                                                                                                                                                                                            |
| 12  | AI can run before `ack()`                                         | `managerReview.ts:559-601`, `peerFeedback.ts:364-398`, `upwardFeedback.ts:247-281`                                                                                         | `maybeGenerateFollowupQuestions` (network call, up to `OPENAI_TIMEOUT_MS`) is awaited **before** `args.ack()` in the no-follow-up branch.                                                                                                                                                                                                                |
| 13  | Employee "upsert" always creates a new ID                         | `src/db/employees.ts:143-161`                                                                                                                                              | `upsertEmployee` unconditionally calls `randomUUID()`; there is no lookup-then-update path.                                                                                                                                                                                                                                                              |
| 14  | CSV "updates" don't update fields                                 | `src/api/admin.ts:87-92`                                                                                                                                                   | When `getEmployeeBySlackId` finds an existing row, the importer only records it as "updated" and **skips writing** any new name/email/department — nothing is actually updated except `manager_id` in the second pass.                                                                                                                                   |
| 15  | Importer keys off `slack_id`, not email                           | `src/api/admin.ts:87`                                                                                                                                                      | Existing-employee lookup uses `getEmployeeBySlackId`, so a row with no `slack_id` (the common case for a fresh CSV) always creates a duplicate employee even if the email already exists.                                                                                                                                                                |
| 16  | No normalized-email uniqueness                                    | `src/db/employees.ts`                                                                                                                                                      | No email index, no conditional-write uniqueness check anywhere.                                                                                                                                                                                                                                                                                          |
| 17  | No directory validation                                           | `src/api/admin.ts`                                                                                                                                                         | No checks for duplicate emails, duplicate Slack IDs, unknown managers, self-management, or management cycles.                                                                                                                                                                                                                                            |
| 18  | Multiple cycles can be `open`                                     | `src/db/cycles.ts:90-102`                                                                                                                                                  | `updateCycleStatus` is an unconditional `Put`; nothing enforces at most one active cycle.                                                                                                                                                                                                                                                                |
| 19  | No explicit cycle state machine                                   | `src/types.ts:20`, `src/db/cycles.ts`                                                                                                                                      | Only `draft/open/closed`; any status can be set to any other status with no transition table.                                                                                                                                                                                                                                                            |
| 20  | No pagination anywhere                                            | every `db/*.ts`                                                                                                                                                            | Every `QueryCommand`/`ScanCommand` reads `.Items` once; `LastEvaluatedKey` is never followed.                                                                                                                                                                                                                                                            |
| 21  | User-facing paths rely on scans                                   | `src/db/employees.ts` (`listEmployees`), `src/db/reviews.ts` (`getReviewsAuthoredByManager`), `src/db/documents.ts` (`listDocumentsAuthoredBy`), CSV import fallback paths | Confirmed `ScanCommand` usage on hot paths.                                                                                                                                                                                                                                                                                                              |
| 22  | Final records overwritten by unconditional writes                 | `src/db/reviews.ts` (`saveManagerReview`, `acknowledgeReview`), `src/db/peerFeedback.ts`, `src/db/upwardFeedback.ts`                                                       | All writes are plain `PutCommand` with no `ConditionExpression`; a duplicate Slack view-submission retry silently creates a second row with a new random `id` (peer feedback / upward feedback) or clobbers the existing one (manager review has a fixed SK so a resubmit fully overwrites the prior submitted review, including its `acknowledged_at`). |
| 23  | Duplicate Slack deliveries can duplicate side effects             | all `view()`/`action()` handlers                                                                                                                                           | No idempotency key store exists; Bolt's own retry-of-3xx handling plus Slack's at-least-once delivery means a slow handler can be invoked twice.                                                                                                                                                                                                         |
| 24  | Peer selection capped at first 100                                | `peerFeedback.ts:22, 182-192`                                                                                                                                              | `MAX_EMPLOYEES_IN_DROPDOWN`/`.slice(0, 100)` in both manager-review employee picker and peer picker; `multi_static_select` also has Slack's own 100-option hard limit, so this needs an external (searchable) select.                                                                                                                                    |
| 25  | Accepted peer request has no resume path                          | `peerFeedback.ts:301-332`                                                                                                                                                  | `handlePeerAccept` opens a modal; if the user closes it, there is no App Home entry point or state that lets them reopen the same accepted request.                                                                                                                                                                                                      |
| 26  | App Home conflates statuses                                       | `src/slack/home.ts:62-63`                                                                                                                                                  | `myReview` (a `ManagerReview`, i.e. the review _received_) is used to show "My Review · Submitted/Pending" — self-reflection status isn't tracked at all because the entity doesn't exist.                                                                                                                                                               |
| 27  | Peer/upward feedback not represented in Home                      | `src/slack/home.ts`                                                                                                                                                        | Home tab never queries `getPeerRequest`s or renders peer/upward completion state.                                                                                                                                                                                                                                                                        |
| 28  | Employee notified at manager submit, not at release               | `managerReview.ts:631-663`                                                                                                                                                 | `chat.postMessage` to the employee happens immediately inside `handleManagerReviewSubmit`, with no People-review/approval gate at all.                                                                                                                                                                                                                   |
| 29  | No retry for notifications/documents                              | `services/documents.ts:154-160`, `managerReview.ts:667-670`                                                                                                                | Archive failures are caught and logged; there is no outbox, no retry, no dead-letter visibility.                                                                                                                                                                                                                                                         |
| 30  | Direct S3 URL construction                                        | `services/documents.ts:100-104`                                                                                                                                            | `archiveUrl` is a hand-built public-style `https://{bucket}.s3.{region}.amazonaws.com/...` URL, not a presigned URL, and the bucket is expected to be private — this URL will simply 403 in practice and must never be surfaced as clickable.                                                                                                            |
| 31  | Archive filename collisions                                       | `services/documents.ts:246-250`                                                                                                                                            | Filename is `{employeeFolder}-manager-review-{yyyy-MM-dd}.txt` with day granularity; two submissions for the same employee/type/day collide.                                                                                                                                                                                                             |
| 32  | Webhook secret in body                                            | `services/documents.ts:113-127`                                                                                                                                            | `shared_secret` is sent both as an `Authorization` header **and** duplicated into the JSON body.                                                                                                                                                                                                                                                         |
| 33  | No audit query support                                            | `src/db/audit.ts`                                                                                                                                                          | `logAudit` only writes; there is no `listAudit`/query function and no GSI projection for audit at all (PK is random `AUDIT#<uuid>`, unqueryable except by full scan).                                                                                                                                                                                    |
| 34  | No reminder engine                                                | repo-wide                                                                                                                                                                  | Confirmed: no cron, no scheduled-task script, no reminder types.                                                                                                                                                                                                                                                                                         |
| 35  | No admin workflow beyond CRUD                                     | `src/api/admin.ts`                                                                                                                                                         | Confirmed: cycles + CSV only, no review queue, no approval, no release.                                                                                                                                                                                                                                                                                  |
| 36  | No tests                                                          | repo-wide                                                                                                                                                                  | Confirmed: zero test files, no test runner configured.                                                                                                                                                                                                                                                                                                   |
| 37  | No migration framework / local DynamoDB                           | repo-wide                                                                                                                                                                  | Confirmed: only ad hoc `scripts/create-table.js`/`check-table.js`.                                                                                                                                                                                                                                                                                       |
| 38  | No Slack manifest                                                 | repo-wide                                                                                                                                                                  | Confirmed.                                                                                                                                                                                                                                                                                                                                               |
| 39  | No env validation at startup                                      | `src/config.ts`                                                                                                                                                            | Confirmed: every value defaults silently (`?? ''`), nothing throws on missing Slack/AWS config.                                                                                                                                                                                                                                                          |
| 40  | Health checks don't distinguish liveness/readiness                | `src/index.ts:34-36`                                                                                                                                                       | Confirmed: single `/health` returns `{ok:true}` unconditionally, no dependency checks.                                                                                                                                                                                                                                                                   |
| 41  | No graceful shutdown                                              | `src/index.ts`                                                                                                                                                             | Confirmed: no `SIGTERM`/`SIGINT` handlers.                                                                                                                                                                                                                                                                                                               |

## 3. Security risks (beyond the numbered defects above)

- Fail-open admin auth (#6) and query-string credential (#7) are the most severe — both are
  fixed by removing the legacy admin API's authority entirely (see §6) rather than patching it.
- No CSRF protection anywhere (there was no cookie-based session to protect before this pass).
- No structured logging redaction — `console.error` calls throughout print raw error objects
  that can include SDK request bodies.
- No rate limiting on any HTTP route.
- No Content-Security-Policy / security headers.
- S3 bucket policy/ACL is not declared in-repo at all; nothing enforces "block public access"
  from application code (this is an infra-level control — flagged for the Union Station/AWS
  section of the go-live checklist, not something the app process can itself guarantee).

## 4. Product gaps (relative to the confirmed requirements in the assignment)

Self-reflection persistence and workflow; peer-request lifecycle states beyond
pending/accepted/declined; upward-feedback release as a separate, versioned, Primary-Approver
gated entity; People-review queue, return-to-manager, recommend-approval,
approve/release split; At Risk approval queue; acknowledgement as its own append-only entity;
web console (entirely absent); Primary Approver role and enforcement (entirely absent — there
is no user/session concept at all today); AI provider abstraction (today hard-wired to
OpenAI only, and only for the "coach" nudge, not configurable/disableable in the way specified);
Union Station deployment artifacts (none exist); reminder engine (none exists); outbox/job
system (none exists); directory-import adapter interface (none exists).

## 5. Union Station — investigated, not found

Per the operating rules, existing Union Station conventions were inspected before writing any
deployment file. There are: no Union Station files in this repository (`git log`/tree confirm
this), no internal documentation reachable from this environment, and the only "C1" docs source
connected to this session (the C1 Docs MCP server) is ConductorOne's public _product_
documentation (SaaS/identity governance for end customers) — unrelated to an internal Union
Station deployment platform. There is no CI, Terraform, or CDK in this repo to defer to either.

Given operating rule #9 ("only classify work as externally blocked when it truly requires ...
access to an internal system that is unavailable"), Union Station itself is correctly
externally blocked: I cannot inspect its actual manifest schema, validation CLI, or secret
mechanism. To avoid inventing unsupported syntax, `docs/UNION_STATION_DEPLOYMENT.md` documents
this gap explicitly and ships a **clearly-labeled, standards-based ECS Fargate reference**
(task definition shape, health check wiring, secrets-from-Secrets-Manager wiring, scheduled
task wiring for reminders/jobs) that a Union Station owner can map onto the real platform
convention in one pass, rather than a fake `union-station.yml` presented as if it were real.
`npm run union-station:validate` is implemented as a local structural lint of that reference
file (JSON schema shape, required env vars present, no plaintext secrets) — it validates our
own inferred file, not real Union Station policy, and the docs say so.

## 6. Data model changes

New/changed DynamoDB entities (all versioned with `schema_version`, all writes conditional
where uniqueness or a lifecycle transition matters): `Employee`, `EmployeeIdentity` (email→id
and slack_id→id uniqueness records), `ReviewCycle` (explicit state machine + configurable
deadlines), `SelfReflection`, `PeerRequest` (expanded states), `PeerFeedback`, `UpwardFeedback`,
`UpwardFeedbackRelease` (new, versioned, separate from the raw submission), `ManagerReview`
(versioned, return-to-manager preserves prior versions), `PeopleReview` (new — the People
queue/notes/return/recommend state), `Approval` (new — records recommend/approve actions
distinctly from release), `ReviewRelease` (new), `Acknowledgement` (new, append-only, separate
from `ManagerReview`), `Document`, `AuditEvent` (now queryable via GSI3 by actor/entity/cycle),
`OutboxJob` (new), `IdempotencyRecord` (new), `DirectoryImport` (new, summary only — no raw CSV
retained), `NotificationRecord` (new), `WebSession`/`WebUser` (new, for console auth), all
under `src/db/`, `src/domain/` (state machine + authz), `src/jobs/`.

See `docs/DATA_MODEL.md` for full key design and `docs/MIGRATIONS.md` for the migration script
and dry-run procedure from the current shape.

## 7. Web-console architecture

Vite + React + TypeScript SPA at `web/`, built to `web/dist` and served as static files by the
same Express service (`GET /console/*`) behind session auth — no second deployable, per the
assignment's preference to avoid overengineering. Auth: Slack "Sign in with Slack" (OpenID
Connect) restricted to the configured workspace, since no Union Station SSO convention was
discoverable (see §5); server-side session cookie (`httpOnly`, `secure` in production,
`sameSite=lax`), CSRF double-submit token on all mutating `/api/console/*` routes,
`requirePeopleAdmin`/`requirePrimaryApprover` enforced again on every handler regardless of
what the client renders.

## 8. Migration approach

`scripts/migrate.ts` is additive-only against the existing single table (new item types, new
GSI3 for audit/idempotency), runs in `--dry-run` by default, and is idempotent (safe to re-run).
No destructive migration is required because no shape changes to existing entities are
destructive — new fields are additive. See `docs/MIGRATIONS.md`.

## 9. Implementation phases (this pass)

1. Foundations: config validation (Zod), structured logger, health/readiness, graceful
   shutdown, ESLint flat config + ts upgrade, jest test harness.
2. Domain layer: entities, cycle state machine, centralized authorization module.
3. Data layer rewrite: pagination, conditional writes/transactions, new repositories.
4. CSV directory import + adapter interface + validation + dry-run/commit.
5. Slack correctness: self-reflection, acknowledgement rewrite incl. `ack_done`, re-auth on
   every sensitive handler, Socket Mode fix, mrkdwn escaping, external peer select, DM helper.
6. AI provider interface (Noop/Anthropic/OpenAI) decoupled from Slack handlers via outbox.
7. Outbox/job engine + reminders.
8. People-review / approval / release / upward-feedback-release workflow + Primary Approver.
9. Web console (auth, API routes, pages).
10. Tests (unit, integration, Slack, web).
11. Docs, Slack manifest, sample CSV, Union Station reference, CI.
12. Validation pass (`npm run validate`), final report.

## 10. Definition-of-done matrix

Maintained and filled in at the end of the pass — see the final chat response for the
authoritative, up-to-date table (Pass / Fail / Externally blocked per requirement). This file
will not be re-stated with a duplicate table to avoid drift between the two.
