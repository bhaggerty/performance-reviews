import { config } from './config';
import { logger } from './logger';
import { slackApp, getSlackExpressApp } from './slack/app';
import { mountWebApp } from './web/buildWebApp';
import { markShuttingDown } from './web/health';
import { renderHomeTab } from './slack/home';
import {
  openWriteReviewModal,
  handleReviewStatusChoice,
  handleManagerReviewSubmit,
  handleAiCoachRequest,
} from './slack/managerReview';
import { openSelfReflectionModal, handleSelfReflectionSubmit } from './slack/selfReflection';
import {
  openRequestPeerFeedbackModal,
  handlePeerFeedbackRequestSubmit,
  handlePeerAccept,
  handlePeerDecline,
  handlePeerFeedbackSubmit,
  handleResumePeerRequest,
  viewMyPeerRequests,
  loadPeerOptions,
} from './slack/peerFeedback';
import { openUpwardFeedbackModal, handleUpwardFeedbackSubmit } from './slack/upwardFeedback';
import {
  handleAcknowledgeReview,
  handleAcknowledgeSubmit,
  handleViewHistory,
  handleViewMyReview,
  handleViewWrittenReviews,
} from './slack/acknowledge';
import express from 'express';

// --- Slack App Home
slackApp.event('app_home_opened', renderHomeTab);

// --- Self reflection
slackApp.action('self_reflection', openSelfReflectionModal);
slackApp.view('self_reflection_submit', handleSelfReflectionSubmit);

// --- Manager review (decision tree)
slackApp.action('manager_write_review', openWriteReviewModal);
slackApp.action('status_on_track', handleReviewStatusChoice);
slackApp.action('status_needs_focus', handleReviewStatusChoice);
slackApp.action('status_at_risk', handleReviewStatusChoice);
slackApp.action('review_ai_coach', handleAiCoachRequest);
slackApp.view({ callback_id: 'manager_review_submit' }, handleManagerReviewSubmit);

// --- Peer feedback
slackApp.action('request_peer_feedback', openRequestPeerFeedbackModal);
slackApp.options('peers', loadPeerOptions);
slackApp.view('peer_feedback_request_submit', handlePeerFeedbackRequestSubmit);
slackApp.action('peer_accept', handlePeerAccept);
slackApp.action('peer_decline', handlePeerDecline);
slackApp.action('peer_resume', handleResumePeerRequest);
slackApp.action('view_peer_requests', viewMyPeerRequests);
slackApp.view('peer_feedback_submit', handlePeerFeedbackSubmit);

// --- Upward feedback
slackApp.action('upward_feedback', openUpwardFeedbackModal);
slackApp.view('upward_feedback_submit', handleUpwardFeedbackSubmit);

// --- Review acknowledgment & view
slackApp.action('acknowledge_review', handleAcknowledgeReview);
slackApp.view('ack_submit', handleAcknowledgeSubmit);
slackApp.action('view_my_review', handleViewMyReview);
slackApp.action('view_history', handleViewHistory);
slackApp.action('view_written_reviews', handleViewWrittenReviews);

// Link-only button; Slack still sends a block_actions payload that must be acknowledged.
slackApp.action('open_admin_console', async ({ ack }) => {
  await ack();
});

// --- Web console + health + (disabled-by-default) automation API.
// In HTTP Slack mode, mount on the SAME Express app the Slack receiver already listens on so
// there is only one deployable/one port. In Socket Mode there is no such app, so we own our own.
const existingSlackExpressApp = getSlackExpressApp();
let webServer: ReturnType<typeof express> | undefined;
if (existingSlackExpressApp) {
  mountWebApp(existingSlackExpressApp);
} else {
  webServer = express();
  mountWebApp(webServer);
}

let standaloneHttpServer: import('http').Server | undefined;

async function main(): Promise<void> {
  if (config.slack.useSocketMode) {
    await slackApp.start();
    if (webServer) {
      standaloneHttpServer = webServer.listen(config.port, () =>
        logger.info('Web console listening', { port: config.port })
      );
    }
  } else {
    await slackApp.start(config.port);
  }
  logger.info('Performance Reviews app started', {
    port: config.port,
    socketMode: config.slack.useSocketMode,
    env: config.env,
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Received shutdown signal; draining', { signal });
  // Readiness immediately starts reporting "shutting down" so the load balancer / ECS stops
  // routing new traffic here while in-flight work finishes.
  markShuttingDown();

  const forceExit = setTimeout(() => {
    logger.warn('Graceful shutdown timed out; forcing exit');
    process.exit(0);
  }, 8000);
  forceExit.unref();

  try {
    // Stops accepting new Slack events/interactions and closes the HTTP/Socket-Mode receiver
    // (in HTTP mode this also closes the underlying Express HTTP server Bolt owns).
    await slackApp.stop();
  } catch (error) {
    logger.error('Error stopping Slack app', { error: error instanceof Error ? error.message : 'unknown' });
  }

  if (standaloneHttpServer) {
    await new Promise<void>((resolve) => {
      standaloneHttpServer!.close(() => resolve());
    });
  }

  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  logger.error('Fatal startup error', { error: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
});
