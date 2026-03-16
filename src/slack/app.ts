import { App, ExpressReceiver } from '@slack/bolt';
import { config } from '../config';

const receiver = new ExpressReceiver({
  signingSecret: config.slack.signingSecret,
  endpoints: '/slack/events',
  processBeforeResponse: true,
});

export const slackApp = new App({
  token: config.slack.botToken,
  signingSecret: config.slack.signingSecret,
  receiver,
});

export const expressApp = receiver.router;
