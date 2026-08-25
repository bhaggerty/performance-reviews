import type { WebClient } from '@slack/web-api';
import { sendDirectMessage } from '../slack/dm';
import { claimNotification } from '../db/notifications';
import type { OutboxJob } from '../types';
import { logger } from '../logger';

export interface JobContext {
  slackClient: WebClient;
}

async function processNotifySlackDm(job: OutboxJob, ctx: JobContext): Promise<void> {
  const payload = job.payload as {
    slackUserId: string;
    employeeId: string;
    text: string;
    dedupeType: string;
    dedupeKey: string;
  };
  const shouldSend = await claimNotification(payload.employeeId, payload.dedupeType, payload.dedupeKey);
  if (!shouldSend) return; // already delivered — duplicate job run is a no-op
  const ok = await sendDirectMessage(ctx.slackClient, payload.slackUserId, payload.text);
  if (!ok) throw new Error('Slack DM delivery failed');
}

export type JobProcessor = (job: OutboxJob, ctx: JobContext) => Promise<void>;

export const PROCESSORS: Record<string, JobProcessor> = {
  notify_slack_dm: processNotifySlackDm,
};

export async function processJob(job: OutboxJob, ctx: JobContext): Promise<void> {
  const processor = PROCESSORS[job.type];
  if (!processor) {
    logger.error('No processor registered for job type', { jobId: job.id, jobType: job.type });
    throw new Error(`No processor for job type "${job.type}"`);
  }
  await processor(job, ctx);
}
