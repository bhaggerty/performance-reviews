import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { logger } from '../logger';

/**
 * Reliable DM helper: opens (or reuses) the IM conversation for a Slack user ID before
 * posting, rather than assuming a user ID can be used directly as a channel ID. Swallows
 * "user not found"/"deactivated account" errors so a missing/removed Slack user never
 * crashes a caller — those are logged and treated as a soft failure.
 */
export async function sendDirectMessage(
  client: WebClient,
  slackUserId: string,
  text: string,
  blocks?: KnownBlock[]
): Promise<boolean> {
  try {
    const opened = await client.conversations.open({ users: slackUserId });
    const channelId = opened.channel?.id;
    if (!channelId) return false;
    await client.chat.postMessage({ channel: channelId, text, blocks });
    return true;
  } catch (error) {
    const code = (error as { data?: { error?: string } })?.data?.error;
    if (code === 'user_not_found' || code === 'users_not_found' || code === 'account_inactive') {
      logger.warn('Slack DM skipped: user not found or deactivated', { slackUserId: '[redacted]', code });
      return false;
    }
    logger.error('Slack DM failed', { error: code ?? (error instanceof Error ? error.message : 'unknown') });
    return false;
  }
}
