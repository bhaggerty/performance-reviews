import { Router } from 'express';
import { getActiveCycle } from '../../db/cycles';
import { getReviewsByCycle } from '../../db/reviews';
import { listEmployees } from '../../db/employees';
import { getSelfReflection } from '../../db/selfReflections';
import { listPeerRequestsForCycle } from '../../db/peerFeedback';
import { getUpwardFeedbackForEmployee } from '../../db/upwardFeedback';
import { listJobsByStatus } from '../../db/outbox';
import { getReviewRelease } from '../../db/releases';
import { getAcknowledgement } from '../../db/acknowledgements';

const router = Router();

router.get('/dashboard', async (_req, res) => {
  const cycle = await getActiveCycle();
  if (!cycle) {
    res.json({ cycle: null });
    return;
  }

  const employees = (await listEmployees()).filter((e) => e.status === 'active');
  const reviews = await getReviewsByCycle(cycle.id);
  const peerRequests = await listPeerRequestsForCycle(cycle.id);

  let selfReflectionDone = 0;
  let upwardDone = 0;
  for (const emp of employees) {
    const reflection = await getSelfReflection(cycle.id, emp.id);
    if (reflection?.state === 'submitted') selfReflectionDone += 1;
    if (emp.manager_id) {
      const upward = await getUpwardFeedbackForEmployee(cycle.id, emp.id);
      if (upward) upwardDone += 1;
    }
  }

  const peerAccepted = peerRequests.filter((r) => r.status === 'accepted').length;
  const peerSubmitted = peerRequests.filter((r) => r.status === 'submitted').length;
  const peopleWaiting = reviews.filter((r) => ['submitted', 'people_reviewing'].includes(r.people_state)).length;
  const primaryWaiting = reviews.filter((r) =>
    ['people_review_complete', 'awaiting_primary_approval'].includes(r.people_state)
  ).length;
  const atRiskWaiting = reviews.filter(
    (r) => r.status === 'at_risk' && !['approved', 'released', 'acknowledged'].includes(r.people_state)
  ).length;
  const readyForRelease = reviews.filter((r) => r.people_state === 'approved').length;

  let releasedUnacknowledged = 0;
  for (const review of reviews.filter((r) => r.people_state === 'released')) {
    const release = await getReviewRelease(cycle.id, review.employee_id);
    if (release && !(await getAcknowledgement(cycle.id, review.employee_id))) releasedUnacknowledged += 1;
  }

  const failedJobs = await listJobsByStatus('dead_letter');

  res.json({
    cycle,
    completion: {
      total_employees: employees.length,
      self_reflection_submitted: selfReflectionDone,
      peer_requests_total: peerRequests.length,
      peer_feedback_accepted: peerAccepted,
      peer_feedback_submitted: peerSubmitted,
      upward_feedback_submitted: upwardDone,
      manager_reviews_submitted: reviews.filter(
        (r) => r.people_state !== 'not_submitted' && r.people_state !== 'manager_draft'
      ).length,
    },
    queues: {
      people_review_waiting: peopleWaiting,
      primary_approval_waiting: primaryWaiting,
      at_risk_waiting: atRiskWaiting,
      ready_for_release: readyForRelease,
      released_unacknowledged: releasedUnacknowledged,
    },
    operations: { failed_jobs: failedJobs.length },
  });
});

export default router;
