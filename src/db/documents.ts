import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { docClient, TABLE_NAME, queryAll, isConditionalCheckFailed } from './client';
import type { DocumentRecord, DocumentType } from '../types';
import { isoNow, systemClock, type Clock } from '../domain/clock';

const DOC_PREFIX = 'DOC#';

function docKey(sourceEntityId: string, sourceVersion: number) {
  return { PK: `${DOC_PREFIX}${sourceEntityId}#v${sourceVersion}`, SK: 'METADATA' };
}

function toItem(d: DocumentRecord) {
  return {
    ...docKey(d.source_entity_id, d.source_version),
    GSI2PK: `EMP_DOCUMENTS#${d.employee_id}`,
    GSI2SK: `${d.cycle_id}#${d.type}#${d.created_at}`,
    record_type: 'DOCUMENT',
    ...d,
  };
}

function fromItem(item: Record<string, unknown>): DocumentRecord {
  return {
    id: item.id as string,
    employee_id: item.employee_id as string,
    cycle_id: item.cycle_id as string,
    type: item.type as DocumentType,
    source_entity_id: item.source_entity_id as string,
    source_version: item.source_version as number,
    content_hash: item.content_hash as string,
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

export interface SaveDocumentInput {
  employeeId: string;
  cycleId: string;
  docType: DocumentType;
  sourceEntityId: string;
  sourceVersion: number;
  contentHash: string;
  title: string;
  content: string;
  authorEmployeeId?: string;
  visibility: DocumentRecord['visibility'];
  archiveBackend: DocumentRecord['archive_backend'];
  archiveUrl?: string;
  archiveKey?: string;
}

/**
 * Deterministic idempotency: the same (sourceEntityId, sourceVersion) can never produce two
 * documents. A retried generation attempt returns the existing record instead of duplicating it.
 */
export async function saveDocument(input: SaveDocumentInput, clock: Clock = systemClock): Promise<DocumentRecord> {
  const existing = await getDocumentBySource(input.sourceEntityId, input.sourceVersion);
  if (existing) return existing;

  const doc: DocumentRecord = {
    id: randomUUID(),
    employee_id: input.employeeId,
    cycle_id: input.cycleId,
    type: input.docType,
    source_entity_id: input.sourceEntityId,
    source_version: input.sourceVersion,
    content_hash: input.contentHash,
    title: input.title,
    content: input.content,
    author_employee_id: input.authorEmployeeId,
    visibility: input.visibility,
    archive_backend: input.archiveBackend,
    archive_url: input.archiveUrl,
    archive_key: input.archiveKey,
    created_at: isoNow(clock),
  };
  try {
    await docClient.send(
      new PutCommand({ TableName: TABLE_NAME, Item: toItem(doc), ConditionExpression: 'attribute_not_exists(PK)' })
    );
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      const raced = await getDocumentBySource(input.sourceEntityId, input.sourceVersion);
      if (raced) return raced;
    }
    throw error;
  }
  return doc;
}

export async function getDocumentBySource(
  sourceEntityId: string,
  sourceVersion: number
): Promise<DocumentRecord | null> {
  const r = await docClient.send(new GetCommand({ TableName: TABLE_NAME, Key: docKey(sourceEntityId, sourceVersion) }));
  return r.Item ? fromItem(r.Item as Record<string, unknown>) : null;
}

export async function getDocumentById(employeeId: string, documentId: string): Promise<DocumentRecord | null> {
  const docs = await listDocumentsForEmployee(employeeId);
  return docs.find((d) => d.id === documentId) ?? null;
}

export async function listDocumentsForEmployee(employeeId: string, types?: DocumentType[]): Promise<DocumentRecord[]> {
  const items = await queryAll({
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `EMP_DOCUMENTS#${employeeId}` },
  });
  const docs = items.map((i) => fromItem(i));
  return (types ? docs.filter((d) => types.includes(d.type)) : docs).sort((a, b) =>
    b.created_at.localeCompare(a.created_at)
  );
}
