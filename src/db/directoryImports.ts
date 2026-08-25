import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAME, queryAll } from './client';
import type { DirectoryImportSummary } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const PREFIX = 'IMPORT#';

/** Only a safe summary is retained — never the raw uploaded CSV content. */
export async function recordDirectoryImport(
  input: Omit<DirectoryImportSummary, 'id' | 'created_at'>,
  clock: Clock = systemClock
): Promise<DirectoryImportSummary> {
  const id = randomUUID();
  const now = isoNow(clock);
  const summary: DirectoryImportSummary = { id, created_at: now, ...input };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `${PREFIX}${id}`,
        SK: 'METADATA',
        GSI1PK: 'IMPORT_HISTORY',
        GSI1SK: `${now}#${id}`,
        type: 'DIRECTORY_IMPORT',
        ...summary,
      },
    })
  );
  return summary;
}

export async function listDirectoryImports(): Promise<DirectoryImportSummary[]> {
  const items = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'IMPORT_HISTORY' },
    ScanIndexForward: false,
  });
  return items.map((i) => i as unknown as DirectoryImportSummary);
}
