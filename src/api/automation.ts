import { Router } from 'express';
import express from 'express';
import { timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { logger } from '../logger';
import { logAudit } from '../db/audit';
import { getActiveCycle } from '../db/cycles';
import { sendReminders, type ReminderType } from '../services/reminders';
import { listJobsByStatus, retryDeadLetterJob } from '../db/outbox';

/**
 * Disabled by default (AUTOMATION_API_ENABLED). Intended only for a private, non-browser
 * automation caller (e.g. a scheduled job runner) that cannot use the console's session/OIDC
 * flow. Deliberately does NOT expose approval, release, or upward-feedback-release endpoints —
 * those exist only in src/api/console and require requirePrimaryApprover through a browser
 * session. See docs/SECURITY.md.
 */
export function buildAutomationRouter(): Router {
  const router = Router();
  if (!config.automationApi.enabled) {
    router.use((_req, res) => res.status(404).json({ error: 'not_found' }));
    return router;
  }

  router.use(rateLimit({ windowMs: 60_000, limit: 30 }));
  router.use(express.json({ limit: '64kb' }));

  router.use((req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.replace(/^Bearer\s+/i, '');
    const expected = Buffer.from(config.automationApi.token);
    const provided = Buffer.from(token);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      logger.warn('Automation API auth failed');
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  router.post('/reminders/:type/send', async (req, res) => {
    const cycle = await getActiveCycle();
    if (!cycle) {
      res.status(409).json({ error: 'no_active_cycle' });
      return;
    }
    const result = await sendReminders(cycle.id, req.params.type as ReminderType, []);
    await logAudit({
      entity_type: 'reminder',
      entity_id: req.params.type,
      action: 'send_automation',
      actor_id: 'automation',
      cycle_id: cycle.id,
      details: result,
    });
    res.json(result);
  });

  router.post('/jobs/run', async (_req, res) => {
    const { runOutboxOnce } = await import('../jobs/runOutbox');
    const { slackApp } = await import('../slack/app');
    const result = await runOutboxOnce({ slackClient: slackApp.client });
    res.json(result);
  });

  router.get('/jobs/dead-letter', async (_req, res) => {
    res.json({ jobs: await listJobsByStatus('dead_letter') });
  });

  router.post('/jobs/:id/retry', async (req, res) => {
    const job = await retryDeadLetterJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await logAudit({
      entity_type: 'outbox_job',
      entity_id: job.id,
      action: 'retry_automation',
      actor_id: 'automation',
    });
    res.json({ job });
  });

  return router;
}
