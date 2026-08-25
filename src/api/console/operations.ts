import { Router } from 'express';
import { listJobsByStatus, retryDeadLetterJob } from '../../db/outbox';
import { logAudit } from '../../db/audit';
import type { AuthedRequest } from '../../web/authMiddleware';

const router = Router();

router.get('/operations/jobs', async (_req, res) => {
  const [pending, processing, failed, deadLetter] = await Promise.all([
    listJobsByStatus('pending'),
    listJobsByStatus('processing'),
    listJobsByStatus('failed'),
    listJobsByStatus('dead_letter'),
  ]);
  res.json({ pending, processing, failed, deadLetter });
});

router.post('/operations/jobs/:id/retry', async (req: AuthedRequest, res) => {
  const job = await retryDeadLetterJob(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'not_found_or_not_dead_letter' });
    return;
  }
  await logAudit({
    entity_type: 'outbox_job',
    entity_id: job.id,
    action: 'retry',
    actor_id: req.actor!.employee.id,
    details: { jobType: job.type },
  });
  res.json({ job });
});

export default router;
