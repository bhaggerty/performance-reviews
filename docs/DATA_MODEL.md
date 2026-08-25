# Data Model

Single DynamoDB table (`DYNAMODB_TABLE`/`APP_DYNAMODB_TABLE_NAME`), base keys `PK`/`SK`, plus
`GSI1` (`GSI1PK`/`GSI1SK`) and `GSI2` (`GSI2PK`/`GSI2SK`). This document describes the key design
**as implemented** in `src/db/*.ts` — it superseded the original design sketched during planning
(see `docs/FINISH_PLAN.md` §6), most notably by dropping a planned `GSI3` once every access
pattern was found a home on `GSI1`/`GSI2` (a DynamoDB item can populate both indexes
simultaneously; there was no need for a third).

`src/db/client.ts` provides `queryAll`/`scanAll`, which fully follow `LastEvaluatedKey` — every
query in the codebase uses one of these, so no caller has to remember to paginate. `isConditionalCheckFailed`
centralizes detecting a failed `ConditionExpression`/transaction so every conditional-write call
site can react consistently.

## Entities and keys

| Entity (file)                                | PK                                                     | SK                                                                               | GSI1                                                                                        | GSI2                                                              |
| -------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Employee (`employees.ts`)                    | `EMP#<id>`                                             | `METADATA`                                                                       | `EMPLOYEE_DIRECTORY` / `<name>#<id>` (full directory listing, no Scan)                      | `MANAGER_REPORTS#<managerId\|none>` / `EMP#<id>` (direct reports) |
| EmployeeIdentity (`identities.ts`)           | `IDENTITY#EMAIL#<email>` or `IDENTITY#SLACK#<slackId>` | `METADATA`                                                                       | —                                                                                           | —                                                                 |
| ReviewCycle (`cycles.ts`)                    | `CYCLE#<id>`                                           | `METADATA`                                                                       | `CYCLE_DIRECTORY` / `<createdAt>#<id>`                                                      | —                                                                 |
| Active-cycle lock (`cycles.ts`)              | `SYSTEM#ACTIVE_CYCLE`                                  | `METADATA`                                                                       | —                                                                                           | —                                                                 |
| SelfReflection (`selfReflections.ts`)        | `CYCLE#<cycleId>`                                      | `SELFREFLECTION#<employeeId>`                                                    | —                                                                                           | `EMP_SELF_REFLECTIONS#<employeeId>` / `CYCLE#<cycleId>`           |
| PeerRequest (`peerFeedback.ts`)              | `CYCLE#<cycleId>`                                      | `PEERREQUEST#<requesterId>#<peerId>`                                             | `PEER_RECIPIENT#<peerId>` / `<requestedAt>#<id>` (sparse — only while `pending`/`accepted`) | `PEER_REQUESTER#<requesterId>` / `<requestedAt>#<id>`             |
| PeerFeedback (`peerFeedback.ts`)             | `CYCLE#<cycleId>`                                      | `PEERFEEDBACK#<employeeId>#<peerId>`                                             | —                                                                                           | `EMP_PEER_RECEIVED#<employeeId>` / `CYCLE#<cycleId>#<id>`         |
| UpwardFeedback (`upwardFeedback.ts`)         | `CYCLE#<cycleId>`                                      | `UPWARD#<employeeId>`                                                            | —                                                                                           | `MANAGER_UPWARD#<managerId>` / `<cycleId>#<employeeId>`           |
| UpwardFeedbackRelease (`upwardFeedback.ts`)  | `CYCLE#<cycleId>`                                      | `UPWARDRELEASE#<managerId>#<paddedVersion>` (history) and `...#LATEST` (pointer) | —                                                                                           | —                                                                 |
| ManagerReview current pointer (`reviews.ts`) | `CYCLE#<cycleId>`                                      | `REVIEW#<employeeId>#CURRENT`                                                    | `MANAGER_REVIEWS#<managerId>` / `<cycleId>#<employeeId>`                                    | `EMP_REVIEW_HISTORY#<employeeId>` / `CYCLE#<cycleId>`             |
| ManagerReview version history (`reviews.ts`) | `CYCLE#<cycleId>`                                      | `REVIEWVERSION#<employeeId>#<paddedVersion>`                                     | — (deliberately excluded — see below)                                                       | —                                                                 |
| PeopleNote (`reviews.ts`)                    | `CYCLE#<cycleId>`                                      | `PEOPLENOTE#<employeeId>#<createdAt>#<id>`                                       | —                                                                                           | —                                                                 |
| Approval (`reviews.ts`)                      | `CYCLE#<cycleId>`                                      | `APPROVAL#<employeeId>#<createdAt>#<id>`                                         | —                                                                                           | —                                                                 |
| ReviewRelease (`releases.ts`)                | `CYCLE#<cycleId>`                                      | `RELEASE#<employeeId>`                                                           | —                                                                                           | `EMP_RELEASES#<employeeId>` / `CYCLE#<cycleId>`                   |
| Acknowledgement (`acknowledgements.ts`)      | `CYCLE#<cycleId>`                                      | `ACK#<employeeId>`                                                               | —                                                                                           | `EMP_ACKS#<employeeId>` / `CYCLE#<cycleId>`                       |
| Document (`documents.ts`)                    | `DOC#<sourceEntityId>#v<sourceVersion>`                | `METADATA`                                                                       | —                                                                                           | `EMP_DOCUMENTS#<employeeId>` / `<cycleId>#<type>#<createdAt>`     |
| AuditEvent (`audit.ts`)                      | `AUDIT#<id>`                                           | `METADATA`                                                                       | `AUDIT_ACTOR#<actorId>` / `<createdAt>#<id>`                                                | `AUDIT_ENTITY#<entityType>#<entityId>` / `<createdAt>#<id>`       |
| OutboxJob (`outbox.ts`)                      | `JOB#<id>`                                             | `METADATA`                                                                       | `JOB_STATUS#<status>` / `<runAfter>#<id>`                                                   | —                                                                 |
| IdempotencyRecord (`idempotency.ts`)         | `IDEMPOTENCY#<scope>`                                  | `<key>`                                                                          | —                                                                                           | —                                                                 |
| DirectoryImport (`directoryImports.ts`)      | `IMPORT#<id>`                                          | `METADATA`                                                                       | `IMPORT_HISTORY` / `<createdAt>#<id>`                                                       | —                                                                 |
| NotificationRecord (`notifications.ts`)      | `NOTIFY#<employeeId>`                                  | `<type>#<dedupeKey>`                                                             | —                                                                                           | —                                                                 |
| WebSession (`webSessions.ts`)                | `WEBSESSION#<id>`                                      | `METADATA`                                                                       | —                                                                                           | —                                                                 |

