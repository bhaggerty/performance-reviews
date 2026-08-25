# Local Development

## Local DynamoDB

This repo ships a `docker-compose.yml` that runs `amazon/dynamodb-local` on port 8000 with a
named volume for persistence.

```bash
docker compose up -d
```

Then, pointing the app's DynamoDB client at that local endpoint (`src/db/client.ts` already
reads `DYNAMODB_ENDPOINT` for exactly this purpose):

```bash
DYNAMODB_ENDPOINT=http://localhost:8000 AWS_REGION=us-east-1 DYNAMODB_TABLE=performance-reviews-dev npm run db:create
DYNAMODB_ENDPOINT=http://localhost:8000 AWS_REGION=us-east-1 DYNAMODB_TABLE=performance-reviews-dev npm run db:seed
```

`npm run db:create` creates the table plus its GSI1/GSI2 indexes; against DynamoDB Local it will
log (and continue past) warnings that point-in-time recovery isn't supported there — that's
expected. `npm run db:seed` seeds a small fictional organization (see `scripts/seed.ts`) and
prints a suggested `PRIMARY_APPROVER_EMAIL` for your local `.env`.

Set the same `DYNAMODB_ENDPOINT`/`DYNAMODB_TABLE` values when running `npm run dev:server` (or
add them to your local `.env` — `src/config.ts` reads them the same way).

`docker compose down` stops the container but **keeps** the named volume (your seeded data
survives). Use `docker compose down -v` to also delete the volume and start from empty.
