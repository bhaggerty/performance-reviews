# Slack App Setup

## 1. Create the app from the manifest

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app
   manifest**.
2. Select your workspace, paste the contents of `slack-manifest.json` (repo root), replacing
   `YOUR-APP-URL` with your real deployed URL if you're running HTTP mode (see below). Slack's
   manifest UI is the current source of truth for exact field names/validation — verify against it
   if the import reports an error, since the manifest schema does evolve.
3. Create the app.

## 2. Bot scopes — why each one is needed

The manifest requests exactly the scopes this codebase actually calls (verified against every
`client.*` call in `src/slack/*.ts`, `src/jobs/*.ts`, and `src/api/console/*.ts`):

- `chat:write` — `client.chat.postMessage` (peer-request DMs, submission/acknowledgement/release
  notifications, reminder DMs).
- `im:write` — `client.conversations.open` (`src/slack/dm.ts#sendDirectMessage`), which opens/
  reuses a DM channel before posting rather than assuming a user ID is a channel ID.
- `users:read` and `users:read.email` — `client.users.lookupByEmail`
  (`src/api/console/directory.ts#resolveSlackIdByEmail`), called once per CSV row missing
  `slack_id` during a directory import so Slack IDs resolve automatically from email rather than
  requiring every row to carry one.

`views.open`/`views.push`/`views.update`/`views.publish` (used throughout for modals and App
Home) need no bot scope beyond the **App Home** and **Interactivity** features being enabled,
which the manifest already turns on.

## 3. Socket Mode vs. HTTP mode

- **Socket Mode** (`USE_SOCKET_MODE=true`, the manifest default): generate an app-level token
  under **Basic Information → App-Level Tokens** with the `connections:write` scope, and set it as
  `SLACK_APP_TOKEN`. No public Request URL is needed for events or interactivity at all — see
  `docs/UNION_STATION_DEPLOYMENT.md` for what this means for ingress.
- **HTTP mode** (`USE_SOCKET_MODE=false`): set **Interactivity → Request URL** and
  **Event Subscriptions → Request URL** to `https://<your-app-url>/slack/events`, and set
  `SLACK_SIGNING_SECRET` from **Basic Information → Signing Secret**.

Either way: install the app to your workspace, then copy the **Bot User OAuth Token**
(`SLACK_BOT_TOKEN`, starts `xoxb-`).

## 4. Event Subscriptions and Interactivity

Already configured by the manifest: **Interactivity** on, **Home Tab** on, bot event
`app_home_opened` subscribed. If you're configuring by hand instead of via manifest, these three
toggles under **App Home** / **Interactivity & Shortcuts** / **Event Subscriptions** are the ones
this app depends on.

## 5. "Sign in with Slack" (web console OIDC)

The console authenticates People admins via Slack OpenID Connect (`src/web/slackOidc.ts`), which
uses the **same app's** OAuth client credentials from **Basic Information → App Credentials**:
`Client ID` → `SLACK_CLIENT_ID`, `Client Secret` → `SLACK_CLIENT_SECRET`. This is distinct from the
bot token — the bot token authenticates the _app_, while the OIDC client credentials authenticate
a _user_ signing into the console.

You will need to add the OIDC redirect URL under **OAuth & Permissions → Redirect URLs**:
`https://<your-app-url>/auth/slack/callback` (must match `APP_URL` + `/auth/slack/callback`
exactly). The user scopes requested at sign-in time are `openid`, `email`, `profile`
(`src/web/slackOidc.ts#buildAuthorizeUrl`) — **verify the exact current setup steps for "Sign in
with Slack" against Slack's app settings UI**, since Slack's own documentation and settings layout
for OIDC scopes has changed over time and this doc should not be treated as the authoritative
click-path.

Set `SLACK_WORKSPACE_ID` (your workspace/team ID) to restrict console sign-in to that one
workspace — `exchangeCodeForClaims` rejects an `id_token` whose `https://slack.com/team_id` claim
doesn't match.

## 6. Environment variables this app reads

See `.env.example` and `src/config.ts` for the full, authoritative list (that file is what
actually validates them at startup — this doc summarizes, `config.ts` governs). At minimum for a
working install: `SLACK_BOT_TOKEN`, and either `SLACK_APP_TOKEN` (Socket Mode) or
`SLACK_SIGNING_SECRET` (HTTP mode).
