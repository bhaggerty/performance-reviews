import type { SlackActionMiddlewareArgs, BlockAction, AllMiddlewareArgs } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { getEmployeeForSlackUser } from './middleware';
import { getEmployeeById } from '../db/employees';
import { acknowledgeReview, getManagerReview, getReviewsAuthoredByManager, getReviewsByEmployee } from '../db/reviews';
import { getDocumentsByEmployeeAndCycle, listDocumentsAuthoredBy, listDocumentsForEmployee } from '../db/documents';
import { listCycles } from '../db/cycles';
import { logAudit } from '../db/audit';
import type { DocumentRecord, ManagerReview } from '../types';

function chunkText(text: string, size = 2800): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length ? chunks : [''];
}

function modalBlocksFromText(title: string, text: string, footer?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title },
    },
  ];

  for (const chunk of chunkText(text)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: chunk },
    });
  }

  if (footer) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: footer }],
    });
  }

  return blocks;
}

function renderReviewSummary(review: ManagerReview, managerName?: string): string {
  const statusLabel =
    review.status === 'on_track' ? 'On Track' : review.status === 'needs_focus' ? 'Needs Focus' : 'At Risk';
  const lines = [
    managerName ? `*Manager:* ${managerName}` : undefined,
    `*Status:* ${statusLabel}`,
    `*Submitted:* ${review.submitted_at}`,
    review.strengths ? `\n*Strengths:*\n${review.strengths}` : undefined,
    review.focus_areas ? `\n*Focus areas:*\n${review.focus_areas}` : undefined,
    review.development_areas ? `\n*Development areas:*\n${review.development_areas}` : undefined,
    review.primary_concerns ? `\n*Concerns:*\n${review.primary_concerns}` : undefined,
    review.acknowledged_at ? `\n_Acknowledged: ${review.acknowledged_at}_` : undefined,
  ];
  return lines.filter(Boolean).join('\n');
}

function cycleNameMap(cycles: Awaited<ReturnType<typeof listCycles>>): Map<string, string> {
  return new Map(cycles.map((cycle) => [cycle.id, cycle.name]));
}

function documentVisibilityFooter(document: DocumentRecord): string | undefined {
  if (document.visibility === 'hr') {
    return 'Archived in the HR-private file. Raw content is HR-only.';
  }
  if (document.archive_url) {
    return `Archived privately: ${document.archive_url}`;
  }
  if (document.archive_backend === 'none') {
    return 'Stored canonically in the app database. External archive not configured.';
  }
  return undefined;
}

export async function handleAcknowledgeReview(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();

  const value = (action as { value?: string }).value;
  if (!value) return;
  const [cycleId, employeeId] = value.split('#');
  if (!cycleId || !employeeId) return;

  const employee = await getEmployeeForSlackUser(body.user?.id ?? '');
  if (!employee || employee.id !== employeeId) return;

  const updated = await acknowledgeReview(cycleId, employeeId);
  if (updated) {
    await logAudit({
      entity_type: 'manager_review',
      entity_id: updated.id,
      action: 'acknowledge',
      actor_id: employee.id,
      actor_slack_id: body.user?.id,
    });
  }

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Review acknowledged' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'You acknowledged your performance review. Optional: add a comment below.',
          },
        },
        {
          type: 'input',
          block_id: 'ack_comment',
          label: { type: 'plain_text', text: 'Comment (optional)' },
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'comment',
            multiline: true,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Done', emoji: true },
              action_id: 'ack_done',
              value: `${cycleId}#${employeeId}`,
            },
          ],
        },
      ],
    },
  });
}

