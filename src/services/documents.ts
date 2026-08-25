import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';
import { format } from 'date-fns';
import { config } from '../config';
import { logger } from '../logger';
import { saveDocument } from '../db/documents';
import { getEmployeeById } from '../db/employees';
import type {
  AtRiskDetails,
  DocumentArchiveBackend,
  DocumentRecord,
  DocumentType,
  DocumentVisibility,
  ManagerReview,
  PeerFeedback,
  UpwardFeedback,
} from '../types';

const s3 = new S3Client({ region: config.aws.region });
const bucket = config.aws.s3Bucket;
const prefix = config.aws.s3Prefix;
const archiveWebhookUrl = config.documents.archiveWebhookUrl;
const archiveWebhookSecret = config.documents.archiveWebhookSecret;

if (!bucket && !archiveWebhookUrl) {
  logger.warn('No external document archive configured; canonical review documents will stay in DynamoDB only.');
}

type ArchiveResult = { backend: DocumentArchiveBackend; archiveUrl?: string; archiveKey?: string };

type DocumentDraft = {
  employeeId: string;
  cycleId: string;
  type: DocumentType;
  sourceEntityId: string;
  sourceVersion: number;
  title: string;
  content: string;
  authorEmployeeId?: string;
  visibility: DocumentVisibility;
  cycleName: string;
  employeeName: string;
};

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function chunkLines(lines: Array<string | undefined | false>): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function archiveTypeFolder(type: DocumentType): string {
  switch (type) {
    case 'manager_review':
      return 'Manager Reviews';
    case 'peer_feedback':
      return 'Peer Feedback';
    case 'upward_feedback':
      return 'Upward Feedback';
    default:
      return 'Documents';
  }
}

function safeFolderName(name: string): string {
  return name
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Collision-resistant: keyed by internal source entity ID + version, never by name/date alone. */
function archiveKeyFor(draft: DocumentDraft): string {
  const typeFolder = archiveTypeFolder(draft.type);
  const cycleFolder = draft.cycleName.replace(/\s+/g, '-');
  return `${prefix}/${cycleFolder}/${typeFolder}/${draft.sourceEntityId}-v${draft.sourceVersion}.txt`;
}

async function archiveToS3(draft: DocumentDraft): Promise<ArchiveResult> {
  if (!bucket) return { backend: 'none' };
  const key = archiveKeyFor(draft);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: draft.content, ContentType: 'text/plain; charset=utf-8' })
  );
  return { backend: 's3', archiveKey: key };
}

