import express, { type Application } from 'express';
import { App, ExpressReceiver } from '@slack/bolt';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Socket Mode and HTTP (Events API) are both fully supported. Production defaults to Socket
 * Mode unless USE_SOCKET_MODE=false is explicitly set (no public inbound Slack endpoint is
 * then required — see docs/UNION_STATION_DEPLOYMENT.md). Mode-specific config is validated in
 * src/config.ts at startup, so by the time this module runs the required tokens are present.
 */

let expressApp: Application | undefined;

export const slackApp = config.slack.useSocketMode
  ? new App({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      socketMode: true,
    })
  : (() => {
      const receiverApp = express();
      receiverApp.use('/slack/events', (req, _res, next) => {
        logger.debug('Slack HTTP event received', { method: req.method, path: req.originalUrl });
        next();
      });

      const receiver = new ExpressReceiver({
        signingSecret: config.slack.signingSecret,
        endpoints: '/slack/events',
        processBeforeResponse: true,
        app: receiverApp,
        dispatchErrorHandler: ({ error, logger: boltLogger, response }) => {
          boltLogger.error(error);
          logger.error('Slack dispatch error', { error: error instanceof Error ? error.message : 'unknown' });
          if (!response.headersSent) {
            response.writeHead(500);
            response.end('Slack dispatch error');
          }
          return Promise.resolve();
        },
        processEventErrorHandler: ({ error, logger: boltLogger }) => {
          boltLogger.error(error);
          logger.error('Slack process event error', { error: error instanceof Error ? error.message : 'unknown' });
          return Promise.resolve(true);
        },
        unhandledRequestHandler: ({ logger: boltLogger, response }) => {
          boltLogger.error('Unhandled Slack request');
          if (!response.headersSent) {
            response.writeHead(404);
            response.end('Unhandled Slack request');
          }
        },
      });

      expressApp = receiver.app;
      return new App({ token: config.slack.botToken, signingSecret: config.slack.signingSecret, receiver });
    })();

/** Only defined in HTTP mode — the underlying Express app the ExpressReceiver is built on.
 * In Socket Mode there is no inbound Slack HTTP surface; the console/health app is mounted
 * on its own standalone Express server instead (see src/index.ts). */
export function getSlackExpressApp(): Application | undefined {
  return expressApp;
}
