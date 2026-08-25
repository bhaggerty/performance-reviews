import { Router } from 'express';
import { getCycleById } from '../../db/cycles';
import {
  addPeopleNote,
  beginPeopleReview,
  getManagerReview,
  getReviewHistory,
  getReviewsByCycle,
  listApprovals,
  listPeopleNotes,
  markApproved,
  markAwaitingPrimaryApproval,
  markPeopleReviewComplete,
  markReleased,
  recordApproval,
  returnToManager,
} from '../../db/reviews';
import { getEmployeeById } from '../../db/employees';
import { getPeerFeedbackForEmployee } from '../../db/peerFeedback';
import { getSelfReflection } from '../../db/selfReflections';
import { createReviewRelease, getReviewRelease } from '../../db/releases';
import { getAcknowledgement } from '../../db/acknowledgements';
import { listAuditByEntity } from '../../db/audit';
import { logAudit } from '../../db/audit';
import { generateAndStoreManagerReview } from '../../services/documents';
import { enqueueJob } from '../../db/outbox';
import { hashKey } from '../../db/idempotency';
import { requirePrimaryApproverMiddleware } from '../../web/authMiddleware';
import type { AuthedRequest } from '../../web/authMiddleware';

const router = Router();

router.get('/cycles/:cycleId/reviews', async (req, res) => {
  const reviews = await getReviewsByCycle(String(req.params.cycleId));
  const atRiskOnly = req.query.at_risk === 'true';
  const filtered = atRiskOnly ? reviews.filter((r) => r.status === 'at_risk') : reviews;
  const withEmployees = await Promise.all(
    filtered.map(async (review) => ({
      review,
      employee: await getEmployeeById(review.employee_id),
      manager: await getEmployeeById(review.manager_id),
      release: await getReviewRelease(String(req.params.cycleId), review.employee_id),
      acknowledgement: await getAcknowledgement(String(req.params.cycleId), review.employee_id),
    }))
  );
  res.json({ reviews: withEmployees });
});

router.get('/cycles/:cycleId/reviews/:employeeId', async (req, res) => {
  const cycleId = String(req.params.cycleId);
  const employeeId = String(req.params.employeeId);
  const [review, employee, selfReflection, peerFeedback, history, notes, approvals, release, acknowledgement] =
    await Promise.all([
      getManagerReview(cycleId, employeeId),
      getEmployeeById(employeeId),
      getSelfReflection(cycleId, employeeId),
      getPeerFeedbackForEmployee(cycleId, employeeId),
      getReviewHistory(cycleId, employeeId),
      listPeopleNotes(cycleId, employeeId),
      listApprovals(cycleId, employeeId),
      getReviewRelease(cycleId, employeeId),
      getAcknowledgement(cycleId, employeeId),
    ]);
  if (!review) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const manager = await getEmployeeById(review.manager_id);
  const auditEvents = await listAuditByEntity('manager_review', employeeId);
  res.json({
    review,
    employee,
    manager,
    selfReflection,
    peerFeedback,
    history,
    notes,
    approvals,
    release,
    acknowledgement,
    auditEvents,
  });
});

router.post('/cycles/:cycleId/reviews/:employeeId/notes', async (req: AuthedRequest, res) => {
  const note = req.body?.note as string | undefined;
  if (!note?.trim()) {
    res.status(400).json({ error: 'note is required' });
    return;
  }
  const record = await addPeopleNote(
    String(req.params.cycleId),
    String(req.params.employeeId),
    req.actor!.employee.id,
    note.trim()
  );
  res.status(201).json({ note: record });
});

router.post('/cycles/:cycleId/reviews/:employeeId/begin-review', async (req: AuthedRequest, res) => {
  try {
    const review = await beginPeopleReview(String(req.params.cycleId), String(req.params.employeeId));
    res.json({ review });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'failed' });
  }
});

router.post('/cycles/:cycleId/reviews/:employeeId/return', async (req: AuthedRequest, res) => {
  const reason = req.body?.reason as string | undefined;
  if (!reason?.trim()) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }
  try {
    const review = await returnToManager(String(req.params.cycleId), String(req.params.employeeId), reason.trim());
    await logAudit({
      entity_type: 'manager_review',
      entity_id: String(req.params.employeeId),
      action: 'return_to_manager',
      actor_id: req.actor!.employee.id,
      cycle_id: String(req.params.cycleId),
      manager_id: review.manager_id,
      details: { reason: reason.trim() },
    });
    res.json({ review });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'failed' });
  }
});

router.post('/cycles/:cycleId/reviews/:employeeId/complete', async (req: AuthedRequest, res) => {
  try {
    const review = await markPeopleReviewComplete(String(req.params.cycleId), String(req.params.employeeId));
    await logAudit({
      entity_type: 'manager_review',
      entity_id: String(req.params.employeeId),
      action: 'people_review_complete',
      actor_id: req.actor!.employee.id,
      cycle_id: String(req.params.cycleId),
    });
    res.json({ review });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'failed' });
  }
});

