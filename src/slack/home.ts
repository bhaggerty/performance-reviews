import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { getActorForSlackUser } from './middleware';
import { getDirectReports } from '../db/employees';
import { getActiveCycle } from '../db/cycles';
import { getReviewsByCycle, listReviewsByManager } from '../db/reviews';
import { getSelfReflection } from '../db/selfReflections';
import { listPendingRequestsForPeer, listRequestsSentByEmployee } from '../db/peerFeedback';
import { getUpwardFeedbackForEmployee } from '../db/upwardFeedback';
import { getReviewRelease } from '../db/releases';
import { getAcknowledgement } from '../db/acknowledgements';
import { config } from '../config';
import { escapeMrkdwn } from '../domain/slackFormat';

type HomeArgs = SlackEventMiddlewareArgs<'app_home_opened'> & AllMiddlewareArgs;

export async function renderHomeTab(args: HomeArgs): Promise<void> {
  await refreshHomeForUser(args.client, args.event.user);
}

/** Reusable App Home refresh, called after any action that changes what the tab should show
 * (self-reflection save/submit, acknowledgement, peer feedback state changes, ...). */
export async function refreshHomeForUser(client: WebClient, slackUserId: string): Promise<void> {
  const actor = await getActorForSlackUser(slackUserId);
  const cycle = await getActiveCycle();

  if (!actor) {
    await client.views.publish({
      user_id: slackUserId,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: "Hi! You're not in the employee directory yet. Ask People Ops to add you." },
          },
        ],
      },
    });
    return;
  }

  const employee = actor.employee;
  const isManager = (await getDirectReports(employee.id)).length > 0;

  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Performance Reviews', emoji: true } },
  ];

  if (!cycle) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No active review cycle right now.' } });
  } else {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Cycle: *${escapeMrkdwn(cycle.name)}* · phase: ${cycle.status}` }],
    });
    blocks.push({ type: 'divider' });

    const reflection = await getSelfReflection(cycle.id, employee.id);
    const reflectionStatus =
      reflection?.state === 'submitted' ? 'Submitted' : reflection ? 'Draft saved' : 'Not started';
    blocks.push(
      { type: 'section', text: { type: 'mrkdwn', text: `*Self reflection* · ${reflectionStatus}` } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Self reflection', emoji: true },
            action_id: 'self_reflection',
          },
        ],
      }
    );

    const pendingPeerRequests = await listPendingRequestsForPeer(employee.id);
    const sentPeerRequests = await listRequestsSentByEmployee(employee.id);
    const myPendingCount = pendingPeerRequests.filter((r) => r.cycle_id === cycle.id && r.status === 'pending').length;
    const myAcceptedCount = pendingPeerRequests.filter(
      (r) => r.cycle_id === cycle.id && r.status === 'accepted'
    ).length;
    const sentCount = sentPeerRequests.filter((r) => r.cycle_id === cycle.id).length;
    const upward = await getUpwardFeedbackForEmployee(cycle.id, employee.id);

    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Feedback* · Requests sent: ${sentCount} · Awaiting your response: ${myPendingCount} · Accepted (write feedback): ${myAcceptedCount} · Upward feedback: ${upward ? 'Submitted' : 'Not submitted'}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Request peer feedback', emoji: true },
            action_id: 'request_peer_feedback',
          },
          ...(myAcceptedCount > 0 || myPendingCount > 0
            ? [
                {
                  type: 'button' as const,
                  text: { type: 'plain_text' as const, text: 'My peer requests', emoji: true },
                  action_id: 'view_peer_requests',
                },
              ]
            : []),
          ...(employee.manager_id
            ? [
                {
                  type: 'button' as const,
                  text: { type: 'plain_text' as const, text: 'Give upward feedback', emoji: true },
                  action_id: 'upward_feedback',
                },
              ]
            : []),
        ],
      }
    );

    const release = await getReviewRelease(cycle.id, employee.id);
    const ack = release ? await getAcknowledgement(cycle.id, employee.id) : null;
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*My review* · ${release ? (ack ? 'Released · Acknowledged' : 'Released · Please acknowledge') : 'Not yet released'}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View my review', emoji: true },
            action_id: 'view_my_review',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'My review history', emoji: true },
            action_id: 'view_history',
          },
        ],
      }
    );
  }

  if (isManager && cycle) {
    const reports = await getDirectReports(employee.id);
    const cycleReviews = await getReviewsByCycle(cycle.id);
    const lines = reports.map((r) => {
      const review = cycleReviews.find((rev) => rev.employee_id === r.id);
      const status = review ? review.people_state.replace(/_/g, ' ') : 'not started';
      return `• *${escapeMrkdwn(r.name)}* — ${status}`;
    });
    blocks.push(
      { type: 'divider' },
      { type: 'header', text: { type: 'plain_text', text: 'Manager Dashboard', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || 'No direct reports.' } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Write review', emoji: true },
            action_id: 'manager_write_review',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reviews I wrote', emoji: true },
            action_id: 'view_written_reviews',
          },
        ],
      }
    );
    void listReviewsByManager; // available for a future "reviews I wrote" deep view; App Home keeps it lightweight
  }

  if (actor.roles.isPeopleAdmin) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'People Ops administration happens in the web console.' },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Admin Console', emoji: true },
          url: `${config.app.url}/console/`,
          action_id: 'open_admin_console',
        },
      }
    );
  }

  await client.views.publish({ user_id: slackUserId, view: { type: 'home', blocks } });
}