async function archiveToWebhook(draft: DocumentDraft): Promise<ArchiveResult> {
  if (!archiveWebhookUrl) return { backend: 'none' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(archiveWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${archiveWebhookSecret}` },
      body: JSON.stringify({
        document_type: draft.type,
        title: draft.title,
        content: draft.content,
        cycle_name: draft.cycleName,
        employee_name: draft.employeeName,
        employee_id: draft.employeeId,
        author_employee_id: draft.authorEmployeeId,
        visibility: draft.visibility,
        idempotency_key: `${draft.sourceEntityId}-v${draft.sourceVersion}`,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Archive webhook failed with status ${response.status}`);
    const data = (await response.json()) as {
      archiveUrl?: string;
      fileUrl?: string;
      archiveKey?: string;
      fileId?: string;
    };
    return {
      backend: 'webhook',
      archiveUrl: data.archiveUrl ?? data.fileUrl,
      archiveKey: data.archiveKey ?? data.fileId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function archiveDocument(draft: DocumentDraft): Promise<ArchiveResult> {
  if (archiveWebhookUrl) return archiveToWebhook(draft);
  if (bucket) return archiveToS3(draft);
  return { backend: 'none' };
}

async function persistDocument(draft: DocumentDraft): Promise<DocumentRecord> {
  let archiveResult: ArchiveResult = { backend: 'none' };
  try {
    archiveResult = await archiveDocument(draft);
  } catch (error) {
    logger.error('External document archive failed', {
      type: draft.type,
      sourceEntityId: draft.sourceEntityId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  return saveDocument({
    employeeId: draft.employeeId,
    cycleId: draft.cycleId,
    docType: draft.type,
    sourceEntityId: draft.sourceEntityId,
    sourceVersion: draft.sourceVersion,
    contentHash: contentHash(draft.content),
    title: draft.title,
    content: draft.content,
    authorEmployeeId: draft.authorEmployeeId,
    visibility: draft.visibility,
    archiveBackend: archiveResult.backend,
    archiveUrl: archiveResult.archiveUrl,
    archiveKey: archiveResult.archiveKey,
  });
}

/** Short-lived presigned link — never a permanent public URL. Only call after the caller has
 * already authorized the requester for this document. */
export async function presignDocumentUrl(
  document: DocumentRecord,
  expiresInSeconds = 300
): Promise<string | undefined> {
  if (document.archive_backend !== 's3' || !document.archive_key || !bucket) return undefined;
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: document.archive_key }), {
    expiresIn: expiresInSeconds,
  });
}

const STATUS_LABELS: Record<ManagerReview['status'], string> = {
  on_track: 'Doing Great',
  needs_focus: 'Needs Focus',
  at_risk: 'At Risk',
};

function atRiskLines(details: AtRiskDetails | undefined): Array<string | undefined | false> {
  if (!details) return [];
  return [
    details.concrete_examples ? 'Concrete examples' : undefined,
    details.concrete_examples,
    details.prior_communication ? 'Prior communication' : undefined,
    details.prior_communication,
    details.support_provided ? 'Support already provided' : undefined,
    details.support_provided,
    details.expected_improvement ? 'Expected improvement' : undefined,
    details.expected_improvement,
    details.timeline ? `Timeline: ${details.timeline}` : undefined,
    details.people_involvement ? 'People involvement' : undefined,
    details.people_involvement,
  ];
}

export async function generateAndStoreManagerReview(review: ManagerReview, cycleName: string): Promise<DocumentRecord> {
  const employee = await getEmployeeById(review.employee_id);
  const manager = await getEmployeeById(review.manager_id);
  const empName = employee?.name ?? 'Unknown';
  const mgrName = manager?.name ?? 'Unknown';

  const content = chunkLines([
    'Performance Review',
    `Employee: ${empName}`,
    `Manager: ${mgrName}`,
    `Cycle: ${cycleName}`,
    `Status: ${STATUS_LABELS[review.status]}`,
    `Released: ${format(new Date(), 'yyyy-MM-dd')}`,
    '',
    '---',
    '',
    review.strengths ? 'Strengths' : undefined,
    review.strengths,
    review.focus_areas ? 'Focus areas' : undefined,
    review.focus_areas,
    review.development_areas ? 'Development areas' : undefined,
    review.development_areas,
    review.next_cycle_expectations ? 'Next cycle expectations' : undefined,
    review.next_cycle_expectations,
    review.manager_support ? 'Manager support' : undefined,
    review.manager_support,
    ...atRiskLines(review.at_risk),
  ]);

  return persistDocument({
    employeeId: review.employee_id,
    cycleId: review.cycle_id,
    type: 'manager_review',
    sourceEntityId: review.id,
    sourceVersion: review.version,
    title: `${cycleName} performance review for ${empName}`,
    content,
    authorEmployeeId: review.manager_id,
    visibility: 'employee_and_manager',
    cycleName,
    employeeName: safeFolderName(empName),
  });
}

export async function generateAndStorePeerFeedback(feedback: PeerFeedback, cycleName: string): Promise<DocumentRecord> {
  const employee = await getEmployeeById(feedback.employee_id);
  const employeeName = employee?.name ?? 'Unknown';

  const content = chunkLines([
    'Peer Feedback (anonymized)',
    `Employee: ${employeeName}`,
    `Cycle: ${cycleName}`,
    '',
    '---',
    '',
    feedback.strengths ? 'Strengths' : undefined,
    feedback.strengths,
    feedback.growth_areas ? 'Growth areas' : undefined,
    feedback.growth_areas,
    feedback.example ? 'Example' : undefined,
    feedback.example,
  ]);

  return persistDocument({
    employeeId: feedback.employee_id,
    cycleId: feedback.cycle_id,
    type: 'peer_feedback',
    sourceEntityId: feedback.id,
    sourceVersion: 1,
    title: `${cycleName} peer feedback for ${employeeName}`,
    content,
    authorEmployeeId: undefined, // peer author identity is never written into an employee-visible document
    visibility: 'employee',
    cycleName,
    employeeName: safeFolderName(employeeName),
  });
}

export async function generateAndStoreUpwardFeedback(
  feedback: UpwardFeedback,
  cycleName: string
): Promise<DocumentRecord> {
  const manager = await getEmployeeById(feedback.manager_id);
  const managerName = manager?.name ?? 'Unknown';

  const content = chunkLines([
    'Upward Feedback (HR-only raw submission)',
    `Manager: ${managerName}`,
    `Cycle: ${cycleName}`,
    '',
    feedback.strengths ? 'What the manager does well' : undefined,
    feedback.strengths,
    feedback.improvements ? 'What would make them more effective' : undefined,
    feedback.improvements,
    feedback.hr_notes ? 'Anything else HR should know' : undefined,
    feedback.hr_notes,
    `Allow People follow-up: ${feedback.allow_hr_followup ? 'Yes' : 'No'}`,
  ]);

  return persistDocument({
    employeeId: feedback.manager_id,
    cycleId: feedback.cycle_id,
    type: 'upward_feedback',
    sourceEntityId: feedback.id,
    sourceVersion: 1,
    title: `${cycleName} upward feedback for ${managerName}`,
    content,
    authorEmployeeId: feedback.employee_id,
    visibility: 'hr',
    cycleName,
    employeeName: safeFolderName(managerName),
  });
}
