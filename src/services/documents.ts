import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';
import { saveDocument } from '../db/documents';
import type { ManagerReview } from '../types';
import { getEmployeeById } from '../db/employees';
import { format } from 'date-fns';

const s3 = new S3Client({ region: config.aws.region });
const Bucket = config.aws.s3Bucket;
const Prefix = config.aws.s3Prefix;

if (!Bucket) {
  console.warn('S3_BUCKET not set; document upload will be skipped.');
}

/**
 * S3 path structure:
 * Performance Reviews/2026-H1/Manager Reviews/{employeeName}-review.txt
 * Performance Reviews/2026-H1/Peer Feedback/
 * Performance Reviews/2026-H1/Upward Feedback/
 * Employees/{Employee Name}/Performance Reviews/2026-H1/...
 */
function cycleFolderName(cycleName: string): string {
  return cycleName.replace(/\s+/g, '-');
}

function employeeFolderName(name: string): string {
  return name.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ');
}

export async function generateAndStoreManagerReview(
  review: ManagerReview,
  cycleName: string
): Promise<string | null> {
  if (!Bucket) return null;

  const employee = await getEmployeeById(review.employee_id);
  const manager = await getEmployeeById(review.manager_id);
  const empName = employee?.name ?? 'Unknown';
  const mgrName = manager?.name ?? 'Unknown';
  const statusLabel =
    review.status === 'on_track' ? 'On Track' : review.status === 'needs_focus' ? 'Needs Focus' : 'At Risk';

  const lines: string[] = [
    `Performance Review`,
    `Employee: ${empName}`,
    `Manager: ${mgrName}`,
    `Cycle: ${cycleName}`,
    `Status: ${statusLabel}`,
    `Submitted: ${review.submitted_at}`,
    '',
    '---',
    '',
  ];
  if (review.strengths) {
    lines.push('Strengths');
    lines.push(review.strengths);
    lines.push('');
  }
  if (review.focus_areas) {
    lines.push('Focus areas');
    lines.push(review.focus_areas);
    lines.push('');
  }
  if (review.development_areas) {
    lines.push('Development areas');
    lines.push(review.development_areas);
    lines.push('');
  }
  if (review.primary_concerns) {
    lines.push('Primary concerns');
    lines.push(review.primary_concerns);
    lines.push('');
    if (review.communicated_previously !== undefined) {
      lines.push('Prior communication: ' + (review.communicated_previously ? 'Yes' : 'No'));
      lines.push('');
    }
    if (review.required_improvement) {
      lines.push('Required improvement');
      lines.push(review.required_improvement);
      lines.push('');
    }
    if (review.improvement_timeline) {
      lines.push('Timeline: ' + review.improvement_timeline);
      lines.push('');
    }
    if (review.hr_review_required) {
      lines.push('HR review requested: Yes');
      lines.push('');
    }
  }
  if (review.acknowledged_at) {
    lines.push('Acknowledged: ' + review.acknowledged_at);
    if (review.acknowledgment_comment) lines.push('Comment: ' + review.acknowledgment_comment);
  }

  const body = lines.join('\n');
  const cycleFolder = cycleFolderName(cycleName);
  const empFolder = employeeFolderName(empName);
  const fileName = `${empFolder}-review-${format(new Date(review.submitted_at), 'yyyy-MM-dd')}.txt`;

  // Cycle folder: Performance Reviews/2026-H1/Manager Reviews/
  const cycleKey = `${Prefix}/${cycleFolder}/Manager Reviews/${fileName}`;
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: cycleKey,
      Body: body,
      ContentType: 'text/plain; charset=utf-8',
    })
  );

  // Employee folder: Performance Reviews/Employees/Blake Haggerty/2026-H1/
  const employeeKey = `${Prefix}/Employees/${empFolder}/Performance Reviews/${cycleFolder}/${fileName}`;
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: employeeKey,
      Body: body,
      ContentType: 'text/plain; charset=utf-8',
    })
  );

  const fileUrl = `https://${Bucket}.s3.${config.aws.region}.amazonaws.com/${cycleKey}`;
  await saveDocument(
    review.employee_id,
    review.cycle_id,
    'manager_review',
    fileUrl,
    cycleKey
  );
  return fileUrl;
}
