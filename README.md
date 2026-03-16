# Performance Reviews (Slack + ECS + DynamoDB)

Slack-first performance review app: **Slack = identity**, your DB = org structure. Manager decision tree (Doing Great / Needs Focus / At Risk), peer feedback, upward feedback, and document storage by cycle + employee.

## Architecture

- **Identity**: Slack user ID → employee directory (no HRIS required).
- **Backend**: Node.js (Slack Bolt) + Express, one service.
- **Database**: DynamoDB (single table), fits your existing ECS + DynamoDB platform.
- **Documents**: S3 (by cycle and by employee folder).
- **Hosting**: ECS (your internal platform); secrets via your existing mechanism.

## What’s included

- **Slack Home Tab**: My Review, Request peer feedback, Give upward feedback, History; Manager Dashboard (direct reports, Write review).
- **Manager review (decision tree)**  
  - Step 1: Select employee + “How is this employee doing?” → **Doing Great** / **Needs Focus** / **At Risk**.  
  - Step 2: Path-specific modal (short fields).  
  - Submit → save to DynamoDB, generate text doc, upload to S3 (cycle + employee folder), notify employee.
- **Employee**: View review, Acknowledge (optional comment).
- **Peer feedback**: Request up to 3 peers → DM Accept/Decline → short modal (Strengths, Growth areas, Example).
- **Upward feedback**: Manager auto-filled; raw to HR, managers see summarized themes (summary generation can be added).
- **Admin**: Create/list cycles, open/close cycle; CSV upload for employee directory (`name, email, slack_id, manager_email, department`).
- **Compliance**: Audit log, timestamps, immutable stored docs, At Risk path (prior communication, timeline, HR review).

## Setup

### 1. Slack app

- Create an app at [api.slack.com/apps](https://api.slack.com/apps).
- **OAuth & Permissions**: Bot scopes: `app_mentions:read`, `chat:write`, `users:read`, `users:read.email`, `im:write`, `im:read`, `channels:read` (if needed), and **`commands`** if you add slash commands.
- **App Home**: Enable Home Tab.
- **Interactivity**: Enable; Request URL = `https://<your-ecs-url>/slack/events`.
- **Event Subscriptions**: Enable; Request URL = `https://<your-ecs-url>/slack/events`. Subscribe to **bot events**: `app_home_opened`.
- Install to workspace and copy **Bot User OAuth Token** and **Signing Secret**.

### 2. Environment (ECS / your platform)

Use your internal deployment platform to provide:

- `SLACK_BOT_TOKEN` – Bot User OAuth Token  
- `SLACK_SIGNING_SECRET` – Signing Secret  
- `AWS_REGION` – e.g. `us-east-1`  
- `DYNAMODB_TABLE` – e.g. `performance-reviews`  
- `S3_BUCKET` – bucket for review documents  
- `S3_PREFIX` – optional, e.g. `Performance Reviews`  
- `ADMIN_SECRET` – optional; if set, admin API requires `Authorization: Bearer <ADMIN_SECRET>` or `?secret=<ADMIN_SECRET>`  
- `PORT` – server port (e.g. `3000`)

IAM for the ECS task: DynamoDB read/write on `DYNAMODB_TABLE`, S3 read/write on `S3_BUCKET`.

### 3. DynamoDB table

Create the table (once):

```bash
export AWS_REGION=us-east-1
export DYNAMODB_TABLE=performance-reviews
node scripts/create-table.js
```

Or create in AWS Console with PK=`PK` (String), SK=`SK` (String), GSI1 (`GSI1PK`, `GSI1SK`), GSI2 (`GSI2PK`, `GSI2SK`), pay-per-request. See `src/db/schema.md`.

### 4. Employee directory

- **Option A**: POST CSV to `/admin/employees/upload-csv` (body = CSV text or `{ "data": "csv string" }`).  
  Columns: `name`, `email`, `slack_id`, `manager_email`, `department`. Managers resolved by email.
- **Option B**: Add an admin Slack command later (e.g. `/org set-manager @employee @manager`) and call your API to update `manager_id`.

### 5. Review cycle

- Create cycle: `POST /admin/cycles` with `{ "name": "2026-H1", "start_date": "2026-01-01", "end_date": "2026-06-30", "status": "draft" }`.
- Open cycle: `PATCH /admin/cycles/:id/status` with `{ "status": "open" }`.
- Close: `{ "status": "closed" }`.

## Running locally

```bash
cp .env.example .env
# Fill SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET; optional AWS keys if not using default profile
npm install
npm run build
npm start
```

Use something like ngrok to expose `https://<ngrok>/slack/events` for Interactivity and Event Subscriptions.

## Deploying to ECS

- Build image from this repo (Dockerfile example below).
- Configure task def: env from your secrets manager; port e.g. 3000.
- ALB/listener: HTTPS → target group (port 3000). Use the ALB URL for Slack Request URLs.
- Ensure the app gets `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `AWS_REGION`, `DYNAMODB_TABLE`, `S3_BUCKET`, and optional `S3_PREFIX`, `ADMIN_SECRET`, `PORT`.

### Example Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Build: `npm run build` then `docker build -t performance-reviews .`

## API summary

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /admin/cycles | List cycles |
| POST | /admin/cycles | Create cycle |
| PATCH | /admin/cycles/:id/status | Set cycle status (draft/open/closed) |
| GET | /admin/employees | List employees |
| POST | /admin/employees/upload-csv | Upload CSV directory |

## Document storage (S3)

- By cycle: `{S3_PREFIX}/{cycleName}/Manager Reviews/`, `.../Peer Feedback/`, `.../Upward Feedback/`.
- By employee: `{S3_PREFIX}/Employees/{Employee Name}/Performance Reviews/{cycleName}/`.
- Manager review submission generates a text file and stores it in both places and saves the link in the `documents` table.

## Compliance

- Manager reviews tied to identity (employee + manager in DB).
- Timestamps on all submissions and acknowledgments.
- Final docs written once to S3 (immutable).
- At Risk path captures prior communication, improvement, timeline, HR review.
- Audit log for submit/ack and other key actions.
- Export: use `/admin/employees` and cycle-scoped queries (or add an export endpoint) to build packets.

This keeps Phase 1 small and compatible with your internal ECS + DynamoDB platform while using Slack as the identity layer and a single employee directory table.