Every item shape uses a discriminator field to distinguish item kinds within a partition — named
`record_type` on `Document`/`OutboxJob` specifically (their domain objects already have their own
`type` field with unrelated meaning, e.g. `DocumentType`/`OutboxJobType`, so a second `type` key
would silently collide); every other entity's discriminator is simply named `type`.

## Why the manager-review CURRENT/VERSION split

`REVIEW#<employeeId>#CURRENT` and `REVIEWVERSION#<employeeId>#<n>` never collide under
`begins_with`, because position 6 differs (`#` vs `V`) — so `getReviewsByCycle`'s
`begins_with(SK, 'REVIEW#')` only ever matches the current pointer, never history rows. The
version-history `toVersionItem` deliberately omits `GSI1`/`GSI2` attributes so history rows never
duplicate the CURRENT row in "reviews by manager" (`GSI1`) or "reviews by employee across cycles"
(`GSI2`) listings — only the one current-per-(cycle, employee) row participates in those indexes.

## Uniqueness and lifecycle invariants

- **Email/Slack ID uniqueness** (`src/db/identities.ts` + `employees.ts`): `createEmployee` and
  `updateEmployee` write the `Employee` item and its `IDENTITY#EMAIL#…`/`IDENTITY#SLACK#…` pointer
  rows in one `TransactWriteCommand`, each `Put` conditioned on `attribute_not_exists(PK)` (or
  paired with a `Delete` of the old pointer on rename) — a duplicate email or Slack ID throws
  instead of silently creating a second employee or clobbering the mapping.