/** Any People admin may recommend approval — this does NOT release or approve anything. */
router.post('/cycles/:cycleId/reviews/:employeeId/recommend', async (req: AuthedRequest, res) => {
  const review = await getManagerReview(String(req.params.cycleId), String(req.params.employeeId));
  if (!review) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const approval = await recordApproval(
    String(req.params.cycleId),
    String(req.params.employeeId),
    'recommend',
    req.actor!.employee.id,
    review.version,
    req.body?.notes
  );
  await markAwaitingPrimaryApproval(String(req.params.cycleId), String(req.params.employeeId)).catch(() => undefined);
  res.status(201).json({ approval });
});

/** Primary-Approver-only: the actual approval decision. At Risk reviews use the same action
 * but are recorded distinctly (at_risk_primary_approve) for audit clarity. */
router.post(
  '/cycles/:cycleId/reviews/:employeeId/approve',
  requirePrimaryApproverMiddleware,
  async (req: AuthedRequest, res) => {
    const review = await getManagerReview(String(req.params.cycleId), String(req.params.employeeId));
    if (!review) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Idempotent: a retried approval request for an already-approved-or-later review returns
    // the current state rather than erroring on the conditional write.
    if (['approved', 'released', 'acknowledged'].includes(review.people_state)) {
      res.json({ review });
      return;
    }
    try {
      const updated = await markApproved(String(req.params.cycleId), String(req.params.employeeId));
      const approval = await recordApproval(
        String(req.params.cycleId),
        String(req.params.employeeId),
        review.status === 'at_risk' ? 'at_risk_primary_approve' : 'primary_approve',
        req.actor!.employee.id,
        review.version,
        req.body?.notes
      );
      await logAudit({
        entity_type: 'manager_review',
        entity_id: String(req.params.employeeId),
        action: 'primary_approve',
        actor_id: req.actor!.employee.id,
        cycle_id: String(req.params.cycleId),
        manager_id: review.manager_id,
      });
      res.json({ review: updated, approval });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'failed' });
    }
  }
);

async function releaseOne(
  cycleId: string,
  employeeId: string,
  actorId: string
): Promise<{ ok: boolean; error?: string }> {
  const review = await getManagerReview(cycleId, employeeId);
  if (!review) return { ok: false, error: 'Review not found.' };
  // Idempotent: a retried release request for an already-released review succeeds silently
  // instead of erroring, so a duplicate web request never surfaces a false failure.
  if (review.people_state === 'released' || review.people_state === 'acknowledged') {
    return { ok: true };
  }
  if (review.people_state !== 'approved') return { ok: false, error: 'Review is not in an approved state.' };
  const cycle = await getCycleById(cycleId);
  const document = await generateAndStoreManagerReview(review, cycle?.name ?? cycleId);
  try {
    await createReviewRelease({
      cycle_id: cycleId,
      employee_id: employeeId,
      review_version: review.version,
      document_id: document.id,
      released_by: actorId,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Already released.' };
  }
  await markReleased(cycleId, employeeId);
  await logAudit({
    entity_type: 'manager_review',
    entity_id: employeeId,
    action: 'release',
    actor_id: actorId,
    cycle_id: cycleId,
    manager_id: review.manager_id,
    details: { review_version: review.version, document_id: document.id },
  });

  const employee = await getEmployeeById(employeeId);
  if (employee?.slack_id) {
    await enqueueJob(
      'notify_slack_dm',
      {
        slackUserId: employee.slack_id,
        employeeId,
        text: 'Your performance review has been released. Open Slack to view and acknowledge it.',
        dedupeType: 'review_released',
        dedupeKey: `${cycleId}:${review.version}`,
      },
      hashKey('release_notify', cycleId, employeeId, String(review.version))
    );
  }
  return { ok: true };
}

router.post(
  '/cycles/:cycleId/reviews/:employeeId/release',
  requirePrimaryApproverMiddleware,
  async (req: AuthedRequest, res) => {
    const result = await releaseOne(String(req.params.cycleId), String(req.params.employeeId), req.actor!.employee.id);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  }
);

/** Bulk release: the caller must pass the exact employee IDs it previewed (no server-side
 * "release everyone ready" shortcut) and At Risk reviews are excluded even if included. */
router.post(
  '/cycles/:cycleId/reviews/bulk-release',
  requirePrimaryApproverMiddleware,
  async (req: AuthedRequest, res) => {
    const employeeIds = (req.body?.employee_ids as string[] | undefined) ?? [];
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      res.status(400).json({ error: 'employee_ids is required' });
      return;
    }
    const results: Array<{ employeeId: string; ok: boolean; error?: string }> = [];
    for (const employeeId of employeeIds) {
      const review = await getManagerReview(String(req.params.cycleId), employeeId);
      if (review?.status === 'at_risk') {
        results.push({ employeeId, ok: false, error: 'At Risk reviews must be released individually.' });
        continue;
      }
      const result = await releaseOne(String(req.params.cycleId), employeeId, req.actor!.employee.id);
      results.push({ employeeId, ...result });
    }
    res.json({ results });
  }
);

export default router;
