# Runbook

## Failed jobs

- View: **Operations** page in the console, or `GET /api/console/operations/jobs` (returns
  `pending`/`processing`/`failed`/`deadLetter` arrays — `src/api/console/operations.ts`).
- A job moves to `dead_letter` after `max_attempts` failures (default 5), with exponential backoff
  between attempts (`src/db/outbox.ts#markJobFailed`).
- Retry a dead-letter job: the **Retry** action in Operations, or
  `POST /api/console/operations/jobs/:id/retry` — resets `attempts` to 0 and `run_after` to now.
  Retrying is audited (`logAudit`, action `retry`).
- The most common job type today is `notify_slack_dm`; a dead-lettered one almost always means the
  Slack DM target is invalid (deactivated/removed user) or Slack itself was unreachable — check the
  job's `last_error` field before retrying blindly.

## Reminders

- Routine types run automatically once daily via the Union Station-scheduled `npm run
reminders:run` (`src/jobs/runReminders.ts`) against the active cycle.
- Any People admin can preview and send on demand from the console's **Reminders** page (or
  `GET`/`POST /api/console/cycles/:cycleId/reminders/:type/preview` and `.../send`), with an
  exclude-list to skip specific employees.
- Resending the same type on the same calendar day is a no-op for anyone already notified that day
  (`src/services/reminders.ts` dedupes on cycle+type+day+employee) — this is not a bug if a second
  "send" reports 0 newly enqueued.

## Rotating secrets

Exact mechanism depends on Union Station's secret-injection convention (confirmed pattern: plain
runtime env vars, not a `.env` file — see `docs/UNION_STATION_DEPLOYMENT.md`), but functionally,
for each secret-shaped env var (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`,
`SLACK_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `WEB_SESSION_SECRET`,
`AUTOMATION_API_TOKEN`, `DOCUMENT_ARCHIVE_WEBHOOK_SECRET` — see `.env.example`):

- **Slack tokens** (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`): regenerate in
  the Slack app settings, update the secret, redeploy/restart. Rotating `SLACK_SIGNING_SECRET` or
  `SLACK_APP_TOKEN` requires the app to pick up the new value before the old one stops working on
  Slack's side, if Slack supports a grace period for your plan — check current Slack docs.
- **`SLACK_CLIENT_SECRET`**: regenerate under Basic Information → App Credentials; existing
  console sessions are unaffected (sessions are independent of the OAuth client secret once
  issued), but no new logins will succeed until the new value is deployed.
- **`WEB_SESSION_SECRET`**: rotating this invalidates every existing session cookie's HMAC
  signature immediately (`src/web/session.ts#sign`) — every logged-in People admin will need to
  sign in again. Plan rotation for a low-traffic window.
- **`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`**: only relevant if `AI_PROVIDER` is set to that provider;
  rotate and redeploy, no session impact.
- **`AUTOMATION_API_TOKEN`**: only relevant if `AUTOMATION_API_ENABLED=true`; rotate and update
  whatever caller uses it.
- **`DOCUMENT_ARCHIVE_WEBHOOK_SECRET`**: only relevant if an external archive webhook is
  configured; coordinate rotation with the webhook's own configuration.

## Rolling back a deployment

Because every migration this codebase has needed is additive (`docs/MIGRATIONS.md`), rolling back
to a prior container image is safe **without** a corresponding data-migration rollback — older code
simply ignores fields it doesn't know about. Rollback itself (redeploying a previous image/task
definition) is Union Station's responsibility; there is nothing app-specific to undo in DynamoDB
for a same-or-later migration state.

## Production smoke test checklist

After a deploy (or before declaring one "done"):

1. `GET /health/live` → 200. `GET /health/ready` → 200 (confirms DynamoDB reachability).
2. Open Slack, open the app's Home tab — confirm it renders (either the "not in directory" message
   or the real dashboard for a known test/seed employee).
3. As a test employee: open **Self reflection**, save a draft, confirm it reopens with the saved
   answers, submit, confirm it becomes read-only.
4. Sign into the console (`/console/`) via Slack OIDC as a known People admin — confirm the
   Dashboard loads and reflects the current cycle (or "no active cycle").
5. If a cycle is active: confirm the Review Queue loads without error.

## Recovering from a startup crash

`src/config.ts` throws synchronously on missing required config — a crash-looping task almost
always means a missing/incorrect environment variable or secret. Check task logs for the specific
`Missing required environment variable ...` or `Refusing to start ...` message before assuming
anything more complex is wrong.
