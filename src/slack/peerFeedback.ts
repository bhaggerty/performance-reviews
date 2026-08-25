import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackOptionsMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { View } from '@slack/types';
import { getActorForSlackUser } from './middleware';
import { getEmployeeById, listEmployees } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import {
  createPeerRequest,
  getPeerRequestByPublicId,
  listPendingRequestsForPeer,
  listRequestsSentByEmployee,
  savePeerFeedback,
  updatePeerRequestStatus,
} from '../db/peerFeedback';
import { logAudit } from '../db/audit';
import { generateAndStorePeerFeedback } from '../services/documents';
import { requirePeerRequestRecipient, requireActiveEmployee } from '../domain/authz';
import { requireCyclePhase } from '../domain/cycleStateMachine';
import { claimSlackDelivery } from './idempotency';
import { sendDirectMessage } from './dm';
import { escapeMrkdwn } from '../domain/slackFormat';

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

export async function loadPeerOptions(
  args: SlackOptionsMiddlewareArgs<'block_suggestion'> & AllMiddlewareArgs
): Promise<void> {
  const { body, ack } = args;
  const searchTerm = ('value' in body ? body.value : '').toLowerCase();
  const requesterSlackId = 'user' in body ? body.user?.id : undefined;
  const requester = await getActorForSlackUser(requesterSlackId);
  const all = await listEmployees();
  const options = all
    .filter((e) => e.status === 'active' && e.id !== requester?.employee.id)
    .filter((e) => !searchTerm || e.name.toLowerCase().includes(searchTerm))
    .slice(0, 100)
    .map((e) => ({
      text: { type: 'plain_text' as const, text: `${e.name} (${e.department || '—'})`.slice(0, 75) },
      value: e.id,
    }));
  await ack({ options });
}

function buildPeerFeedbackView(args: {
  requesterName: string;
  privateMetadata: string;
  values?: { strengths?: string; growthAreas?: string; example?: string };
}): View {
  const v = args.values ?? {};
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
          text: `Share feedback for *${escapeMrkdwn(args.requesterName)}*'s performance review. Your name will not be shown to them.`,
        },
      },
      {
        type: 'input',
        block_id: 'peer_feedback::strengths',
        label: { type: 'plain_text', text: 'Strengths' },
        element: { type: 'plain_text_input', action_id: 'strengths', multiline: true, initial_value: v.strengths },
      },
      {
        type: 'input',
        block_id: 'peer_feedback::growth',
        label: { type: 'plain_text', text: 'Growth areas' },
        element: { type: 'plain_text_input', action_id: 'growth_areas', multiline: true, initial_value: v.growthAreas },
      },
      {
        type: 'input',
        block_id: 'peer_feedback::example',
        label: { type: 'plain_text', text: 'Example (optional)' },
        optional: true,
        element: { type: 'plain_text_input', action_id: 'example', multiline: true, initial_value: v.example },
      },
    ],
  };
}

export async function openRequestPeerFeedbackModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const triggerId = body.trigger_id;
  const actor = await getActorForSlackUser(body.user?.id);
  const cycle = await getActiveCycle();
  if (!actor || !cycle) {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal(
        'Request Peer Feedback',
        !actor ? "You're not in the employee directory." : 'No active review cycle.'
      ),
    });
    return;
  }
  try {
    requireCyclePhase(cycle.status, 'peer_request');
  } catch {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Request Peer Feedback', `Peer requests are not open right now (cycle phase: ${cycle.status}).`),
    });
    return;
  }

  const alreadySent = (await listRequestsSentByEmployee(actor.employee.id)).filter(
    (r) => r.cycle_id === cycle.id && r.status !== 'cancelled' && r.status !== 'declined'
  );

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'peer_feedback_request_submit',
      title: { type: 'plain_text', text: 'Request Peer Feedback' },
      submit: { type: 'plain_text', text: 'Send request' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ cycle_id: cycle.id, requester_id: actor.employee.id }),
      blocks: [
        {
          type: 'input',
          block_id: blockId('peer', 'peers'),
          label: {
            type: 'plain_text',
            text: `Select peers (up to ${cycle.max_peers} total; ${alreadySent.length} already requested)`,
          },
          element: {
            type: 'multi_external_select',
            action_id: 'peers',
            placeholder: { type: 'plain_text', text: 'Search for a colleague' },
            min_query_length: 0,
            max_selected_items: Math.max(cycle.max_peers - alreadySent.length, 1),
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

  const isFirst = await claimSlackDelivery('peer_feedback_request_submit', body);
  if (!isFirst) return;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, requester_id: requesterId } = meta;
  const requesterActor = await getActorForSlackUser(body.user?.id);
  if (!requesterActor || requesterActor.employee.id !== requesterId) return;

  const cycle = await getActiveCycle();
  if (!cycle || cycle.id !== cycleId) return;

  const state = view.state?.values ?? {};
  const peersBlock = Object.keys(state).find((key) => key.includes('peers'));
  const peerIds = peersBlock
    ? ((state[peersBlock]?.peers as { selected_options?: { value: string }[] })?.selected_options ?? []).map(
        (o) => o.value
      )
    : [];
  const focusBlock = Object.keys(state).find((key) => key.includes('focus'));
  const focusArea = focusBlock ? (state[focusBlock]?.focus_area as { value?: string })?.value : undefined;
  if (peerIds.length === 0) return;

  const requester = await getEmployeeById(requesterId);
  for (const peerId of peerIds) {
    if (peerId === requesterId) continue;
    const peer = await getEmployeeById(peerId);
    if (!peer || peer.status !== 'active') continue;

    const { request, created } = await createPeerRequest(cycleId, requesterId, peerId, focusArea);
    if (!created) continue; // idempotent: already requested, don't re-notify

    if (peer.slack_id) {
      await sendDirectMessage(
        client,
        peer.slack_id,
        `${requester?.name ?? 'A colleague'} requested feedback for their performance review.`,
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${escapeMrkdwn(requester?.name ?? 'A colleague')}* requested feedback for their performance review.${focusArea ? `\nFocus: ${escapeMrkdwn(focusArea)}` : ''}`,
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
        ]
      );
    }
  }

  await logAudit({
    entity_type: 'peer_request',
    entity_id: requesterId,
    action: 'request',
    actor_id: requesterId,
    actor_slack_id: body.user?.id,
    cycle_id: cycleId,
    details: { peer_count: peerIds.length },
  });
}

async function openPeerFeedbackModalForRequest(
  client: Parameters<typeof openRequestPeerFeedbackModal>[0]['client'],
  triggerId: string,
  requestId: string
): Promise<void> {
  const request = await getPeerRequestByPublicId(requestId);
  if (!request) return;
  const requester = await getEmployeeById(request.requester_id);
  const cycle = await getCycleById(request.cycle_id);
  await client.views.open({
    trigger_id: triggerId,
    view: buildPeerFeedbackView({
      requesterName: requester?.name ?? 'this person',
      privateMetadata: JSON.stringify({
        request_id: requestId,
        cycle_id: request.cycle_id,
        cycle_name: cycle?.name,
        employee_id: request.requester_id,
        peer_id: request.peer_id,
      }),
    }),
  });
}

export async function handlePeerAccept(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();
  const requestId = (action as { value?: string }).value;
  if (!requestId) return;
  const request = await getPeerRequestByPublicId(requestId);
  if (!request) return;
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;
  try {
    requirePeerRequestRecipient(actor, request);
  } catch {
    return;
  }
  if (request.status === 'pending') await updatePeerRequestStatus(request, 'accepted');
  await openPeerFeedbackModalForRequest(client, body.trigger_id, requestId);
}

/** Re-opens an already-accepted request's feedback form — the App Home entry point that
 * keeps an accepted request resumable even if the original modal was closed. */
export async function handleResumePeerRequest(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();
  const requestId = (action as { value?: string }).value;
  if (!requestId) return;
  const request = await getPeerRequestByPublicId(requestId);
  if (!request) return;
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;
  try {
    requirePeerRequestRecipient(actor, request);
  } catch {
    return;
  }
  if (request.status !== 'accepted') return;
  await openPeerFeedbackModalForRequest(client, body.trigger_id, requestId);
}

export async function viewMyPeerRequests(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;
  const pending = await listPendingRequestsForPeer(actor.employee.id);
  const lines: string[] = [];
  for (const req of pending) {
    const requester = await getEmployeeById(req.requester_id);
    lines.push(
      `• *${escapeMrkdwn(requester?.name ?? 'Someone')}* — ${req.status}${req.status === 'accepted' ? ' (write feedback →)' : ''}`
    );
  }
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'My peer requests' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || 'No open peer requests.' } },
        ...pending
          .filter((r) => r.status === 'accepted')
          .map((r) => ({
            type: 'actions' as const,
            elements: [
              {
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: 'Write feedback' },
                action_id: 'peer_resume',
                value: r.id,
              },
            ],
          })),
      ],
    },
  });
}

export async function handlePeerDecline(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, ack, action } = args;
  await ack?.();
  const requestId = (action as { value?: string }).value;
  if (!requestId) return;
  const request = await getPeerRequestByPublicId(requestId);
  if (!request) return;
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;
  try {
    requirePeerRequestRecipient(actor, request);
  } catch {
    return;
  }
  if (request.status === 'pending') await updatePeerRequestStatus(request, 'declined');
}

export async function handlePeerFeedbackSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, view, ack } = args;
  await ack();

  const isFirst = await claimSlackDelivery('peer_feedback_submit', body);
  if (!isFirst) return;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const {
    request_id: requestId,
    cycle_id: cycleId,
    cycle_name: cycleName,
    employee_id: employeeId,
    peer_id: peerId,
  } = meta;
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) return;

  const request = await getPeerRequestByPublicId(requestId);
  if (!request || request.peer_id !== peerId || request.requester_id !== employeeId) return;
  try {
    requirePeerRequestRecipient(actor, request);
    requireActiveEmployee(actor);
  } catch {
    return;
  }
  if (request.status !== 'accepted') return; // already submitted or no longer valid — idempotent no-op

  const cycle = await getCycleById(cycleId);
  try {
    if (cycle) requireCyclePhase(cycle.status, 'peer_feedback_submit');
  } catch {
    return;
  }

  const state = (view.state?.values ?? {}) as Record<string, Record<string, { value?: string }>>;
  const strengths = Object.values(state).find((b) => b.strengths)?.strengths?.value;
  const growthAreas = Object.values(state).find((b) => b.growth_areas)?.growth_areas?.value;
  const example = Object.values(state).find((b) => b.example)?.example?.value;

  try {
    const feedback = await savePeerFeedback(cycleId, employeeId, peerId, requestId, {
      strengths,
      growth_areas: growthAreas,
      example,
    });
    await updatePeerRequestStatus(request, 'submitted');

    await logAudit({
      entity_type: 'peer_feedback',
      entity_id: requestId,
      action: 'submit',
      actor_id: peerId,
      actor_slack_id: body.user?.id,
      cycle_id: cycleId,
    });

    if (cycleName) {
      await generateAndStorePeerFeedback(feedback, cycleName).catch(() => undefined);
    }

    const requester = await getEmployeeById(employeeId);
    if (requester?.slack_id) {
      await sendDirectMessage(
        args.client,
        requester.slack_id,
        'A peer submitted feedback for your performance review.'
      );
    }
  } catch {
    // Duplicate final submission — savePeerFeedback's conditional write already rejected it.
  }
}

function infoModal(title: string, text: string): View {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title.slice(0, 24) },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}
