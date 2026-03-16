import express from 'express';
import { slackApp, expressApp } from './slack/app';
import adminRoutes from './api/admin';
import { renderHomeTab } from './slack/home';
import {
  openWriteReviewModal,
  handleReviewStatusChoice,
  handleManagerReviewSubmit,
} from './slack/managerReview';
import {
  openRequestPeerFeedbackModal,
  handlePeerFeedbackRequestSubmit,
  handlePeerAccept,
  handlePeerDecline,
  handlePeerFeedbackSubmit,
} from './slack/peerFeedback';
import {
  openUpwardFeedbackModal,
  handleUpwardFeedbackSubmit,
} from './slack/upwardFeedback';
import { handleAcknowledgeReview, handleViewMyReview } from './slack/acknowledge';

const adminApp = express.Router();
adminApp.use(express.json());
adminApp.use(express.text({ type: 'text/csv', limit: '1mb' }));
adminApp.use(express.urlencoded({ extended: true }));
adminApp.use(adminRoutes);

expressApp.get('/health', (_req: unknown, res: { json: (o: object) => void }) => {
  res.json({ ok: true });
});
expressApp.use('/admin', adminApp);

// --- Slack App Home Tab
slackApp.event('app_home_opened', renderHomeTab);

// --- Manager review (decision tree)
slackApp.action('manager_write_review', openWriteReviewModal);
slackApp.action('status_on_track', handleReviewStatusChoice);
slackApp.action('status_needs_focus', handleReviewStatusChoice);
slackApp.action('status_at_risk', handleReviewStatusChoice);
slackApp.view({ callback_id: 'manager_review_submit' }, handleManagerReviewSubmit);

// --- Peer feedback
slackApp.action('request_peer_feedback', openRequestPeerFeedbackModal);
slackApp.view('peer_feedback_request_submit', handlePeerFeedbackRequestSubmit);
slackApp.action('peer_accept', handlePeerAccept);
slackApp.action('peer_decline', handlePeerDecline);
slackApp.view('peer_feedback_submit', handlePeerFeedbackSubmit);

// --- Upward feedback
slackApp.action('upward_feedback', openUpwardFeedbackModal);
slackApp.view('upward_feedback_submit', handleUpwardFeedbackSubmit);

// --- Review acknowledgment & view
slackApp.action('acknowledge_review', handleAcknowledgeReview);
slackApp.action('view_my_review', handleViewMyReview);

// Placeholders (no-op or simple message)
slackApp.action('self_reflection', async ({ ack, body, client }) => {
  await ack?.();
  const triggerId = 'trigger_id' in body ? body.trigger_id : undefined;
  if (!triggerId) return;
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Self reflection' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Self-reflection can be added here (optional for Phase 1).',
          },
        },
      ],
    },
  });
});
slackApp.action('view_history', async ({ ack, body, client }) => {
  await ack?.();
  const triggerId = 'trigger_id' in body ? body.trigger_id : undefined;
  if (!triggerId) return;
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      title: { type: 'plain_text', text: 'Past reviews' },
      close: { type: 'plain_text', text: 'Close' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Past reviews list can be wired to DB here.',
          },
        },
      ],
    },
  });
});

const PORT = process.env.PORT ?? 3000;
slackApp.start(PORT).then(() => {
  console.log(`Performance Reviews app running on port ${PORT}`);
});
