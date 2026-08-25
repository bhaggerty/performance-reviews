# Performance Reviews

Slack-first performance review application for C1.ai: employees and managers do their work in
Slack (self-reflection, peer feedback, upward feedback, manager reviews, acknowledgement); People
Ops does all administration — directory import, cycle configuration, review queue triage,
approval, release, upward-feedback release, reminders, exports, and audit — through a small
internal web console. A single Primary Approver (configured, not hard-coded) is the only identity
who can approve, release, or close/cancel a live cycle.

## Architecture at a glance

- **One Node.js/TypeScript service** (`src/`): a Slack Bolt app (Socket Mode or HTTP Events API,
  see `src/slack/app.ts`) plus an Express-based web console API and static SPA (`src/web/`,
  `src/api/console/`), sharing one Express instance in HTTP mode. See `docs/ARCHITECTURE.md`.
- **DynamoDB single-table design** (`src/db/`) — conditional writes and transactions enforce
  uniqueness and lifecycle invariants; no user-facing path scans the table. See
  `docs/DATA_MODEL.md`.
- **S3 (or a private webhook)** for immutable per-submission document archival, accessed only via
  short-lived presigned URLs. See `docs/DATA_MODEL.md` and `docs/PRIVACY_AND_RETENTION.md`.
- **A DynamoDB-backed outbox** (`src/jobs/`, `src/db/outbox.ts`) for Slack notifications, so
  delivery survives retries and failures are visible/retryable instead of silently swallowed.
- **A provider-agnostic AI review coach** (`src/services/reviewCoach/`) — `none` (default),
  `anthropic`, or `openai` — invoked only on explicit user request, never blocking Slack `ack()`
  or required for any submission.
- **Centralized authorization** (`src/domain/authz.ts`) re-derived server-side on every sensitive
  read/write; the Primary Approver role is never stored, only computed from
  `PRIMARY_APPROVER_EMAIL` + `is_people_admin` at request time. See `docs/PERMISSIONS.md` and
  `docs/PRIMARY_APPROVER.md`.

Full defect audit and rebuild rationale: `docs/FINISH_PLAN.md`.

## Documentation index

| Doc                                                                  | Covers                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [docs/FINISH_PLAN.md](docs/FINISH_PLAN.md)                           | Original audit, defects found, rebuild plan                                     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                         | Service topology, request-flow diagrams                                         |
| [docs/PRODUCT_WORKFLOWS.md](docs/PRODUCT_WORKFLOWS.md)               | Every workflow end to end                                                       |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md)                           | Role matrix and `authz.ts` reference                                            |
| [docs/PRIMARY_APPROVER.md](docs/PRIMARY_APPROVER.md)                 | How the Primary Approver role works and how to change it                        |
| [docs/WEB_CONSOLE.md](docs/WEB_CONSOLE.md)                           | Console auth, pages, full API reference                                         |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md)                             | DynamoDB key design, as implemented                                             |
| [docs/SECURITY.md](docs/SECURITY.md)                                 | Auth, fail-closed checks, headers, known risks, threat model                    |
| [docs/PRIVACY_AND_RETENTION.md](docs/PRIVACY_AND_RETENTION.md)       | What's retained where, anonymization, exports, deletion gap                     |
| [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md)                           | Creating and configuring the Slack app                                          |
| [docs/UNION_STATION_DEPLOYMENT.md](docs/UNION_STATION_DEPLOYMENT.md) | Deployment mapping (Union Station convention not available in this environment) |
| [docs/MIGRATIONS.md](docs/MIGRATIONS.md)                             | Running `scripts/migrate.ts`                                                    |
| [docs/TESTING.md](docs/TESTING.md)                                   | Test layout and commands                                                        |
| [docs/RUNBOOK.md](docs/RUNBOOK.md)                                   | Operating the running service                                                   |
| [docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md)               | What's done vs. what needs external action                                      |
| [SECURITY.md](SECURITY.md)                                           | Vulnerability reporting policy                                                  |
| [slack-manifest.json](slack-manifest.json)                           | Slack app manifest                                                              |

## Local development

This is an npm workspaces repo: the server lives at the root, the console SPA lives in `web/`.

```bash
npm install                  # installs both the root and web/ workspace
cp .env.example .env         # fill in Slack/AI/session values as needed — see docs/SLACK_SETUP.md
docker compose up -d         # starts DynamoDB Local (see docker-compose.yml)
npm run db:create            # creates the table + GSI1/GSI2 against DynamoDB Local
npm run db:seed              # fictional org, sample cycle, fake People admin + Primary Approver
npm run dev                  # runs the server (tsx watch) and the Vite dev server together
```

Open `http://localhost:5173` (Vite dev server, proxied to the API) for the console during
development, or `http://localhost:3000/console/` against a built `web/dist`. For Slack itself in
local dev, either run Socket Mode (`USE_SOCKET_MODE=true` + `SLACK_APP_TOKEN`, no public URL
needed) or HTTP mode with ngrok pointed at `/slack/events` — see `docs/SLACK_SETUP.md`.

`WEB_AUTH_DISABLED_INSECURE=true` (non-production only — `src/config.ts` refuses to honor it when
`NODE_ENV=production`) lets you skip the Slack OIDC round trip locally: send
`X-Dev-Actor-Email: <email>` and the console treats that email as the authenticated actor.

## Testing

```bash
npm test                 # unit + Slack + console API tests (mocked, no AWS/Slack calls)
npm run test:coverage
npm run test:integration # requires DynamoDB Local running (docker compose up -d)
npm run test:e2e         # Playwright; requires a built app running locally
```

See `docs/TESTING.md` for what each layer covers and prerequisites.

## Validate before shipping

```bash
npm run validate   # format check, lint, typecheck, unit tests, build (server + web)
```

## Deploying

This app deploys through **Union Station** onto ECS Fargate, the same way as this org's other
services: Union Station builds and deploys directly from `Dockerfile` (no separate manifest lives
in this repo), injects secrets/config as plain runtime env vars, and polls `GET /health` for
liveness. See `docs/UNION_STATION_DEPLOYMENT.md` for how this was confirmed and what's still
unverified — no actual deployment was performed from this environment (no Union Station
credentials/CLI/dashboard access here).
