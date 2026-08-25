# syntax=docker/dockerfile:1

# Production Dockerfile. Union Station builds/deploys from this directly — no separate
# Union Station manifest lives in this repo (see docs/UNION_STATION_DEPLOYMENT.md and the
# `reference_union_station` project note). It injects secrets and config (AWS creds,
# APP_DYNAMODB_TABLE_NAME, AWS_REGION, Slack/ConductorOne credentials) as plain runtime env
# vars rather than via a .env file, and polls GET /health (see src/web/health.ts) for liveness.

FROM node:20-alpine AS deps
WORKDIR /app
# package-lock.json covers both the root package and the web/ workspace; web/package.json is
# required at this stage so `npm ci` can resolve the workspace before any source is copied.
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Match the port the app actually listens on (src/config.ts reads PORT, default 3000) to the
# port this image exposes, so EXPOSE/HEALTHCHECK/ECS target group all agree.
ENV PORT=8080

COPY package.json package-lock.json ./
# --workspaces=false: install only the root (server) production dependencies. The web/
# workspace's deps (react, vite, ...) are build-time only — web/dist is already a static
# artifact by this point and needs no runtime node_modules of its own.
RUN npm ci --omit=dev --workspaces=false

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

EXPOSE 8080

# Union Station does its own external polling of /health; this HEALTHCHECK is purely for local
# `docker run`/Compose usage and points at the same cheap endpoint Union Station itself checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

USER node

CMD ["node", "dist/index.js"]
