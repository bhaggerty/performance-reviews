/**
 * Additive backfill migration: ensures every EMPLOYEE item has `is_people_admin` and
 * `schema_version` fields (both added after the initial employee shape shipped).
 *
 * Run with:
 *   npm run db:migrate:dry-run   (default — logs planned writes only)
 *   npm run db:migrate           (writes changes)
 *
 * This is a one-off admin/migration script and is explicitly scan-based (see
 * docs/DATA_MODEL.md) — normal user-facing request paths must never scan.
 */
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME, scanAll } from '../src/db/client';

// package.json wires two scripts against this file: `db:migrate` (no flags -> commit) and
// `db:migrate:dry-run` (passes --dry-run). Default is COMMIT because a dry run always has its
// own explicit npm script — but --dry-run/--commit=false always force a dry run regardless.
const args = process.argv.slice(2);
const forcedDryRun = args.includes('--dry-run') || args.includes('--commit=false');
const forcedCommit = args.includes('--commit') || args.includes('--dry-run=false');
const dryRun = forcedDryRun && !forcedCommit;

interface EmployeeItem {
  PK: string;
  SK: string;
  type?: string;
  id?: string;
  is_people_admin?: boolean;
  schema_version?: number;
  [key: string]: unknown;
}

function needsBackfill(item: EmployeeItem): boolean {
  return item.is_people_admin === undefined || item.schema_version === undefined;
}

async function main(): Promise<void> {
  console.log(`Migration mode: ${dryRun ? 'DRY RUN (no writes)' : 'COMMIT (writing changes)'}`);
  console.log(`Table: ${TABLE_NAME}`);

  const items = await scanAll<EmployeeItem>({
    FilterExpression: '#type = :type',
    ExpressionAttributeNames: { '#type': 'type' },
    ExpressionAttributeValues: { ':type': 'EMPLOYEE' },
  });

  let scanned = 0;
  let needingChange = 0;
  let written = 0;

  for (const item of items) {
    scanned += 1;
    if (!needsBackfill(item)) continue;
    needingChange += 1;

    const updated: EmployeeItem = {
      ...item,
      is_people_admin: item.is_people_admin ?? false,
      schema_version: item.schema_version ?? 1,
    };

    console.log(
      `${dryRun ? '[dry-run] would update' : 'updating'} EMPLOYEE ${item.id ?? item.PK}: ` +
        `is_people_admin=${updated.is_people_admin}, schema_version=${updated.schema_version}`
    );

    if (!dryRun) {
      await docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: updated }));
      written += 1;
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Rows scanned:        ${scanned}`);
  console.log(`  Rows needing change: ${needingChange}`);
  console.log(`  Rows written:        ${dryRun ? 0 : written}${dryRun ? ' (dry run — none written)' : ''}`);
  if (dryRun && needingChange > 0) {
    console.log('');
    console.log('Run `npm run db:migrate` (or pass --commit) to apply these changes.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
