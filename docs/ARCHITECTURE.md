# Architecture

## Service topology

One deployable Node.js/TypeScript service (`src/index.ts`), not two:

- **Slack surface** (`src/slack/app.ts`): a Bolt `App`, either
  - **Socket Mode** (`USE_SOCKET_MODE=true`) — connects outbound to Slack over a WebSocket; no
    inbound HTTP endpoint for Slack traffic is needed at all, or
  - **HTTP mode** (default `false`) — a Bolt `ExpressReceiver` owns its own internal Express app
    and listens on `POST /slack/events`.
- **Console + API + health surface** (`src/web/buildWebApp.ts`): health checks
  (`/health/live`, `/health/ready`), Slack OIDC login (`/auth/slack/*`), the console's JSON API
  (`/api/console/*`), the disabled-by-default automation API (`/automation/*`), and the built SPA
  (`/console/*`, from `web/dist`).

How these combine depends on Slack mode (`src/index.ts`):

- **HTTP mode**: `mountWebApp()` is called on the _same_ Express app the `ExpressReceiver`
  already built (`getSlackExpressApp()`), so there is exactly one HTTP listener, one port, and one
  Union Station service. `slackApp.start(config.port)` starts that single listener.
- **Socket Mode**: Slack has no inbound HTTP surface, but the console/health app still needs one
  (People Ops needs HTTPS to it, and ECS needs `/health/*`). `src/index.ts` creates a standalone
  Express app for `mountWebApp()` and calls `.listen(config.port)` on it directly, alongside
  `slackApp.start()` (which in this mode just opens the WebSocket — no port).

Either way, there is one Node process, one `PORT`, and one Union Station service definition — see
`docs/UNION_STATION_DEPLOYMENT.md`.

## Data and storage

- **DynamoDB** (`src/db/`) is the transactional store of record — single table, `GSI1`/`GSI2`,
  conditional writes and transactions for every uniqueness/lifecycle invariant. Full key design:
  `docs/DATA_MODEL.md`.
- **S3, or a private webhook archive** (`src/services/documents.ts`) holds an immutable copy of
  every final submission (manager review at release, peer feedback and upward feedback at
  submission). The canonical, access-controlled copy is always the DynamoDB `DocumentRecord`;
  S3/webhook is a mirror, reached only through short-lived presigned URLs
  (`presignDocumentUrl`), never a public link.
- **An outbox** (`src/db/outbox.ts`, `src/jobs/`) decouples Slack notifications from the request
  that triggered them — e.g. review release enqueues a `notify_slack_dm` job rather than calling
  Slack inline, so a Slack outage doesn't fail the release and a retry doesn't double-send (see
  `src/db/notifications.ts`'s per-employee/type/day dedupe).
- **The AI review coach** (`src/services/reviewCoach/`) is a pluggable interface
  (`NoopReviewCoach` / `AnthropicReviewCoach` / `OpenAIReviewCoach`, selected once at startup by
  `AI_PROVIDER`) called only from an explicit "Get AI feedback" button in Slack, or an explicit
  "draft a summary" action in the console for upward-feedback release prep — never automatically,
  never gating a save/submit.

## Request-flow examples

### 1. A Slack manager-review submission

```
Manager clicks "Submit" in the review modal
        │
        ▼
handleManagerReviewSubmit (src/slack/managerReview.ts)
        │  claimSlackDelivery() — idempotency guard against Slack retries
        │  requireCurrentManagerRelationship() — re-derives from the live Employee record,
        │  never trusts private_metadata
        │  requireCyclePhase(cycle.status, 'manager_review_edit')
        ▼
ack() returned to Slack (within the interaction deadline)
        │
        ▼
submitManagerReview() (src/db/reviews.ts)
        │  conditional PutItem: only succeeds from an editable people_state
        │  writes a new REVIEWVERSION# history row
        ▼
logAudit({ action: 'submit', ... })
```

No employee notification happens here — the review sits in the People-review queue
(`people_state: 'submitted'`) until People Ops and the Primary Approver act on it in the console.

### 2. A web-console approval + release

```
Primary Approver clicks "Approve" then "Release" in the console
        │
        ▼
POST /api/console/cycles/:cycleId/reviews/:employeeId/approve
        │  requirePrimaryApproverMiddleware (src/web/authMiddleware.ts)
        │  markApproved() — conditional transition, people_state: approved
        │  recordApproval() — append-only Approval record (distinct from the release itself)
        ▼
POST /api/console/cycles/:cycleId/reviews/:employeeId/release
        │  requirePrimaryApproverMiddleware
        │  generateAndStoreManagerReview() — renders + archives the release-time document
        │  createReviewRelease() — conditional create; a review can only be released once
        │  markReleased() — people_state: released
        │  enqueueJob('notify_slack_dm', ...) — employee is told to open Slack, NOT DMed inline
        ▼
logAudit({ action: 'release', review_version, document_id })
```

### 3. An outbox job being processed

```
Union Station scheduled task runs `npm run jobs:run` (src/jobs/runOutbox.ts)
        │
        ▼
listDueJobs() — pending jobs whose run_after has passed (src/db/outbox.ts)
        │
        ▼
for each job: markJobProcessing() → processJob() (src/jobs/processors.ts)
        │
        ├─ success → markJobSucceeded()
        │
        └─ failure → markJobFailed()
                       │  attempts < max_attempts → pending, exponential backoff run_after
                       │  attempts >= max_attempts → dead_letter (visible + retryable in
                       │                              GET /api/console/operations/jobs)
```

`notify_slack_dm` additionally calls `claimNotification()` (src/db/notifications.ts) before
sending, so a job retried after a partial failure never sends the same DM twice.

## Why one service, not several

The assignment favors a pragmatic single-product architecture over microservices. Splitting the
console into a separately-deployed frontend/backend would double the Union Station surface (two
services, two health checks, two sets of secrets) for no operational benefit at this scale — the
console SPA is a handful of static files served by the same process that already needs to run for
Slack.
