# Migrations

## Approach: additive-only, dry-run by default, idempotent

No entity in this codebase has required a breaking shape change — every schema evolution so far
(e.g. adding `is_people_admin`/`schema_version` to `Employee`) is additive: new optional fields
with safe defaults. `scripts/migrate.ts` reflects that: it is a one-off backfill script, not a
general migration framework, because there is currently only one backfill to run.

## Before running a commit migration

**Enable DynamoDB point-in-time recovery on the table first** (see `docs/SECURITY.md`/
`docs/GO_LIVE_CHECKLIST.md`) — this is the practical "backup before migration" step for a
DynamoDB-backed app; there is no separate export/backup step this script performs itself.

## What `scripts/migrate.ts` does

Backfills every `EMPLOYEE` item missing `is_people_admin` or `schema_version` (defaulting to
`false` and `1` respectively). It is explicitly `Scan`-based (via `src/db/client.ts#scanAll`) —
this is one of the two places in the codebase a Scan is intentionally used (see
`docs/DATA_MODEL.md`), acceptable because it's an operator-invoked, off-request-path script, not a
user-facing query.

```bash
npm run db:migrate:dry-run   # logs every row that would change; writes nothing
npm run db:migrate           # applies the backfill
```

The script is idempotent — re-running it after a partial run only touches rows still missing a
field, and running it again after a full run is a no-op (every row already has both fields).

## Adding a future migration

If a future change genuinely requires a non-additive shape change (renaming a field, changing a
key pattern), do not extend `scripts/migrate.ts` in place — write a new, separately-named script
following the same shape (dry-run-by-default via an explicit flag, idempotent, scan- or
query-based depending on what it needs to visit, a clear summary of scanned/changed/written
counts) so `docs/MIGRATIONS.md` can document each one distinctly and operators can run only the
ones they need.
