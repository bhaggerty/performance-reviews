import { Router } from 'express';
import { searchAudit } from '../../db/audit';
import { logAudit } from '../../db/audit';
import type { AuthedRequest } from '../../web/authMiddleware';

const router = Router();

router.get('/audit', async (req: AuthedRequest, res) => {
  const {
    actor_id: actorId,
    entity_type: entityType,
    entity_id: entityId,
    cycle_id: cycleId,
    action,
    from,
    to,
  } = req.query as Record<string, string | undefined>;
  if (!actorId && !(entityType && entityId)) {
    res.status(400).json({ error: 'Provide actor_id, or both entity_type and entity_id.' });
    return;
  }
  const events = await searchAudit({ actorId, entityType, entityId, cycleId, action, from, to });
  await logAudit({
    entity_type: 'audit_log',
    entity_id: 'search',
    action: 'view',
    actor_id: req.actor!.employee.id,
    details: { actorId, entityType, entityId, cycleId },
  });
  res.json({ events });
});

export default router;
