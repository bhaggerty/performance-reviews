# Performance Reviews (Slack + ECS + DynamoDB)

Slack-first performance review app: Slack is identity, and DynamoDB stores your org structure. The app supports a manager decision tree (Doing Great / Needs Focus / At Risk), peer feedback, upward feedback, acknowledgments, and document storage by cycle and employee.

## Architecture

- Identity: Slack user ID to employee directory, no HRIS required.
- Backend: Node.js, Slack Bolt, Express, one service.
- Database: DynamoDB single-table design.
- Documents: S3 by cycle and employee folder.
- Hosting: ECS or an internal platform with injected secrets.

## What's included

- Slack Home Tab: My Review, Request peer feedback, Give upward feedback, History, manager dashboard.
- Manager review flow: choose employee, choose status, complete path-specific modal, save review, write document, notify employee.
- Employee actions: view review and acknowledge with optional comment.
- Peer feedback: request up to 3 peers, DM accept or decline, short submission modal.
- Upward feedback: manager auto-filled, raw data available to HR.
- Optional AI review coach: if a submission is too thin, the app can ask 1-2 follow-up questions before final save.
- Admin API: list and create cycles, open and close cycles, upload employee CSV.
- Compliance: audit log, timestamps, immutable stored docs, At Risk path details.

## Setup

### 1. Slack app

- Create an app at [api.slack.com/apps](https://api.slack.com/apps).
- OAuth scopes: `app_mentions:read`, `chat:write`, `users:read`, `users:read.email`, `im:write`, `im:read`, `channels:read` if needed, and `commands` if you later add slash commands.
- App Home: enable Home Tab.
- Interactivity: enable and set Request URL to `https://<your-app-url>/slack/events`.
- Event Subscriptions: enable, use the same Request URL, and subscribe to `app_home_opened`.
- Install the app and copy the Bot User OAuth Token and Signing Secret.

### 2. Environment

Provide these values through your deployment platform:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `AWS_REGION`
- `DYNAMODB_TABLE`
- `APP_DYNAMODB_TABLE_NAME` as an optional fallback if your platform injects the table name automatically
- `S3_BUCKET`
- `S3_PREFIX` as optional
- `DOCUMENT_ARCHIVE_WEBHOOK_URL` as optional for a private Google Drive or Apps Script archive
- `DOCUMENT_ARCHIVE_WEBHOOK_SECRET` as optional shared secret for that archive webhook
- `OPENAI_API_KEY` as optional for AI follow-up questions on sparse review submissions
- `OPENAI_MODEL` as optional, defaults to `gpt-5-mini`
- `OPENAI_TIMEOUT_MS` as optional timeout for the review coach call
- `ADMIN_SECRET` as optional
- `PORT`

IAM for the runtime should allow DynamoDB read and write on the table and S3 read and write on the document bucket.

### 3. DynamoDB table

Create the table once:

```bash
export AWS_REGION=us-east-1
export DYNAMODB_TABLE=performance-reviews
node scripts/create-table.js
```

Or create it in AWS with:

- PK: `PK` (String)
- SK: `SK` (String)
- GSI1: `GSI1PK`, `GSI1SK`
- GSI2: `GSI2PK`, `GSI2SK`
- Billing mode: pay per request

See [src/db/schema.md](C:\Users\marli\performance-reviews\src\db\schema.md).

If your platform auto-provisions DynamoDB, verify the table before using the app:

```bash
npm run check:table
```

This app requires the base PK/SK table plus both `GSI1` and `GSI2`.

### 4. Employee directory

- Option A: POST CSV to `/admin/employees/upload-csv` as raw CSV or `{ "data": "csv string" }`
- Columns: `name`, `email`, `slack_id`, `manager_email`, `department`
- Option B: add an admin Slack command later for manager updates

### 5. Review cycle

- Create cycle: `POST /admin/cycles`
- Open cycle: `PATCH /admin/cycles/:id/status` with `open`
- Close cycle: `PATCH /admin/cycles/:id/status` with `closed`

## Running locally

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Use ngrok or similar to expose `/slack/events` while testing locally.

## Deploying

- Build the image from this repo.
- Set the app port to `8080` if your platform expects that.
- Configure Slack to use `https://<your-app-url>/slack/events`.
- Ensure the app receives Slack, AWS, DynamoDB, S3, and admin secret env vars.

### Dockerfile

The repo includes a production Dockerfile at [Dockerfile](C:\Users\marli\performance-reviews\Dockerfile).

## API summary

| Method | Path | Description |
| --- | --- | --- |
| GET | /health | Health check |
| GET | /admin/cycles | List cycles |
| POST | /admin/cycles | Create cycle |
| PATCH | /admin/cycles/:id/status | Set cycle status |
| GET | /admin/employees | List employees |
| POST | /admin/employees/upload-csv | Upload CSV directory |

## Document storage

- By cycle: `{S3_PREFIX}/{cycleName}/Manager Reviews/`, `Peer Feedback/`, `Upward Feedback/`
- By employee: `{S3_PREFIX}/Employees/{Employee Name}/Performance Reviews/{cycleName}/`
- Manager review submission writes a text file, stores it in S3, and saves the link in DynamoDB
- Canonical document snapshots are always stored in DynamoDB for app-level access control
- Optional private archive webhook support is documented in [docs/google-drive-archive.md](C:\Users\marli\performance-reviews\docs\google-drive-archive.md)

## AI follow-up coach

- When `OPENAI_API_KEY` is configured, the app checks sparse manager reviews, peer feedback, and upward feedback drafts before final submission.
- If the draft lacks useful detail, the submitter gets the same modal back with 1-2 follow-up prompts and their original answers preserved.
- The additional answers are stored as follow-up notes with the final review document.

## Compliance

- Reviews tied to employee and manager identity
- Timestamps on submissions and acknowledgments
- Final docs written once to S3
- At Risk path captures prior communication, improvement timeline, and HR review
- Audit log for submit and acknowledge events
