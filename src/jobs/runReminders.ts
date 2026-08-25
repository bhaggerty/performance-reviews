import { getActiveCycle } from '../db/cycles';
import { sendReminders, type ReminderType } from '../services/reminders';
import { logger } from '../logger';

const AUTOMATIC_TYPES: ReminderType[] = [
  'self_reflection_missing',
  'peer_request_pending',
  'peer_feedback_incomplete',
  'upward_feedback_missing',
  'manager_review_missing',
  'released_unacknowledged',
];

/**
 * Intended to run on a Union Station scheduled task (e.g. daily). Sends the "routine" reminder
 * types automatically for the active cycle; sensitive/policy-affecting reminders are sent only
 * from the web console by an authorized People admin (see docs/PRODUCT_WORKFLOWS.md).
 */
async function main(): Promise<void> {
  const cycle = await getActiveCycle();
  if (!cycle) {
    logger.info('No active cycle; nothing to remind.');
    return;
  }
  for (const type of AUTOMATIC_TYPES) {
    const result = await sendReminders(cycle.id, type, []);
    logger.info('Reminder batch complete', { cycleId: cycle.id, type, ...result });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Reminder run crashed', { error: error instanceof Error ? error.message : 'unknown' });
    process.exit(1);
  });
