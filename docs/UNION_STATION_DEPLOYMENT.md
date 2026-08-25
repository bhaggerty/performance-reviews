# Union Station Deployment

## The real convention (confirmed from sibling repos)

No Union Station documentation or tooling was reachable from the environment this pass was done
in, and there was no memory of it available either (despite the org apparently having saved one —
see "the missing memory" below). Rather than invent manifest syntax, the actual convention was
reconstructed by reading three of this org's other live repos on GitHub
(`bhaggerty/headcount-fairy`, `bhaggerty/three-sixty-reviews`, `bhaggerty/offer-letter-agent`).
Two of them (`headcount-fairy`, a Node/Slack-Bolt app very similar in shape to this one, and
`three-sixty-reviews`, a Rails app) show the same pattern consistently:

1. **Union Station builds and deploys directly from the repo's `Dockerfile`.** There is no
   separate in-repo Union Station manifest file in either sibling repo — no YAML/JSON service
   definition, no CDK/Terraform. This repo does not have one either; `Dockerfile` is the only
   deployment artifact Union Station needs from the repo itself.
2. **Secrets and config are injected as plain runtime environment variables**, not via a `.env`
   file and not via in-app Secrets Manager ARN references. `three-sixty-reviews`'s Dockerfile
   states this explicitly: _"Union Station builds/deploys from this -- it injects secrets (AWS
   creds, DynamoDB table name, Slack/ConductorOne credentials) as env vars at runtime rather than
   via a .env file."_ This app already reads every secret via plain `process.env.*` in
   `src/config.ts` — no change was needed there.
3. **`AWS_REGION` and `APP_DYNAMODB_TABLE_NAME` are auto-injected in production** — both sibling
   repos document these two exact variable names as Union-Station-provided. This is exactly why
   the _original_ pre-existing `src/config.ts` in this repo already had `APP_DYNAMODB_TABLE_NAME`
   as a fallback before this pass touched anything; it was inherited from this same convention.
   `.env.example` now documents this explicitly.
4. **Union Station polls a single `GET /health` endpoint for liveness**, and expects it to be
   deliberately cheap — no live AWS round-trip. `three-sixty-reviews`'s `HealthController` comment:
   _"Union Station polls this for liveness... Deliberately cheap -- confirms the DynamoDB client is
   configured, not a live round-trip, so this endpoint can't be slowed down or exhausted by
   AWS-side issues."_ `src/web/health.ts`'s `GET /health` matches this shape exactly (no I/O, just
   confirms the process is up and not draining). `/health/live` is kept as an alias for any
   generic k8s-style monitor; `/health/ready` is a separate, heavier, DynamoDB-round-trip check
   kept only for a load balancer / ECS target group that specifically wants a dependency-aware
   check — it is not what Union Station itself polls.
5. **No deploy step lives in the repo's own CI.** `three-sixty-reviews`'s GitHub Actions workflow
   only runs security scanning (Brakeman, bundler-audit) and lint — no build/push/deploy job.
   Deployment is triggered by Union Station itself, outside this repo's CI. This repo's
   `.github/workflows/ci.yml` follows the same pattern: format/lint/typecheck/test/build/Docker
   build only, no deploy job.
6. **Port is app-specific, not fixed.** `headcount-fairy` (Node) uses 8080; `three-sixty-reviews`
   (Rails/Thruster) uses 80. This app keeps 8080 (matching the Node sibling and the original
   pre-existing Dockerfile) — `EXPOSE 8080`, `PORT=8080`, and `src/config.ts`'s `PORT` env var all
   agree.

`npm run union-station:validate` (`scripts/validateUnionStation.ts`) checks this repo against
exactly these confirmed facts: the Dockerfile documents the Union Station build/deploy
relationship and exposes a port, `GET /health` exists, and `.env.example` documents
`AWS_REGION`/`APP_DYNAMODB_TABLE_NAME` as auto-injected. It is a real, grounded check now — not a
placeholder validating an invented file.

## The missing memory

`three-sixty-reviews`'s `HealthController` comment explicitly references
`(see memory: reference_union_station)` — a saved memory this assistant should have had access to
but did not find in this environment's memory store (only one unrelated memory existed there).
Whatever mechanism was used to save it before did not land where this session could read it. The
facts above were reconstructed from the sibling repos' code instead, which is a solid grounding
(it's what the _real_ apps actually do), but it is a **reconstruction from evidence, not a direct
read of that memory** — if the original `reference_union_station` memory contains anything beyond
what's listed above (e.g. exact Union Station CLI commands, dashboard URLs, a repo registration
step, staging vs. production account details), it should still be treated as authoritative over
this document. Consider re-saving it in a location this assistant's memory store can reach.

## What this repo still cannot verify

- **No actual deploy was performed.** There is no Docker daemon, no AWS credentials, and no
  Union Station CLI/dashboard access in the environment this pass ran in. `npm run
union-station:validate` and a local `docker build` (Dockerfile is valid and was reviewed, but
  never actually built here — no Docker daemon available) are as far as this pass could verify.
- **Whatever registers a new service with Union Station in the first place** (a dashboard click,
  a CLI command, a config file living outside this repo) was not discoverable and is not covered
  above — the sibling repos show what a repo _already onboarded_ to Union Station looks like, not
  the onboarding step itself.
- **Scheduled jobs**: this app needs two recurring one-shot processes — `reminders`
  (`npm run reminders:run`, intended daily) and `outbox` (`npm run jobs:run`, intended every
  1–5 minutes). Neither sibling repo inspected here has an equivalent recurring job, so the exact
  Union Station mechanism for scheduling these (a distinct scheduled-task construct vs. some other
  convention) is unconfirmed — do not run either as an in-process interval timer in the main
  process, since with more than one task running that fires the job once per task instead of once
  total.
- **ALB/ingress**: unconfirmed whether Union Station's ingress convention supports one service
  routing both `/console/*`/`/api/console/*` and, in HTTP Slack mode, `/slack/events`, on the same
  port. In Socket Mode, Slack itself needs no inbound ingress at all (only outbound), but the
  People console still needs inbound HTTPS regardless of Slack transport mode.

## Do not claim this is deployed

No production deployment was performed or attempted from this repository — there were no
Union Station credentials/CLI/dashboard access to do so. `docs/GO_LIVE_CHECKLIST.md` lists every
remaining external step.
