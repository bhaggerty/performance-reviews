import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { format } from 'date-fns';
import { config } from '../config';
import { saveDocument } from '../db/documents';
import { getEmployeeById } from '../db/employees';
import type {
  DocumentArchiveBackend,
  DocumentRecord,
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
  console.warn('No external document archive configured; canonical review documents will stay in DynamoDB only.');
}

type ArchivePaths = {
  cycleFolder: string;
  employeeFolder: string;
  fileName: string;
};

type DocumentDraft = {
  employeeId: string;
  cycleId: string;
  type: DocumentRecord['type'];
  title: string;
  content: string;
  authorEmployeeId?: string;
  visibility: DocumentVisibility;
  cycleName: string;
  employeeName: string;
  archivePaths: ArchivePaths;
};

type ArchiveResult = {
  backend: DocumentArchiveBackend;
  archiveUrl?: string;
  archiveKey?: string;
};

function cycleFolderName(cycleName: string): string {
  return cycleName.replace(/\s+/g, '-');
}

function employeeFolderName(name: string): string {
  return name.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim();
}

function chunkLines(lines: Array<string | undefined | false>): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}

function archiveTypeFolder(type: DocumentRecord['type']): string {
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

async function archiveToS3(draft: DocumentDraft): Promise<ArchiveResult> {
  if (!bucket) return { backend: 'none' };

  const typeFolder = archiveTypeFolder(draft.type);
  const cycleKey = `${prefix}/${draft.archivePaths.cycleFolder}/${typeFolder}/${draft.archivePaths.fileName}`;
  const employeeKey = `${prefix}/Employees/${draft.archivePaths.employeeFolder}/Performance Reviews/${draft.archivePaths.cycleFolder}/${draft.archivePaths.fileName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: cycleKey,
      Body: draft.content,
      ContentType: 'text/plain; charset=utf-8',
    })
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: employeeKey,
      Body: draft.content,
      ContentType: 'text/plain; charset=utf-8',
    })
  );

  return {
    backend: 's3',
    archiveUrl: `https://${bucket}.s3.${config.aws.region}.amazonaws.com/${employeeKey}`,
    archiveKey: employeeKey,
  };
}

