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
    title: item.title as string,
    content: item.content as string,
    author_employee_id: item.author_employee_id as string | undefined,
    visibility: item.visibility as DocumentRecord['visibility'],
    archive_backend: item.archive_backend as DocumentRecord['archive_backend'],
    archive_url: item.archive_url as string | undefined,
    archive_key: item.archive_key as string | undefined,
    created_at: item.created_at as string,
  };
}

function isMissingIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return message.includes('The table does not have the specified index');
}

export async function saveDocument(
  input: {
    employeeId: string;
    cycleId: string;
    docType: DocumentRecord['type'];
    title: string;
    content: string;
    authorEmployeeId?: string;
    visibility: DocumentRecord['visibility'];
    archiveBackend: DocumentRecord['archive_backend'];
    archiveUrl?: string;
    archiveKey?: string;
  }
): Promise<DocumentRecord> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const doc: DocumentRecord = {
    id,
    employee_id: input.employeeId,
    cycle_id: input.cycleId,
    type: input.docType,
    title: input.title,
    content: input.content,
    author_employee_id: input.authorEmployeeId,
    visibility: input.visibility,
    archive_backend: input.archiveBackend,
    archive_url: input.archiveUrl,
    archive_key: input.archiveKey,
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

function sortDocuments(docs: DocumentRecord[]): DocumentRecord[] {
  return docs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listDocumentsForEmployee(
  employeeId: string,
  types?: DocumentRecord['type'][]
): Promise<DocumentRecord[]> {
  const matchesType = (doc: DocumentRecord) => !types || types.includes(doc.type);
  try {
    const r = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `${EMP_PREFIX}${employeeId}`,
        },
      })
    );
    return sortDocuments(
      (r.Items ?? [])
        .map((i) => fromItem(i as Record<string, unknown>))
        .filter(matchesType)
    );
  } catch (error) {
    if (!isMissingIndexError(error)) throw error;

    const filterParts = ['entity_type = :entityType', 'employee_id = :employeeId'];
    const values: Record<string, unknown> = {
      ':entityType': 'DOCUMENT',
      ':employeeId': employeeId,
    };
    if (types?.length) {
      const typeKeys = types.map((type, index) => {
        const key = `:type${index}`;
        values[key] = type;
        return key;
      });
      filterParts.push(`type IN (${typeKeys.join(', ')})`);
    }

    const fallback = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeValues: values,
      })
    );
    return sortDocuments((fallback.Items ?? []).map((i) => fromItem(i as Record<string, unknown>)));
  }
}

export async function listDocumentsAuthoredBy(
  authorEmployeeId: string,
  types?: DocumentRecord['type'][]
): Promise<DocumentRecord[]> {
  const filterParts = ['entity_type = :entityType', 'author_employee_id = :authorEmployeeId'];
  const values: Record<string, unknown> = {
    ':entityType': 'DOCUMENT',
    ':authorEmployeeId': authorEmployeeId,
  };
  if (types?.length) {
    const typeKeys = types.map((type, index) => {
      const key = `:type${index}`;
      values[key] = type;
      return key;
    });
    filterParts.push(`type IN (${typeKeys.join(', ')})`);
  }

  const r = await docClient.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeValues: values,
    })
  );
  return sortDocuments((r.Items ?? []).map((i) => fromItem(i as Record<string, unknown>)));
}
