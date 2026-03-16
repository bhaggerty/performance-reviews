import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { View } from '@slack/types';
import { getEmployeeForSlackUser } from './middleware';
import { getEmployeeById, listEmployees } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import {
  createPeerRequest,
  getPeerRequest,
  savePeerFeedback,
  updatePeerRequestStatus,
} from '../db/peerFeedback';
import { logAudit } from '../db/audit';
import { generateAndStorePeerFeedback } from '../services/documents';
import { formatFollowupNotes, maybeGenerateFollowupQuestions } from '../services/reviewCoach';

const MAX_PEERS = 3;

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

function getSelectedValues(
  state: Record<string, Record<string, { selected_options?: { value: string }[] }>>,
  blockKey: string,
  actionKey: string
): string[] {
  for (const key of Object.keys(state)) {
    if (!key.includes(blockKey)) continue;
    const options = state[key]?.[actionKey]?.selected_options;
    if (options) return options.map((option) => option.value);
  }
  return [];
}

function getVal(
  state: Record<string, Record<string, { value?: string }>>,
  blockKey: string,
  actionKey: string
): string | undefined {
  for (const key of Object.keys(state)) {
    if (!key.includes(blockKey)) continue;
    return state[key]?.[actionKey]?.value;
  }
  return undefined;
}

function collectPeerFollowupAnswers(
  state: Record<string, Record<string, { value?: string }>>
): string[] {
  return Object.keys(state)
    .filter((key) => key.includes('followup'))
    .sort()
    .map((key) => {
      const actionKey = Object.keys(state[key] ?? {})[0];
      return actionKey ? state[key]?.[actionKey]?.value?.trim() ?? '' : '';
    })
    .filter(Boolean);
}

function buildPeerFeedbackView(args: {
  requesterName: string;
  privateMetadata: string;
  values?: { strengths?: string; growthAreas?: string; example?: string };
  followupQuestions?: string[];
}): View {
  const values = args.values ?? {};
  const followupQuestions = args.followupQuestions ?? [];

  return {
    type: 'modal',
    callback_id: 'peer_feedback_submit',
    title: { type: 'plain_text', text: 'Peer feedback' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: args.privateMetadata,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Share feedback for *${args.requesterName}*'s performance review.`,
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
          initial_value: values.strengths,
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
          initial_value: values.growthAreas,
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
          initial_value: values.example,
        },
      },
      ...(followupQuestions.length
        ? [
            { type: 'divider' as const },
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: 'A quick review coach pass thinks a little more specificity would help. Please answer these follow-up questions before submitting.',
              },
            },
            ...followupQuestions.map((question, index) => ({
              type: 'input' as const,
              block_id: `peer_feedback::followup::${index}`,
              label: { type: 'plain_text' as const, text: `Follow-up ${index + 1}` },
              element: {
                type: 'plain_text_input' as const,
                action_id: `followup_${index}`,
                multiline: true,
              },
              hint: { type: 'plain_text' as const, text: question },
            })),
          ]
        : []),
    ],
  };
}

export async function openRequestPeerFeedbackModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
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

  const allEmployees = await listEmployees();
  const peerOptions = allEmployees
    .filter((candidate) => candidate.id !== employee.id && candidate.status === 'active')
    .slice(0, 100)
    .map((candidate) => ({
      text: {
        type: 'plain_text' as const,
        text: `${candidate.name} (${candidate.department || '-'})`,
      },
      value: candidate.id,
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

export async function handlePeerFeedbackRequestSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, view } = args;
  await ack();

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, requester_id: requesterId } = meta;
  const state = (view.state?.values ?? {}) as Record<
    string,
    Record<string, { selected_options?: { value: string }[] }>
  >;
  const peerIds = getSelectedValues(state, 'peers', 'peers');
  const focusBlock = Object.keys(state).find((key) => key.includes('focus'));
  const focusArea = focusBlock
    ? (state[focusBlock]?.focus_area as { value?: string })?.value
    : undefined;

  if (!cycleId || !requesterId || peerIds.length === 0) return;

  const requester = await getEmployeeById(requesterId);
  for (const peerId of peerIds) {
    const request = await createPeerRequest(cycleId, requesterId, peerId, focusArea);
    const peer = await getEmployeeById(peerId);
    if (!peer?.slack_id) continue;

    await client.chat.postMessage({
      channel: peer.slack_id,
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
              value: request.id,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Decline', emoji: true },
              action_id: 'peer_decline',
              value: request.id,
            },
          ],
        },
      ],
    });
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

export async function handlePeerAccept(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();

  const requestId = (action as { value?: string }).value;
  if (!requestId) return;

  const request = await getPeerRequest(requestId);
  if (!request || request.status !== 'pending') return;

  await updatePeerRequestStatus(requestId, 'accepted');

  const requester = await getEmployeeById(request.requester_id);
  const cycle = await getActiveCycle();
  if (!cycle || cycle.id !== request.cycle_id) return;

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: buildPeerFeedbackView({
      requesterName: requester?.name ?? 'this person',
      privateMetadata: JSON.stringify({
        request_id: requestId,
        cycle_id: request.cycle_id,
        cycle_name: cycle.name,
        employee_id: request.requester_id,
        peer_id: request.peer_id,
      }),
    }),
  });
}

export async function handlePeerDecline(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { ack, action } = args;
  await ack?.();
  const requestId = (action as { value?: string }).value;
  if (requestId) await updatePeerRequestStatus(requestId, 'declined');
}

export async function handlePeerFeedbackSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, view, ack } = args;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const {
    request_id: requestId,
    cycle_id: cycleId,
    cycle_name: cycleName,
    employee_id: employeeId,
    peer_id: peerId,
    followup_stage: followupStage,
    followup_questions: followupQuestions,
  } = meta;
  const state = (view.state?.values ?? {}) as Record<string, Record<string, { value?: string }>>;
  const requester = await getEmployeeById(employeeId);
  const strengths = getVal(state, 'strengths', 'strengths');
  const growthAreas = getVal(state, 'growth', 'growth_areas');
  const example = getVal(state, 'example', 'example');

  if (!followupStage) {
    const coach = await maybeGenerateFollowupQuestions({
      flow: 'peer_feedback',
      subjectName: requester?.name ?? 'Employee',
      cycleName: cycleName ?? 'Current cycle',
      answers: [
        { label: 'Strengths', value: strengths },
        { label: 'Growth areas', value: growthAreas },
        { label: 'Example', value: example },
      ],
    });

    if (coach.needsFollowup) {
      await ack({
        response_action: 'update',
        view: buildPeerFeedbackView({
          requesterName: requester?.name ?? 'this person',
          privateMetadata: JSON.stringify({
            request_id: requestId,
            cycle_id: cycleId,
            cycle_name: cycleName,
            employee_id: employeeId,
            peer_id: peerId,
            followup_stage: true,
            followup_questions: coach.questions,
          }),
          values: { strengths, growthAreas, example },
          followupQuestions: coach.questions,
        }),
      });
      return;
    }
  }

  await ack();

  const feedback = await savePeerFeedback(cycleId, employeeId, peerId, requestId, {
    strengths,
    growth_areas: growthAreas,
    example,
    follow_up_notes: formatFollowupNotes(
      Array.isArray(followupQuestions) ? followupQuestions : [],
      collectPeerFollowupAnswers(state)
    ),
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
    await generateAndStorePeerFeedback(feedback, cycle.name).catch((error) =>
      console.error('Peer feedback document persistence failed:', error)
    );
  }
}