async function archiveToWebhook(draft: DocumentDraft): Promise<ArchiveResult> {
  if (!archiveWebhookUrl) return { backend: 'none' };

  const response = await fetch(archiveWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(archiveWebhookSecret ? { Authorization: `Bearer ${archiveWebhookSecret}` } : {}),
    },
    body: JSON.stringify({
      document_type: draft.type,
      title: draft.title,
      content: draft.content,
      cycle_name: draft.cycleName,
      employee_name: draft.employeeName,
      employee_id: draft.employeeId,
      author_employee_id: draft.authorEmployeeId,
      visibility: draft.visibility,
      archive_paths: draft.archivePaths,
    }),
  });

  if (!response.ok) {
    throw new Error(`Archive webhook failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    fileUrl?: string;
    archiveUrl?: string;
    fileId?: string;
    archiveKey?: string;
  };

  return {
    backend: 'webhook',
    archiveUrl: data.archiveUrl ?? data.fileUrl,
    archiveKey: data.archiveKey ?? data.fileId,
  };
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
    console.error('External document archive failed:', error);
  }

  return saveDocument({
    employeeId: draft.employeeId,
    cycleId: draft.cycleId,
    docType: draft.type,
    title: draft.title,
    content: draft.content,
    authorEmployeeId: draft.authorEmployeeId,
    visibility: draft.visibility,
    archiveBackend: archiveResult.backend,
    archiveUrl: archiveResult.archiveUrl,
    archiveKey: archiveResult.archiveKey,
  });
}

export async function generateAndStoreManagerReview(
  review: ManagerReview,
  cycleName: string
): Promise<DocumentRecord> {
  const employee = await getEmployeeById(review.employee_id);
  const manager = await getEmployeeById(review.manager_id);
  const empName = employee?.name ?? 'Unknown';
  const mgrName = manager?.name ?? 'Unknown';
  const statusLabel =
    review.status === 'on_track' ? 'On Track' : review.status === 'needs_focus' ? 'Needs Focus' : 'At Risk';

  const content = chunkLines([
    'Performance Review',
    `Employee: ${empName}`,
    `Manager: ${mgrName}`,
    `Cycle: ${cycleName}`,
    `Status: ${statusLabel}`,
    `Submitted: ${review.submitted_at}`,
    '',
    '---',
    '',
    review.strengths ? 'Strengths' : undefined,
    review.strengths,
    review.strengths ? '' : undefined,
    review.focus_areas ? 'Focus areas' : undefined,
    review.focus_areas,
    review.focus_areas ? '' : undefined,
    review.development_areas ? 'Development areas' : undefined,
    review.development_areas,
    review.development_areas ? '' : undefined,
    review.next_cycle_expectations ? 'Next cycle expectations' : undefined,
    review.next_cycle_expectations,
    review.next_cycle_expectations ? '' : undefined,
    review.manager_support ? 'Manager support' : undefined,
    review.manager_support,
    review.manager_support ? '' : undefined,
    review.primary_concerns ? 'Primary concerns' : undefined,
    review.primary_concerns,
    review.primary_concerns ? '' : undefined,
    review.communicated_previously !== undefined
      ? `Prior communication: ${review.communicated_previously ? 'Yes' : 'No'}`
      : undefined,
    review.communicated_previously !== undefined ? '' : undefined,
    review.required_improvement ? 'Required improvement' : undefined,
    review.required_improvement,
    review.required_improvement ? '' : undefined,
    review.improvement_timeline ? `Timeline: ${review.improvement_timeline}` : undefined,
    review.improvement_timeline ? '' : undefined,
    review.hr_review_required ? 'HR review requested: Yes' : undefined,
    review.hr_review_required ? '' : undefined,
    review.acknowledged_at ? `Acknowledged: ${review.acknowledged_at}` : undefined,
    review.acknowledgment_comment ? `Acknowledgment comment: ${review.acknowledgment_comment}` : undefined,
  ]);

  const employeeFolder = employeeFolderName(empName);
  const cycleFolder = cycleFolderName(cycleName);

  return persistDocument({
    employeeId: review.employee_id,
    cycleId: review.cycle_id,
    type: 'manager_review',
    title: `${cycleName} performance review for ${empName}`,
    content,
    authorEmployeeId: review.manager_id,
    visibility: 'employee_and_manager',
    cycleName,
    employeeName: empName,
    archivePaths: {
      employeeFolder,
      cycleFolder,
      fileName: `${employeeFolder}-manager-review-${format(new Date(review.submitted_at), 'yyyy-MM-dd')}.txt`,
    },
  });
}

export async function generateAndStorePeerFeedback(
  feedback: PeerFeedback,
  cycleName: string
): Promise<DocumentRecord> {
  const employee = await getEmployeeById(feedback.employee_id);
  const peer = await getEmployeeById(feedback.peer_id);
  const employeeName = employee?.name ?? 'Unknown';
  const peerName = peer?.name ?? 'Unknown';
  const employeeFolder = employeeFolderName(employeeName);
  const cycleFolder = cycleFolderName(cycleName);

  const content = chunkLines([
    'Peer Feedback',
    `Employee: ${employeeName}`,
    `Peer: ${peerName}`,
    `Cycle: ${cycleName}`,
    `Submitted: ${feedback.submitted_at}`,
    '',
    '---',
    '',
    feedback.strengths ? 'Strengths' : undefined,
    feedback.strengths,
    feedback.strengths ? '' : undefined,
    feedback.growth_areas ? 'Growth areas' : undefined,
    feedback.growth_areas,
    feedback.growth_areas ? '' : undefined,
    feedback.example ? 'Example' : undefined,
    feedback.example,
  ]);

  return persistDocument({
    employeeId: feedback.employee_id,
    cycleId: feedback.cycle_id,
    type: 'peer_feedback',
    title: `${cycleName} peer feedback for ${employeeName}`,
    content,
    authorEmployeeId: feedback.peer_id,
    visibility: 'employee',
    cycleName,
    employeeName,
    archivePaths: {
      employeeFolder,
      cycleFolder,
      fileName: `${employeeFolder}-peer-feedback-${format(new Date(feedback.submitted_at), 'yyyy-MM-dd')}.txt`,
    },
  });
}

export async function generateAndStoreUpwardFeedback(
  feedback: UpwardFeedback,
  cycleName: string
): Promise<DocumentRecord> {
  const employee = await getEmployeeById(feedback.employee_id);
  const manager = await getEmployeeById(feedback.manager_id);
  const employeeName = employee?.name ?? 'Unknown';
  const managerName = manager?.name ?? 'Unknown';
  const employeeFolder = employeeFolderName(managerName);
  const cycleFolder = cycleFolderName(cycleName);

  const content = chunkLines([
    'Upward Feedback',
    `Manager: ${managerName}`,
    `Submitted by: ${employeeName}`,
    `Cycle: ${cycleName}`,
    `Submitted: ${feedback.submitted_at}`,
    '',
    'HR-only raw submission',
    '',
    feedback.strengths ? 'What the manager does well' : undefined,
    feedback.strengths,
    feedback.strengths ? '' : undefined,
    feedback.improvements ? 'What would make them more effective' : undefined,
    feedback.improvements,
    feedback.improvements ? '' : undefined,
    feedback.hr_notes ? 'Anything else HR should know' : undefined,
    feedback.hr_notes,
    feedback.hr_notes ? '' : undefined,
    `Allow HR follow-up: ${feedback.allow_hr_followup ? 'Yes' : 'No'}`,
  ]);

  return persistDocument({
    employeeId: feedback.manager_id,
    cycleId: feedback.cycle_id,
    type: 'upward_feedback',
    title: `${cycleName} upward feedback for ${managerName}`,
    content,
    authorEmployeeId: feedback.employee_id,
    visibility: 'hr',
    cycleName,
    employeeName: managerName,
    archivePaths: {
      employeeFolder,
      cycleFolder,
      fileName: `${employeeFolder}-upward-feedback-${format(new Date(feedback.submitted_at), 'yyyy-MM-dd')}.txt`,
    },
  });
}
