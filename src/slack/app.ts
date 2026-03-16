import express from 'express';
import { App, ExpressReceiver } from '@slack/bolt';
import { config } from '../config';

const receiverApp = express();

receiverApp.use('/slack/events', (req, _res, next) => {
  console.log(`[slack] ${req.method} ${req.originalUrl}`);
  next();
});

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  endpoints: '/slack/events',
  processBeforeResponse: true,
  app: receiverApp,
  dispatchErrorHandler: async ({ error, logger, response }) => {
    logger.error(error);
    console.error('[slack] dispatch error', error);
    if (!response.headersSent) {
      response.writeHead(500);
      response.end('Slack dispatch error');
    }
  },
  processEventErrorHandler: async ({ error, logger }) => {
    logger.error(error);
    console.error('[slack] process event error', error);
    return true;
  },
  unhandledRequestHandler: ({ logger, response }) => {
    logger.error('Unhandled Slack request');
    console.error('[slack] unhandled request');
    if (!response.headersSent) {
      response.writeHead(404);
      response.end('Unhandled Slack request');
    }
  },
});

export const slackApp = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  receiver,
});

export const expressApp = receiver.app;
