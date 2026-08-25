import { Router } from 'express';
import { computeReminderRecipients, reminderMessage, sendReminders, type ReminderType } from '../../services/reminders';
import { logAudit } from '../../db/audit';
import type { AuthedRequest } from '../../web/authMiddleware';

const router = Router();
const VALID_TYPES: ReminderType[] = [
  'self_reflection_missing',
  'peer_request_pending',
  'peer_feedback_incomplete',
  'upward_feedback_missing',
  'manager_review_missing',
  'manager_review_returned',
  'people_review_waiting',
  'primary_approval_waiting',
  'released_unacknowledged',
];

router.get('/cycles/:cycleId/reminders/:type/preview', async (req, res) => {
  const type = String(req.params.type) as ReminderType;
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ error: 'invalid reminder type' });
    return;
  }
  const recipients = await computeReminderRecipients(String(req.params.cycleId), type);
  res.json({
    message: reminderMessage(type),
    recipients: recipients.map((r) => ({ id: r.employee.id, name: r.employee.name, reason: r.reason })),
  });
});

/** Any People admin may send routine reminders. Reminders whose type would change cycle
 * policy do not exist in this router — those are cycle config changes gated separately. */
router.post('/cycles/:cycleId/reminders/:type/send', async (req: AuthedRequest, res) => {
  const type = String(req.params.type) as ReminderType;
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ error: 'invalid reminder type' });
    return;
  }
  const exclude = (req.body?.exclude_employee_ids as string[] | undefined) ?? [];
  const result = await sendReminders(String(req.params.cycleId), type, exclude);
  await logAudit({
    entity_type: 'reminder',
    entity_id: type,
    action: 'send',
    actor_id: req.actor!.employee.id,
    cycle_id: String(req.params.cycleId),
    details: result,
  });
  res.json(result);
});

export default router;
