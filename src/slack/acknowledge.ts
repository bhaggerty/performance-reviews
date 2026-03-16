import type { SlackActionMiddlewareArgs, BlockAction, AllMiddlewareArgs } from '@slack/bolt';
import { getEmployeeForSlackUser } from './middleware';
import { getEmployeeById } from '../db/employees';
import { acknowledgeReview, getManagerReview } from '../db/reviews';
import { logAudit } from '../db/audit';

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
  const statusLabel = review.status === 'on_track' ? 'On Track' : review.status === 'needs_focus' ? 'Needs Focus' : 'At Risk';
  let text = `*Manager:* ${manager?.name ?? '—'}\n*Status:* ${statusLabel}\n*Submitted:* ${review.submitted_at}\n\n`;
  if (review.strengths) text += `*Strengths:*\n${review.strengths}\n\n`;
  if (review.focus_areas) text += `*Focus areas:*\n${review.focus_areas}\n\n`;
  if (review.development_areas) text += `*Development areas:*\n${review.development_areas}\n\n`;
  if (review.primary_concerns) text += `*Concerns:*\n${review.primary_concerns}\n\n`;
  if (review.acknowledged_at) text += `_Acknowledged: ${review.acknowledged_at}_`;

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'My performance review' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    },
  });
}
