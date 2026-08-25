import { listEmployees, getEmployeeById } from '../db/employees';
import { getCycleById } from '../db/cycles';
import { getSelfReflection } from '../db/selfReflections';
import { listPeerRequestsForCycle } from '../db/peerFeedback';
import { getUpwardFeedbackForEmployee } from '../db/upwardFeedback';
import { getManagerReview, getReviewsByCycle } from '../db/reviews';
import { getReviewRelease } from '../db/releases';
import { getAcknowledgement } from '../db/acknowledgements';
import { enqueueJob } from '../db/outbox';
import { hashKey } from '../db/idempotency';
import { isoNow, systemClock, type Clock } from '../domain/clock';
import type { Employee } from '../types';

export type ReminderType =
  | 'self_reflection_missing'
  | 'peer_request_pending'
  | 'peer_feedback_incomplete'
  | 'upward_feedback_missing'
  | 'manager_review_missing'
  | 'manager_review_returned'
  | 'people_review_waiting'
  | 'primary_approval_waiting'
  | 'released_unacknowledged';

export interface ReminderRecipient {
  employee: Employee;
  reason: string;
}

const REMINDER_MESSAGES: Record<ReminderType, string> = {
  self_reflection_missing: 'Reminder: your self-reflection for the current review cycle is not yet submitted.',
  peer_request_pending: 'Reminder: you have a pending peer feedback request awaiting your response.',
  peer_feedback_incomplete: 'Reminder: you accepted a peer feedback request that is not yet submitted.',
  upward_feedback_missing: 'Reminder: upward feedback for your manager is open and not yet submitted.',
  manager_review_missing: 'Reminder: you have a performance review to write that is not yet submitted.',
  manager_review_returned: 'A review you submitted was returned by People with notes — please revise and resubmit.',
  people_review_waiting: 'A submitted review is waiting on People review.',
  primary_approval_waiting: 'A review is waiting on Primary Approver action.',
  released_unacknowledged: 'Reminder: your released performance review is waiting for you to acknowledge it.',
};

/** Server-side eligibility check, driven by an injected clock so tests never depend on wall time. */
export async function computeReminderRecipients(
  cycleId: string,
  type: ReminderType,
  clock: Clock = systemClock
): Promise<ReminderRecipient[]> {
  const cycle = await getCycleById(cycleId);
  if (!cycle) return [];
  const employees = (await listEmployees()).filter((e) => e.status === 'active');
  const recipients: ReminderRecipient[] = [];

  switch (type) {
    case 'self_reflection_missing': {
      for (const emp of employees) {
        const reflection = await getSelfReflection(cycleId, emp.id);
        if (!reflection || reflection.state !== 'submitted')
          recipients.push({ employee: emp, reason: 'No submitted self-reflection.' });
      }
      break;
    }
    case 'peer_request_pending': {
      const requests = await listPeerRequestsForCycle(cycleId);
      for (const req of requests.filter((r) => r.status === 'pending')) {
        const emp = await getEmployeeById(req.peer_id);
        if (emp) recipients.push({ employee: emp, reason: 'Pending peer feedback request.' });
      }
      break;
    }
    case 'peer_feedback_incomplete': {
      const requests = await listPeerRequestsForCycle(cycleId);
      for (const req of requests.filter((r) => r.status === 'accepted')) {
        const emp = await getEmployeeById(req.peer_id);
        if (emp) recipients.push({ employee: emp, reason: 'Accepted peer feedback not yet submitted.' });
      }
      break;
    }
    case 'upward_feedback_missing': {
      for (const emp of employees) {
        if (!emp.manager_id) continue;
        const submitted = await getUpwardFeedbackForEmployee(cycleId, emp.id);
        if (!submitted) recipients.push({ employee: emp, reason: 'No upward feedback submitted.' });
      }
      break;
    }
    case 'manager_review_missing': {
      const managerIds = new Set(employees.map((e) => e.manager_id).filter(Boolean) as string[]);
      for (const managerId of managerIds) {
        const manager = await getEmployeeById(managerId);
        if (!manager) continue;
        const reports = employees.filter((e) => e.manager_id === managerId);
        const missing = [];
        for (const report of reports) {
          const review = await getManagerReview(cycleId, report.id);
          if (!review || review.people_state === 'not_submitted' || review.people_state === 'manager_draft')
            missing.push(report.name);
        }
        if (missing.length)
          recipients.push({ employee: manager, reason: `Missing reviews for: ${missing.join(', ')}` });
      }
      break;
    }
    case 'manager_review_returned': {
      const reviews = await getReviewsByCycle(cycleId);
      for (const review of reviews.filter((r) => r.people_state === 'returned_to_manager')) {
        const manager = await getEmployeeById(review.manager_id);
        if (manager)
          recipients.push({ employee: manager, reason: `Review for employee ${review.employee_id} was returned.` });
      }
      break;
    }
    case 'people_review_waiting': {
      const reviews = await getReviewsByCycle(cycleId);
      const waiting = reviews.filter((r) => ['submitted', 'people_reviewing'].includes(r.people_state));
      if (waiting.length)
        recipients.push({
          employee: { id: 'people_admins' } as Employee,
          reason: `${waiting.length} review(s) waiting on People review.`,
        });
      break;
    }
    case 'primary_approval_waiting': {
      const reviews = await getReviewsByCycle(cycleId);
      const waiting = reviews.filter((r) =>
        ['people_review_complete', 'awaiting_primary_approval'].includes(r.people_state)
      );
      if (waiting.length)
        recipients.push({
          employee: { id: 'primary_approver' } as Employee,
          reason: `${waiting.length} review(s) waiting on Primary Approver action.`,
        });
      break;
    }
    case 'released_unacknowledged': {
      const reviews = await getReviewsByCycle(cycleId);
      for (const review of reviews.filter((r) => r.people_state === 'released')) {
        const release = await getReviewRelease(cycleId, review.employee_id);
        if (!release) continue;
        const ack = await getAcknowledgement(cycleId, review.employee_id);
        if (!ack) {
          const emp = await getEmployeeById(review.employee_id);
          if (emp) recipients.push({ employee: emp, reason: 'Released review not yet acknowledged.' });
        }
      }
      break;
    }
  }
  void clock;
  return recipients;
}

export function reminderMessage(type: ReminderType): string {
  return REMINDER_MESSAGES[type];
}

/**
 * Enqueues Slack DM jobs for every eligible, non-excluded recipient. Idempotency + cooldown:
 * the dedupe key is scoped to (cycle, type, calendar day), so re-running "send" for the same
 * type on the same day is a no-op for anyone already notified that day.
 */
export async function sendReminders(
  cycleId: string,
  type: ReminderType,
  excludeEmployeeIds: string[],
  clock: Clock = systemClock
): Promise<{ enqueued: number; skipped: number }> {
  const recipients = await computeReminderRecipients(cycleId, type, clock);
  const excluded = new Set(excludeEmployeeIds);
  const dayBucket = isoNow(clock).slice(0, 10);
  let enqueued = 0;
  let skipped = 0;
  for (const { employee } of recipients) {
    if (excluded.has(employee.id) || !employee.slack_id) {
      skipped += 1;
      continue;
    }
    const idempotencyKey = hashKey('reminder', cycleId, type, dayBucket, employee.id);
    await enqueueJob(
      'notify_slack_dm',
      {
        slackUserId: employee.slack_id,
        employeeId: employee.id,
        text: reminderMessage(type),
        dedupeType: `reminder:${type}`,
        dedupeKey: dayBucket,
      },
      idempotencyKey,
      {},
      clock
    );
    enqueued += 1;
  }
  return { enqueued, skipped };
}
