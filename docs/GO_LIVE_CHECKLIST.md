# Go-Live Checklist

## Done in code (this pass)

- [x] Centralized, server-re-derived authorization (`src/domain/authz.ts`) covering every Slack
      and console entry point.
- [x] Primary Approver role computed from config, never stored, fail-closed at startup.
- [x] Explicit cycle state machine with a singleton active-cycle lock.
- [x] Self-reflection, peer feedback (with resumable accepted requests, anonymized to the
      employee), upward feedback (People-only raw, versioned Primary-Approver-gated release, <3
      threshold enforced server-side), manager review (decision tree + At Risk fields + draft/
      return/resubmit), People review → approval → release, and acknowledgement — all built as
      real, persisted, conditionally-written entities.
- [x] CSV directory import behind an `EmployeeDirectorySource` adapter interface, with dry-run,
      validation (duplicate emails/Slack IDs, unknown managers, self-management, management
      cycles), and an explicit authoritative-snapshot confirmation for deactivation.
- [x] Web console (Slack OIDC auth, CSRF, sessions) covering Dashboard, Directory, Cycles, Review
      Queue/Detail, At Risk Queue, Upward Feedback, Reminders, Exports, Audit, Operations.
- [x] Provider-agnostic AI review coach (`none`/`anthropic`/`openai`), never blocking `ack()`,
      never required, never auto-releasing anything.
- [x] Outbox-based Slack notifications with retry/dead-letter visibility, and reminder engine.
- [x] `npm audit` clean (0 vulnerabilities) as of this pass.

## Requires external action before real production use

### Slack

- [ ] Create the Slack app from `slack-manifest.json` in the real workspace (`docs/SLACK_SETUP.md`).
- [ ] Generate and store `SLACK_BOT_TOKEN` (+ `SLACK_APP_TOKEN` for Socket Mode, or
      `SLACK_SIGNING_SECRET` for HTTP mode).
- [ ] Configure "Sign in with Slack" OAuth credentials (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`)
      and register the exact `/auth/slack/callback` redirect URL.
- [ ] Set `SLACK_WORKSPACE_ID` to restrict console login to the real workspace.
- [ ] Install the app; confirm bot scopes match `slack-manifest.json`.

### Union Station / AWS

- [ ] Register this repo with Union Station the same way the org's other services are registered
      (confirmed pattern from sibling repos: Union Station builds/deploys directly from
      `Dockerfile`, no in-repo manifest needed — see `docs/UNION_STATION_DEPLOYMENT.md`).
- [ ] Provision the DynamoDB table with `GSI1` and `GSI2` (`npm run db:create`, or the equivalent
      Union Station-managed resource declaration) — verify with `npm run check:table`.
- [ ] Enable DynamoDB point-in-time recovery before any real data is written.
- [ ] Provision the S3 bucket (if used): block all public access, enable versioning, private only.
- [ ] Create Secrets Manager (or equivalent) entries for every secret-shaped env var in
      `.env.example` (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`,
      `SLACK_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `WEB_SESSION_SECRET`,
      `AUTOMATION_API_TOKEN`, `DOCUMENT_ARCHIVE_WEBHOOK_SECRET`) — Union Station injects these as
      plain runtime env vars, not via a `.env` file.
- [ ] Configure the two scheduled tasks (`npm run reminders:run`, `npm run jobs:run`) through
      Union Station's scheduled-job mechanism — not an in-process timer.
- [ ] Confirm HTTPS ingress reaches the console/API/health surface regardless of Slack transport
      mode (Socket Mode removes the Slack-specific inbound requirement, not the console's).

### DNS / SSO

- [ ] Point the production hostname at the deployed service; set `APP_URL` to match exactly (it's
      used to build the OIDC redirect URI).
- [ ] If your org requires it, layer additional SSO/network restrictions in front of the console
      per your org's standard — this app's own auth is Slack OIDC restricted to one workspace, not
      a general SSO integration.

### Primary Approver and People admins

- [ ] Decide who the Primary Approver is; confirm their `Employee` record will have
      `is_people_admin: true` **before** setting `PRIMARY_APPROVER_EMAIL` to their address (see
      `docs/PRIMARY_APPROVER.md` — this ordering is a common mistake).
- [ ] Set `PRIMARY_APPROVER_EMAIL` and, if needed, seed `PEOPLE_ADMIN_EMAILS` for other initial
      People admins (or set `is_people_admin: true` on their directory rows via import).

### Data and first cycle

- [ ] Run `npm run db:migrate:dry-run`, review the output, then `npm run db:migrate` if it reports
      any rows needing backfill (a fresh table needs neither).
- [ ] Import the real employee directory via the console (dry run first, review the plan, then
      commit) — see `docs/PRODUCT_WORKFLOWS.md` and `sample-data/employees.example.csv` for the
      expected columns.
- [ ] Create the first real cycle in the console, configure deadlines/prompts, and start it
      (Primary Approver required for the `collecting_feedback` transition).
- [ ] Smoke-test console login as the Primary Approver end to end
      (`docs/RUNBOOK.md`'s smoke-test checklist).

## Known limitations to state directly, not gloss over

- No deletion/anonymization command exists yet (`docs/PRIVACY_AND_RETENTION.md`).
- Self-reflection reopening (`reopenSelfReflection`) exists at the data layer but has no console
  UI action wired to it yet.
- Peer-feedback redaction (`setPeerFeedbackRedaction`) exists at the data layer but has no console
  UI action wired to it yet.
- `resolveSlackIdByEmail` in the CSV importer calls the real Slack `users.lookupByEmail` API
  (`src/api/console/directory.ts`), which requires the `users:read` and `users:read.email` bot
  scopes (already in `slack-manifest.json`) — reinstall/reauthorize the app if you added these
  scopes after an earlier install, or the lookup will fail for every row.
- `Dockerfile` builds both the server and `web/dist` in a multi-stage build, runs as the non-root
  `node` user, and exposes/health-checks on `PORT` (default 8080) — confirm this matches whatever
  port Union Station's service definition expects before relying on it in production.
- Browser (Playwright) end-to-end tests may require network access to download browser binaries
  that isn't guaranteed in every environment — verify `npm run test:e2e` actually runs in your CI
  before treating it as a release gate.

No production deployment was performed or claimed in this pass — everything above under "Requires
external action" is genuinely outstanding.