- **At-most-one-active-cycle** (`cycles.ts#transitionCycle`): a singleton
  `SYSTEM#ACTIVE_CYCLE` item holds the live cycle's ID. Entering an "active-lock" status
  (`collecting_feedback`/`manager_reviews`/`people_review`/`released`) from a non-locking status
  writes that singleton conditioned on `attribute_not_exists(PK)`; leaving one deletes/clears it
  conditioned on `active_cycle_id = :id`. Both are in the same transaction as the cycle's own
  status `Put` (conditioned on the expected prior status), so a race between two "start cycle"
  calls can only ever let one through.
- **Manager-review submission** (`reviews.ts`): `submitManagerReview`'s conditional expression
  requires both the expected `version` **and** `people_state` to still be one of
  `not_submitted`/`manager_draft`/`returned_to_manager` — a stale or duplicated submit attempt is
  rejected, not silently overwritten, and every save/submit also appends an immutable
  `REVIEWVERSION#` row.
- **Peer feedback, upward feedback, review release, acknowledgement**: all final/one-time writes
  (`savePeerFeedback`, `saveUpwardFeedback`, `createReviewRelease`, `createAcknowledgement`) are
  conditional creates (`attribute_not_exists(PK)`) — a retried submission collapses onto "already
  exists" instead of duplicating or overwriting, and callers treat that as an idempotent no-op
  where appropriate (e.g. `createAcknowledgement` re-reads and returns the original record instead
  of throwing).
- **Peer requests** are idempotent by construction, not just by conditional write: the ID itself is
  deterministic (`peerRequestId(cycleId, requesterId, peerId)`), so re-requesting the same peer is
  a genuine no-op rather than a rejected duplicate.
- **Outbox jobs and notifications**: `enqueueJob` uses the caller-supplied idempotency key as the
  item's own ID, so re-enqueuing the same logical job is a no-op; `claimNotification`
  (`notifications.ts`) is a separate conditional create keyed on
  (employee, notification type, dedupe key — typically a calendar day) so a retried job never
  sends the same Slack DM twice even if the job itself somehow ran more than once.
- **Slack delivery idempotency**: `src/slack/idempotency.ts#claimSlackDelivery` hashes the raw
  Slack payload and claims it via `claimIdempotencyKey` before any handler does real work, guarding
  against Slack's at-least-once delivery retrying a view submission or button click.

## Scans: eliminated from user-facing paths, kept for admin/reporting

`src/db/client.ts#scanAll` exists and is fully paginated, but is used in exactly two
places, both explicitly out of the request-serving path:

- `scripts/migrate.ts` — a one-off backfill script (see `docs/MIGRATIONS.md`), which needs to
  visit every `EMPLOYEE` item regardless of any index.
- `src/db/employees.ts#getEmployeeBySlackId`/directory queries do **not** scan — they resolve
  through `EmployeeIdentity` `GetItem`s and the `EMPLOYEE_DIRECTORY` sparse `GSI1` partition
  instead. (An earlier draft of this codebase scanned here; it no longer does — see
  `docs/FINISH_PLAN.md` defect #21 for what was fixed.)

`src/db/audit.ts#searchAudit` is a bounded, admin-only reporting query: it always starts from a
real index (`GSI1` by actor or `GSI2` by entity) and only filters the resulting — necessarily
bounded, since audit volume per actor/entity is small — set in memory for the remaining
cycle/action/date-range filters. It is not a Scan and is not used on any employee-facing path.

## Versioning and schema evolution

`Employee` and `ReviewCycle` both carry a `schema_version` field for future backfills. New fields
are additive by convention (see `docs/MIGRATIONS.md`) — no entity in this codebase has needed a
breaking shape change yet.
