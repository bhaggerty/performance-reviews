import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';
import { getEmployeeForSlackUser } from './middleware';
import { getDirectReports } from '../db/employees';
import { getActiveCycle } from '../db/cycles';
import { getManagerReview, getReviewsByCycle } from '../db/reviews';
import { getPeerFeedbackForEmployee } from '../db/peerFeedback';
import { getUpwardFeedbackForEmployee } from '../db/upwardFeedback';

type HomeArgs = SlackEventMiddlewareArgs<'app_home_opened'> & AllMiddlewareArgs;

export async function renderHomeTab(args: HomeArgs): Promise<void> {
  const { event, client, context } = args;
  const slackUserId = event.user;
  const employee = await getEmployeeForSlackUser(slackUserId);
  const cycle = await getActiveCycle();

  if (!employee) {
    await client.views.publish({
      user_id: slackUserId,
      view: {
        type: 'home',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "Hi! You're not in the employee directory yet. Ask your admin to add you (or upload the org CSV).",
            },
          },
        ],
      },
    });
    return;
  }

  const isManager = (await getDirectReports(employee.id)).length > 0;
  const cycleName = cycle?.name ?? 'No active cycle';
  const cycleStatus = cycle?.status ?? '—';

  // Employee section: self review, peer feedback, upward feedback, history
  const myReview = employee && cycle ? await getManagerReview(cycle.id, employee.id) : null;
  const peerFeedback =
    employee && cycle ? await getPeerFeedbackForEmployee(cycle.id, employee.id) : [];
  const upwardFeedback =
    employee && cycle ? await getUpwardFeedbackForEmployee(cycle.id, employee.id) : null;

  const blocks: import('@slack/types').KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Performance Reviews', emoji: true },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Cycle: *${cycleName}* (${cycleStatus})` },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*My Review* · ${myReview ? 'Submitted' : 'Pending'}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Submit self reflection', emoji: true },
          action_id: 'self_reflection',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Feedback*' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Request peer feedback', emoji: true },
          action_id: 'request_peer_feedback',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Give upward feedback', emoji: true },
          action_id: 'upward_feedback',
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*History* · View past reviews' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View past reviews', emoji: true },
          action_id: 'view_history',
        },
      ],
    },
  ];

  // Manager section
  if (isManager && cycle) {
    const reports = await getDirectReports(employee.id);
    const cycleReviews = await getReviewsByCycle(cycle.id);
    const reportReviews = reports.map((r) => ({
      report: r,
      review: cycleReviews.find((rev) => rev.employee_id === r.id),
    }));

    blocks.push(
      { type: 'divider' },
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Manager Dashboard', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: reportReviews
            .map(
              (rr) =>
                `• *${rr.report.name}* – ${rr.review ? 'Review complete' : 'Review pending'}`
            )
            .join('\n') || 'No direct reports.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Write review', emoji: true },
            action_id: 'manager_write_review',
          },
        ],
      }
    );
  }

  await client.views.publish({
    user_id: slackUserId,
    view: {
      type: 'home',
      blocks,
    },
  });
}
