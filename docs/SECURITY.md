# Security

## Authentication and session security

- **Console auth**: Slack OpenID Connect (`src/web/slackOidc.ts`), restricted to People admins
  only (`resolveWebActor` + `roles.isPeopleAdmin` check in `src/web/authRoutes.ts`). State, nonce,
  and PKCE are all verified; the `id_token` is verified against Slack's published JWKS (issuer,
  audience, workspace/team ID when configured, `email_verified`).
- **Sessions**: opaque, server-side (`src/db/webSessions.ts`, DynamoDB-backed — safe across
  multiple ECS tasks, unlike an in-memory session store), referenced by an HMAC-signed,
  `httpOnly`, `sameSite=lax` cookie, `secure` in production (`src/web/session.ts`). 12-hour
  expiry. Logout deletes the server-side row, not just the cookie.
- **CSRF**: double-submit cookie/header (`pr_csrf` + `X-CSRF-Token`) enforced on every non-GET
  `/api/console/*` request (`requireCsrf` in `src/web/authMiddleware.ts`).
- No token of any kind is ever placed in `localStorage`, a URL, or a query string.

## Fail-closed startup checks (`src/config.ts`)

Production (`NODE_ENV=production`) refuses to start when any of the following is true:

- Slack mode-specific config is missing (`SLACK_BOT_TOKEN` always; `SLACK_APP_TOKEN` in Socket
  Mode, `SLACK_SIGNING_SECRET` in HTTP mode).
- `PRIMARY_APPROVER_EMAIL` is unset — there is no fallback that grants approval rights to every
  People admin (see `docs/PRIMARY_APPROVER.md`).
- Web console auth isn't configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`WEB_SESSION_SECRET`)
  **and** `WEB_AUTH_DISABLED_INSECURE` isn't explicitly set — and that escape hatch is itself
  hard-disabled whenever `isProduction` is true, regardless of the env var's value.
- `AUTOMATION_API_ENABLED=true` without `AUTOMATION_API_TOKEN`.
- The selected `AI_PROVIDER` (`anthropic`/`openai`) is missing its API key. `AI_PROVIDER=none`
  (the default) requires nothing.

## The automation API (`src/api/automation.ts`)

Disabled by default (`AUTOMATION_API_ENABLED`). When enabled, it is a separate router
(`/automation/*`) authenticated by a single bearer token (`AUTOMATION_API_TOKEN`, compared with
`timingSafeEqual`) and rate-limited (30 req/min). It exposes exactly three operations: send
reminders for the active cycle, run one outbox pass, and list/retry dead-letter jobs. **It does
not, and by design never will, expose approval, release, or upward-feedback-release routes** —
those live only under `/api/console` behind `requirePrimaryApproverMiddleware`, which itself
requires a real browser session established through Slack OIDC. There is no shared-secret path to
any consequential action in this system.

## Logging

`src/logger.ts` emits structured JSON and redacts any field whose key looks like a secret
(`token`, `secret`, `password`, `authorization`, `cookie`, `apikey`, etc., case-insensitive, at any
nesting depth). Callers are still responsible for never passing review/feedback text, employee
emails, or full Slack payloads as log fields — the codebase's own logging calls only ever pass
IDs, counts, and error names/messages, never entity content.

## HTTP hardening (`src/web/buildWebApp.ts`)

- `helmet` with an explicit CSP (`default-src 'self'`, no inline scripts, no framing,
  `referrer-policy: no-referrer`).
- A global rate limiter (120 req/min) ahead of the console/API/automation surface.
- Request bodies are size-limited (`express.json({ limit: '256kb' })` for the console API,
  `2mb` for CSV upload, `64kb` for the automation API).
- Errors returned to the browser are generic (`{ error, message }` from known error types);
  uncaught exceptions never reach the client with a stack trace.

## Document privacy (`src/services/documents.ts`)

