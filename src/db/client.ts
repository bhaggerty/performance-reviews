import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  QueryCommandInput,
  ScanCommand,
  ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { config } from '../config';

const marshallOptions = {
  convertEmptyValues: false,
  removeUndefinedValues: true,
};
const unmarshallOptions = { wrapNumbers: false };

const client = new DynamoDBClient({
  region: config.aws.region,
  ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}),
});

export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions,
  unmarshallOptions,
});

export const TABLE_NAME = config.aws.tableName;

/** Fully paginate a Query, following LastEvaluatedKey until exhausted. */
export async function queryAll<T = Record<string, unknown>>(input: Omit<QueryCommandInput, 'TableName'>): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        ...input,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

/**
 * Fully paginate a Scan. Scans are reserved for admin/reporting paths that are
 * explicitly documented as scan-based (see docs/DATA_MODEL.md) — normal user-facing
 * workflows must use queryAll against a real access pattern instead.
 */
export async function scanAll<T = Record<string, unknown>>(input: Omit<ScanCommandInput, 'TableName'>): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ...input,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((result.Items ?? []) as T[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items;
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionCanceledException')
  );
}

export function isMissingIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('specified index') || message.includes('index not found');
}
