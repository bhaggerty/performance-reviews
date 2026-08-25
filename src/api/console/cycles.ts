import { Router } from 'express';
import { z } from 'zod';
import { createCycle, getCycleById, listCycles, transitionCycle, updateCycleConfig } from '../../db/cycles';
import { listEmployees } from '../../db/employees';
import { requirePrimaryApprover } from '../../domain/authz';
import { logAudit } from '../../db/audit';
import type { AuthedRequest } from '../../web/authMiddleware';
import type { CycleStatus } from '../../types';

const router = Router();

const deadlinesSchema = z
  .object({
    cycle_start: z.string().optional(),
    self_reflection_due: z.string().optional(),
    peer_requests_due: z.string().optional(),
    peer_feedback_due: z.string().optional(),
    upward_feedback_due: z.string().optional(),
    manager_reviews_due: z.string().optional(),
    target_release_date: z.string().optional(),
    acknowledgement_due: z.string().optional(),
    cycle_close: z.string().optional(),
  })
  .partial();

const createSchema = z.object({
  name: z.string().min(1),
  timezone: z.string().optional(),
  deadlines: deadlinesSchema.optional(),
  max_peers: z.number().int().min(1).max(10).optional(),
  self_reflection_prompts: z.array(z.object({ key: z.string(), label: z.string(), required: z.boolean() })).optional(),
});

router.get('/cycles', async (_req, res) => {
  res.json({ cycles: await listCycles() });
});

router.get('/cycles/:id', async (req, res) => {
  const cycle = await getCycleById(String(req.params.id));
  if (!cycle) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ cycle });
});

router.get('/cycles/:id/eligible-population', async (req, res) => {
  const cycle = await getCycleById(String(req.params.id));
  if (!cycle) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const employees = (await listEmployees()).filter((e) => e.status === 'active');
  res.json({
    count: employees.length,
    employees: employees.map((e) => ({ id: e.id, name: e.name, department: e.department, manager_id: e.manager_id })),
  });
});

router.post('/cycles', async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const cycle = await createCycle(parsed.data, req.actor!.employee.id);
  await logAudit({
    entity_type: 'review_cycle',
    entity_id: cycle.id,
    action: 'create',
    actor_id: req.actor!.employee.id,
    cycle_id: cycle.id,
  });
  res.status(201).json({ cycle });
});

router.patch('/cycles/:id/config', async (req: AuthedRequest, res) => {
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const cycle = await updateCycleConfig(String(req.params.id), parsed.data);
  if (!cycle) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await logAudit({
    entity_type: 'review_cycle',
    entity_id: cycle.id,
    action: 'update_config',
    actor_id: req.actor!.employee.id,
    cycle_id: cycle.id,
    details: parsed.data,
  });
  res.json({ cycle });
});

const SENSITIVE_TRANSITIONS: CycleStatus[] = ['collecting_feedback', 'cancelled', 'closed'];

router.post('/cycles/:id/transition', async (req: AuthedRequest, res) => {
  const toStatus = req.body?.status as CycleStatus | undefined;
  if (!toStatus) {
    res.status(400).json({ error: 'status is required' });
    return;
  }
  if (SENSITIVE_TRANSITIONS.includes(toStatus)) {
    try {
      requirePrimaryApprover(req.actor ?? null);
    } catch {
      res.status(403).json({
        error: 'requires_primary_approver',
        message: 'Starting, cancelling, or closing a live cycle requires the Primary Approver.',
      });
      return;
    }
  }
  try {
    const cycle = await transitionCycle(String(req.params.id), toStatus, req.actor!.employee.id);
    await logAudit({
      entity_type: 'review_cycle',
      entity_id: cycle.id,
      action: `transition_${toStatus}`,
      actor_id: req.actor!.employee.id,
      cycle_id: cycle.id,
    });
    res.json({ cycle });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Transition failed.' });
  }
});

export default router;