S3 objects are only ever reached through `presignDocumentUrl` (short-lived, default 300s,
generated only after the caller has already authorized the requester for that specific document) —
there is no code path that constructs or returns a permanent/public S3 URL. Archive keys are
derived from internal source-entity ID + version, not from names or dates, so they cannot collide.
The DynamoDB `DocumentRecord` is the canonical, access-controlled copy; S3/webhook is a mirror.

## Dependency security

As of this writing, `npm audit` reports **0 vulnerabilities**. Getting there required two upgrades
beyond the original codebase's pins: `@slack/bolt` 3.x → `^4.7.3` and `express` 4.x → `^5.0.0`
(Bolt 4's `ExpressReceiver` depends on Express 5 directly, which also carries the
`path-to-regexp`/`body-parser`/`qs` fix that Express 4's line never received an update for), plus
targeted `overrides` for `axios`, `form-data`, `path-to-regexp`, and one nested `brace-expansion`
pin under `eslint`'s own `minimatch@3.1.5` dependency (a dev-tooling-only DoS advisory, not reachable
via any runtime code path). Re-run `npm audit` before every release — these pins are current as of
this pass, not guaranteed to stay clean as new advisories are published.

## Threat model

**Untrusted inputs**: Slack action/view payloads, CSV directory uploads, and console form
submissions are all treated as untrusted. Every sensitive Slack handler re-derives the actor and
every relevant relationship (manager/employee, peer-request owner/recipient, review ownership)
from the live `Employee`/entity records via `src/domain/authz.ts` rather than trusting anything
carried in `private_metadata`, an action `value`, or a request body — see `docs/PERMISSIONS.md`
for the full list of `require*` checks and where each is enforced.

**The Primary Approver as a high-value target**: compromising that one Slack identity (or the
`PRIMARY_APPROVER_EMAIL` config value pointing at the wrong person) grants full review-approval,
release, and cycle-lifecycle authority. Mitigations: the role is a single config value with no
in-app management surface at all (see `docs/PRIMARY_APPROVER.md`) — changing it requires
Union Station deploy access, not any action inside this application; it is never exposed in any
API response to a non-admin; and every approval/release action is written to the append-only audit
log with the actor's ID, so a compromised session's actions are still traceable after the fact
(though the session itself should be revoked — see `docs/RUNBOOK.md` for secret rotation).

**Upward-feedback re-identification**: the primary mitigation is structural, not just a UI
warning — `src/api/console/upwardFeedback.ts`'s release endpoint itself refuses to release
anything (in any mode other than `none`) for a manager with fewer than 3 respondents unless the
Primary Approver supplies an explicit `threshold_override_reason` in the same request. This is
enforced server-side on the endpoint, not only surfaced as a client-side warning that could be
bypassed by calling the API directly.

**Insider threat — a non-Primary People admin escalating themselves**: verified against
`computeRoles` in `src/domain/authz.ts` — `isPrimaryApprover` requires the authenticated email to
equal the _configured_ `PRIMARY_APPROVER_EMAIL` exactly. A People admin can be granted
`is_people_admin` by another People admin (via directory import), and could in principle change
their own `Employee.email` through a directory import they control — but that alone does not grant
Primary Approver status unless the value they set happens to equal the configured
`PRIMARY_APPROVER_EMAIL`, and console login itself requires proving ownership of that exact email
address through Slack's own OIDC flow (Slack, not this app, attests `email_verified`). There is no
in-app action that writes to or reads from `PRIMARY_APPROVER_EMAIL` — it is a deploy-time value
only. No self-escalation path exists through the application.

**CSV import** is validated (duplicate emails/Slack IDs, unknown managers, self-management,
management cycles — `src/services/directoryImport/importer.ts`) before any write, size-limited
(2MB), and content-sniffed rather than trusted by filename/MIME type
(`src/services/directoryImport/csvSource.ts`). A destructive "authoritative snapshot" import
(deactivating employees missing from the file) requires an explicit `authoritative=true&confirm=true`
on the commit call — never inferred from an upload alone.

See `SECURITY.md` (repository root) for the vulnerability-reporting policy.
