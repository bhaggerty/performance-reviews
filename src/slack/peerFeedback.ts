import type { SlackActionMiddlewareArgs, SlackViewMiddlewareArgs, BlockAction, ViewSubmitAction, AllMiddlewareArgs } from '@slack/bolt';
import { getEmployeeForSlackUser } from './middleware';
import { getEmployeeById, listEmployees } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import { createPeerRequest, getPeerRequest, updatePeerRequestStatus, savePeerFeedback, getPeerFeedbackForEmployee } from '../db/peerFeedback';
import { logAudit } from '../db/audit';
import { generateAndStorePeerFeedback } from '../services/documents';

const MAX_PEERS = 3;

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

export async function openRequestPeerFeedbackModal(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();

  const slackUserId = body.user?.id ?? '';
  const employee = await getEmployeeForSlackUser(slackUserId);
  const cycle = await getActiveCycle();

  if (!employee || !cycle) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Request Peer Feedback' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: !employee ? "You're not in the employee directory." : 'No active review cycle.',
            },
          },
        ],
      },
    });
    return;
  }

  const all = await listEmployees();
  const peerOptions = all
    .filter((e) => e.id !== employee.id && e.status === 'active')
    .slice(0, 100)
    .map((e) => ({
      text: { type: 'plain_text' as const, text: `${e.name} (${e.department || '—'})` },
      value: e.id,
    }));

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      callback_id: 'peer_feedback_request_submit',
      title: { type: 'plain_text', text: 'Request Peer Feedback' },
      submit: { type: 'plain_text', text: 'Send request' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ cycle_id: cycle.id, requester_id: employee.id }),
      blocks: [
        {
          type: 'input',
          block_id: blockId('peer', 'peers'),
          label: { type: 'plain_text', text: `Select peers (max ${MAX_PEERS})` },
          element: {
            type: 'multi_static_select',
            action_id: 'peers',
            placeholder: { type: 'plain_text', text: 'Select up to 3 peers' },
            options: peerOptions,
            max_selected_items: MAX_PEERS,
          },
        },
        {
          type: 'input',
          block_id: blockId('peer', 'focus'),
          label: { type: 'plain_text', text: 'Optional focus area' },
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'focus_area',
            placeholder: { type: 'plain_text', text: 'e.g. Project leadership' },
          },
        },
      ],
    },
  });
}

function getSelectedValues(
  state: Record<string, Record<string, { selected_options?: { value: string }[] }>>,
  blockKey: string,
  actionKey: string
): string[] {
  for (const k of Object.keys(state)) {
    if (!k.includes(blockKey)) continue;
    const opts = state[k]?.[actionKey]?.selected_options;
    if (opts) return opts.map((o) => o.value);
  }
  return [];
}

export async function handlePeerFeedbackRequestSubmit(args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack, view } = args;
  await ack();

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, requester_id: requesterId } = meta;
  const state = (view.state?.values ?? {}) as Record<string, Record<string, { selected_options?: { value: string }[] }>>;
  const peerIds = getSelectedValues(state, 'peers', 'peers');
  const focusBlock = Object.keys(state).find((k) => k.includes('focus'));
  const focusArea = focusBlock ? (state[focusBlock]?.focus_area as { value?: string })?.value : undefined;

  if (!cycleId || !requesterId || peerIds.length === 0) return;

  const requester = await getEmployeeById(requesterId);
  for (const peerId of peerIds) {
    const req = await createPeerRequest(cycleId, requesterId, peerId, focusArea);
    const peer = await getEmployeeById(peerId);
    const peerSlackId = peer?.slack_id;
    if (peerSlackId) {
      await client.chat.postMessage({
        channel: peerSlackId,
        text: `${requester?.name ?? 'A colleague'} requested feedback for their performance review.`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${requester?.name ?? 'A colleague'}* requested feedback for their performance review.${focusArea ? `\nFocus: ${focusArea}` : ''}`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Accept', emoji: true },
                action_id: 'peer_accept',
                value: req.id,
                style: 'primary',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Decline', emoji: true },
                action_id: 'peer_decline',
                value: req.id,
              },
            ],
          },
        ],
      });
    }
  }

  await logAudit({
    entity_type: 'peer_request',
    entity_id: requesterId,
    action: 'request',
    actor_id: requesterId,
    actor_slack_id: body.user?.id,
    details: { cycle_id: cycleId, peer_ids: peerIds },
  });
}

export async function handlePeerAccept(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();

  const requestId = (action as { value?: string }).value;
  if (!requestId) return;

  const req = await getPeerRequest(requestId);
  if (!req || req.status !== 'pending') return;

  await updatePeerRequestStatus(requestId, 'accepted');

  const requester = await getEmployeeById(req.requester_id);
  const cycle = await getActiveCycle();
  if (!cycle || cycle.id !== req.cycle_id) return;

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      callback_id: 'peer_feedback_submit',
      title: { type: 'plain_text', text: 'Peer feedback' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({
        request_id: requestId,
        cycle_id: req.cycle_id,
        employee_id: req.requester_id,
        peer_id: req.peer_id,
      }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Share feedback for *${requester?.name ?? 'this person'}'s* performance review.`,
          },
        },
        {
          type: 'input',
          block_id: 'peer_feedback::strengths',
          label: { type: 'plain_text', text: 'Strengths' },
          element: {
            type: 'plain_text_input',
            action_id: 'strengths',
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: 'peer_feedback::growth',
          label: { type: 'plain_text', text: 'Growth areas' },
          element: {
            type: 'plain_text_input',
            action_id: 'growth_areas',
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: 'peer_feedback::example',
          label: { type: 'plain_text', text: 'Example (optional)' },
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'example',
            multiline: true,
          },
        },
      ],
    },
  });
}

export async function handlePeerDecline(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { ack, action } = args;
  await ack?.();
  const requestId = (action as { value?: string }).value;
  if (requestId) await updatePeerRequestStatus(requestId, 'declined');
}

function getVal(
  state: Record<string, Record<string, { value?: string }>>,
  blockKey: string,
  actionKey: string
): string | undefined {
  for (const k of Object.keys(state)) {
    if (!k.includes(blockKey)) continue;
    return state[k]?.[actionKey]?.value;
  }
  return undefined;
}

export async function handlePeerFeedbackSubmit(args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs): Promise<void> {
  const { body, view, ack } = args;
  await ack();

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { request_id: requestId, cycle_id: cycleId, employee_id: employeeId, peer_id: peerId } = meta;
  const state = (view.state?.values ?? {}) as Record<string, Record<string, { value?: string }>>;
  const feedback = await savePeerFeedback(cycleId, employeeId, peerId, requestId, {
    strengths: getVal(state, 'strengths', 'strengths'),
    growth_areas: getVal(state, 'growth', 'growth_areas'),
    example: getVal(state, 'example', 'example'),
  });

  await logAudit({
    entity_type: 'peer_feedback',
    entity_id: requestId,
    action: 'submit',
    actor_id: peerId,
    actor_slack_id: body.user?.id,
    details: { cycle_id: cycleId, employee_id: employeeId },
  });

  const cycle = await getCycleById(cycleId);
  if (cycle) {
    await generateAndStorePeerFeedback(feedback, cycle.name).catch((err) =>
      console.error('Peer feedback document persistence failed:', err)
    );
  }
}
