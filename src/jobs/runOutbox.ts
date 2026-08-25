import { listDueJobs, markJobProcessing, markJobSucceeded, markJobFailed } from '../db/outbox';
import { processJob } from './processors';
import { logger } from '../logger';

/**
 * Runs one pass over due outbox jobs. Intended to be invoked by Union Station's scheduled-job
 * mechanism (e.g. an ECS scheduled task running `npm run jobs:run` every minute) — not an
 * in-process cron, which would be unsafe with multiple ECS tasks running concurrently.
 */
export async function runOutboxOnce(
  ctx: Parameters<typeof processJob>[1]
): Promise<{ processed: number; failed: number }> {
  const due = await listDueJobs();
  let processed = 0;
  let failed = 0;
  for (const job of due) {
    const processing = await markJobProcessing(job);
    try {
      await processJob(processing, ctx);
      await markJobSucceeded(processing);
      processed += 1;
    } catch (error) {
      await markJobFailed(processing, error instanceof Error ? error.message : 'unknown error');
      failed += 1;
      logger.error('Outbox job failed', { jobId: job.id, jobType: job.type, attempts: processing.attempts });
    }
  }
  return { processed, failed };
}

async function main(): Promise<void> {
  const { slackApp } = await import('../slack/app');
  const result = await runOutboxOnce({ slackClient: slackApp.client });
  logger.info('Outbox run complete', result);
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Outbox run crashed', { error: error instanceof Error ? error.message : 'unknown' });
    process.exit(1);
  });
}
