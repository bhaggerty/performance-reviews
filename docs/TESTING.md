# Testing

## Layout

- **`tests/unit/`** — pure logic, no AWS/Slack calls: authorization (`authz.test.ts`), cycle state
  machine (`cycleStateMachine.test.ts`), CSV parsing (`csvSource.test.ts`) and directory-import
  validation/graph logic (`importer.test.ts`), idempotency (`idempotency.test.ts`), the AI provider
  adapters against a fake provider (`reviewCoach.test.ts`), and Slack `mrkdwn` escaping
  (`slackFormat.test.ts`).
- **`tests/slack/`** — Slack workflow tests against a mocked Slack client: manager review
  (`managerReview.test.ts`), peer feedback (`peerFeedback.test.ts`), self-reflection
  (`selfReflection.test.ts`).
- **`tests/fixtures/builders.ts`** — shared test-data builders used across the above.
- **`tests/console/`, `tests/integration/`, `tests/e2e/`** — referenced by
  `vitest.config.ts`/`vitest.integration.config.ts`/`playwright.config.ts` and by the `npm run
test:*` scripts below, but were still being built out in this pass. Check the directory itself
  for current contents before assuming a specific file exists — this doc describes the intended
  shape (console API tests with a mocked Express app; integration tests against DynamoDB Local
  covering conditional writes, transactions, pagination, and idempotent upserts; one end-to-end
  Playwright flow through the console) rather than guaranteeing every file is present yet.

## Commands

```bash
npm test               # tests/unit + tests/slack + tests/console (vitest.config.ts) — no AWS/Slack network calls
npm run test:watch
npm run test:coverage  # adds v8 coverage; see vitest.config.ts for included/excluded paths
npm run test:integration  # vitest.integration.config.ts — requires DynamoDB Local
npm run test:e2e       # playwright.config.ts — requires a built app running locally
```

## Prerequisites by layer

- **`npm test`**: nothing external — every test in `tests/unit`/`tests/slack`/`tests/console`
  mocks its dependencies (fake Slack client, in-memory/mocked DynamoDB via `aws-sdk-client-mock`,
  a fake AI provider). This is the layer CI runs on every push.
- **`npm run test:integration`**: a running DynamoDB Local instance
  (`docker compose up -d`, then `npm run db:create` against it — see the root `README.md`'s local
  dev section and `docker-compose.yml`) with `DYNAMODB_ENDPOINT` pointed at it.
- **`npm run test:e2e`**: a built, running instance of the app (`npm run build && npm start`, or
  the dev servers) plus Playwright's browser binaries (`npx playwright install` — this may require
  network access to download browsers, which is not guaranteed available in every CI/sandbox
  environment; if it fails, treat browser e2e as externally blocked in that environment rather than
  masking the failure).

## Coverage goals

Per the assignment: ≥80% overall branch coverage, ≥95% for authorization and lifecycle-transition
code specifically (`src/domain/authz.ts`, `src/domain/cycleStateMachine.ts`, the conditional-write
paths in `src/db/reviews.ts`/`cycles.ts`/`upwardFeedback.ts`) and for Primary Approver enforcement.
Run `npm run test:coverage` and check the HTML report (`coverage/index.html`) against these
targets rather than treating "tests exist" as sufficient on its own.
