import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { getActorForSlackUser } from './middleware';
import { getEmployeeById } from '../db/employees';
import { getManagerReview, getReviewHistory, listReviewsByManager } from '../db/reviews';
import { getReviewRelease } from '../db/releases';
import { getAcknowledgement, createAcknowledgement } from '../db/acknowledgements';
import { getDocumentById, listDocumentsForEmployee } from '../db/documents';
import { listCycles } from '../db/cycles';
import { logAudit } from '../db/audit';
import { requireReleasedReviewAccess } from '../domain/authz';
import { claimSlackDelivery } from './idempotency';
import { refreshHomeForUser } from './home';
import { sendDirectMessage } from './dm';
import { escapeMrkdwn } from '../domain/slackFormat';

function chunkText(text: string, size = 2800): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function modalBlocksFromText(title: string, text: string, footer?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } }];
  for (const chunk of chunkText(text))
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(chunk) } });
  if (footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });
  return blocks;
}

export async function handleViewMyReview(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();
  const value = (action as { value?: string }).value;
  if (!value) return;
  const [cycleId, employeeId] = value.split('#');
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;

  const release = await getReviewRelease(cycleId, employeeId);
  try {
    requireReleasedReviewAccess(actor, employeeId, Boolean(release));
  } catch (error) {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Review' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: error instanceof Error ? error.message : 'Not available yet.' },
          },
        ],
      },
    });
    return;
  }

  const document = release ? await getDocumentById(employeeId, release.document_id) : null;
  const ack2 = await getAcknowledgement(cycleId, employeeId);
  const footer = ack2 ? `Acknowledged ${ack2.acknowledged_at}` : undefined;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'My performance review' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        ...modalBlocksFromText(
          document?.title ?? 'My performance review',
          document?.content ?? 'Review content unavailable.',
          footer
        ),
        ...(release && !ack2
          ? ([
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Acknowledge', emoji: true },
                    action_id: 'acknowledge_review',
                    value: `${cycleId}#${employeeId}`,
                  },
                ],
              },
            ] as KnownBlock[])
          : []),
      ],
    },
  });
}

export async function handleAcknowledgeReview(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();
  const value = (action as { value?: string }).value;
  if (!value) return;
  const [cycleId, employeeId] = value.split('#');
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;

  const release = await getReviewRelease(cycleId, employeeId);
  try {
    requireReleasedReviewAccess(actor, employeeId, Boolean(release));
  } catch {
    return;
  }
  if (!release) return;

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'ack_submit',
      private_metadata: JSON.stringify({
        cycle_id: cycleId,
        employee_id: employeeId,
        review_version: release.review_version,
      }),
      title: { type: 'plain_text', text: 'Acknowledge review' },
      submit: { type: 'plain_text', text: 'Done' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Acknowledging confirms you have received and read this review. It does not mean you agree with its contents.',
          },
        },
        {
          type: 'input',
          block_id: 'ack_comment',
          optional: true,
          label: { type: 'plain_text', text: 'Optional comment' },
          element: { type: 'plain_text_input', action_id: 'comment', multiline: true },
        },
      ],
    },
  });
}

export async function handleAcknowledgeSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, view, ack, client } = args;
  await ack();

  const isFirst = await claimSlackDelivery('ack_submit', body);
  if (!isFirst) return;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, employee_id: employeeId, review_version: reviewVersion } = meta;
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor || actor.employee.id !== employeeId) return;

  const release = await getReviewRelease(cycleId, employeeId);
  if (!release) return; // review must remain released; this call never mutates the review itself

  const state = view.state?.values ?? {};
  const comment = (state.ack_comment?.comment as { value?: string })?.value?.trim() || undefined;

  const record = await createAcknowledgement({
    cycle_id: cycleId,
    employee_id: employeeId,
    review_version: reviewVersion,
    comment,
  });
  await logAudit({
    entity_type: 'acknowledgement',
    entity_id: employeeId,
    action: 'acknowledge',
    actor_id: employeeId,
    actor_slack_id: body.user?.id,
    cycle_id: cycleId,
    details: { hasComment: Boolean(comment) },
  });

  await refreshHomeForUser(client, body.user.id);

  const review = await getManagerReview(cycleId, employeeId);
  const manager = review ? await getEmployeeById(review.manager_id) : null;
  if (manager?.slack_id) {
    const employee = await getEmployeeById(employeeId);
    await sendDirectMessage(
      client,
      manager.slack_id,
      `${employee?.name ?? 'Your report'} acknowledged their performance review.`
    );
  }
  void record;
}

export async function handleViewHistory(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;

  const [documents, cycles] = await Promise.all([
    listDocumentsForEmployee(actor.employee.id, ['manager_review', 'peer_feedback']),
    listCycles(),
  ]);
  const cycleNames = new Map(cycles.map((c) => [c.id, c.name]));
  const visible = documents.filter((d) => d.visibility !== 'hr');

  const entries = visible.map((doc) => {
    const cycleName = cycleNames.get(doc.cycle_id) ?? doc.cycle_id;
    const excerpt = doc.content.slice(0, 240).trim();
    return `*${escapeMrkdwn(doc.title)}*\nCycle: ${escapeMrkdwn(cycleName)}\n${escapeMrkdwn(excerpt)}${doc.content.length > 240 ? '…' : ''}`;
  });

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'My review history' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: modalBlocksFromText(
        'My review history',
        entries.join('\n\n---\n\n') || 'No released review history yet.'
      ),
    },
  });
}

export async function handleViewWrittenReviews(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;

  const [reviews, cycles] = await Promise.all([listReviewsByManager(actor.employee.id), listCycles()]);
  const cycleNames = new Map(cycles.map((c) => [c.id, c.name]));

  const entries: string[] = [];
  for (const review of reviews) {
    const employee = await getEmployeeById(review.employee_id);
    const history = await getReviewHistory(review.cycle_id, review.employee_id);
    const cycleName = cycleNames.get(review.cycle_id) ?? review.cycle_id;
    entries.push(
      `*${escapeMrkdwn(employee?.name ?? 'Unknown employee')}*\nCycle: ${escapeMrkdwn(cycleName)}\nStatus: ${review.people_state}\nVersions: ${history.length}`
    );
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Reviews I wrote' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: modalBlocksFromText(
        'Reviews I wrote',
        entries.join('\n\n---\n\n') || 'You have not submitted any manager reviews yet.'
      ),
    },
  });
}