export async function handleViewMyReview(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();

  const value = (action as { value?: string }).value;
  if (!value) return;
  const [cycleId, employeeId] = value.split('#');
  const employee = await getEmployeeForSlackUser(body.user?.id ?? '');
  if (!employee || employee.id !== employeeId) return;

  const docs = await getDocumentsByEmployeeAndCycle(employeeId, cycleId);
  const document = docs.find((doc) => doc.type === 'manager_review');

  if (document) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'My performance review' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: modalBlocksFromText(document.title, document.content, documentVisibilityFooter(document)),
      },
    });
    return;
  }

  const review = await getManagerReview(cycleId, employeeId);
  if (!review) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Review' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Review not found.' } }],
      },
    });
    return;
  }

  const manager = await getEmployeeById(review.manager_id);
  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'My performance review' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: modalBlocksFromText('My performance review', renderReviewSummary(review, manager?.name)),
    },
  });
}

export async function handleViewHistory(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();

  const employee = await getEmployeeForSlackUser(body.user?.id ?? '');
  if (!employee) return;

  const [documents, rawReviews, cycles] = await Promise.all([
    listDocumentsForEmployee(employee.id, ['manager_review', 'peer_feedback']),
    getReviewsByEmployee(employee.id),
    listCycles(),
  ]);
  const cycleNames = cycleNameMap(cycles);

  const reviewDocsByCycle = new Set(
    documents.filter((doc) => doc.type === 'manager_review').map((doc) => doc.cycle_id)
  );

  const historyEntries: string[] = documents
    .filter((doc) => doc.visibility !== 'hr')
    .map((doc) => {
      const cycleName = cycleNames.get(doc.cycle_id) ?? doc.cycle_id;
      const excerpt = doc.content.slice(0, 240).trim();
      return `*${doc.title}*\nCycle: ${cycleName}\nCreated: ${doc.created_at}\n${excerpt}${doc.content.length > 240 ? '...' : ''}`;
    });

  for (const review of rawReviews) {
    if (reviewDocsByCycle.has(review.cycle_id)) continue;
    const cycleName = cycleNames.get(review.cycle_id) ?? review.cycle_id;
    historyEntries.push(
      `*${cycleName} performance review*\nSubmitted: ${review.submitted_at}\n${renderReviewSummary(review)}`
    );
  }

  const text =
    historyEntries.length > 0
      ? historyEntries.join('\n\n---\n\n')
      : 'No received review history yet.';

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'My review history' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: modalBlocksFromText('My review history', text),
    },
  });
}

export async function handleViewWrittenReviews(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();

  const manager = await getEmployeeForSlackUser(body.user?.id ?? '');
  if (!manager) return;

  const [documents, reviews, cycles] = await Promise.all([
    listDocumentsAuthoredBy(manager.id, ['manager_review']),
    getReviewsAuthoredByManager(manager.id),
    listCycles(),
  ]);
  const cycleNames = cycleNameMap(cycles);
  const reviewIdsFromDocs = new Set(documents.map((doc) => `${doc.employee_id}:${doc.cycle_id}`));

  const entries: string[] = [];

  for (const document of documents) {
    const employee = await getEmployeeById(document.employee_id);
    const cycleName = cycleNames.get(document.cycle_id) ?? document.cycle_id;
    const excerpt = document.content.slice(0, 240).trim();
    entries.push(
      `*${employee?.name ?? 'Unknown employee'}*\nCycle: ${cycleName}\n${document.title}\nCreated: ${document.created_at}\n${excerpt}${document.content.length > 240 ? '...' : ''}`
    );
  }

  for (const review of reviews) {
    const key = `${review.employee_id}:${review.cycle_id}`;
    if (reviewIdsFromDocs.has(key)) continue;
    const employee = await getEmployeeById(review.employee_id);
    const cycleName = cycleNames.get(review.cycle_id) ?? review.cycle_id;
    entries.push(
      `*${employee?.name ?? 'Unknown employee'}*\nCycle: ${cycleName}\nSubmitted: ${review.submitted_at}\n${renderReviewSummary(review)}`
    );
  }

  const text =
    entries.length > 0
      ? entries.join('\n\n---\n\n')
      : 'You have not submitted any manager reviews yet.';

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Reviews I wrote' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: modalBlocksFromText('Reviews I wrote', text),
    },
  });
}
