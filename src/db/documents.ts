import { PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from './client';
import type { DocumentRecord } from '../types';
import { randomUUID } from 'crypto';

const DOC_PREFIX = 'DOC#';
const EMP_PREFIX = 'EMP#';

function toItem(d: DocumentRecord) {
  return {
    PK: `${DOC_PREFIX}${d.id}`,
    SK: 'METADATA',
    GSI2PK: `${EMP_PREFIX}${d.employee_id}`,
    GSI2SK: `${d.cycle_id}#${d.type}`,
    entity_type: 'DOCUMENT',
    ...d,
  };
}

function fromItem(item: Record<string, unknown>): DocumentRecord {
  return {
    id: item.id as string,
    employee_id: item.employee_id as string,
    cycle_id: item.cycle_id as string,
    type: item.type as DocumentRecord['type'],
    file_url: item.file_url as string,
    s3_key: item.s3_key as string,
    created_at: item.created_at as string,
  };
}

function isMissingIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('The table does not have the specified index');
}

export async function saveDocument(
  employeeId: string,
  cycleId: string,
  docType: DocumentRecord['type'],
  fileUrl: string,
  s3Key: string
): Promise<DocumentRecord> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const doc: DocumentRecord = {
    id,
    employee_id: employeeId,
    cycle_id: cycleId,
    type: docType,
    file_url: fileUrl,
    s3_key: s3Key,
    created_at: now,
  };
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: toItem(doc),
    })
  );
  return doc;
}

export async function getDocumentsByEmployeeAndCycle(
  employeeId: string,
  cycleId: string
): Promise<DocumentRecord[]> {
  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `${EMP_PREFIX}${employeeId}`,
          ':sk': cycleId,
        },
      })
    );
    return (r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;

    const fallback = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'entity_type = :entityType AND employee_id = :employeeId AND cycle_id = :cycleId',
        ExpressionAttributeValues: {
          ':entityType': 'DOCUMENT',
          ':employeeId': employeeId,
          ':cycleId': cycleId,
        },
      })
    );
    return (fallback.Items ?? []).map((i) => fromItem(i as Record<string, unknown>));
  }
}
