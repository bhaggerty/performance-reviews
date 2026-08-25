import { Router } from 'express';
import { listEmployees, getEmployeeById } from '../../db/employees';
import { getCycleById } from '../../db/cycles';
import {
  getUpwardFeedbackByManager,
  getLatestUpwardFeedbackRelease,
  recordUpwardFeedbackRelease,
} from '../../db/upwardFeedback';
import { reviewCoach } from '../../services/reviewCoach';
import { logAudit } from '../../db/audit';
import { enqueueJob } from '../../db/outbox';
import { hashKey } from '../../db/idempotency';
import { requirePrimaryApproverMiddleware } from '../../web/authMiddleware';
import type { AuthedRequest } from '../../web/authMiddleware';
import type { UpwardReleaseMode } from '../../types';

const router = Router();
const RESPONDENT_THRESHOLD = 3;

router.get('/cycles/:cycleId/upward-feedback', async (req, res) => {
  const employees = await listEmployees();
  const managerIds = new Set(employees.map((e) => e.manager_id).filter(Boolean) as string[]);
  const rows = [];
  for (const managerId of managerIds) {
    const manager = await getEmployeeById(managerId);
    if (!manager) continue;
    const submissions = await getUpwardFeedbackByManager(String(req.params.cycleId), managerId);
    if (submissions.length === 0) continue;
    const release = await getLatestUpwardFeedbackRelease(String(req.params.cycleId), managerId);
    rows.push({
      manager: { id: manager.id, name: manager.name },
      respondentCount: submissions.length,
      belowThreshold: submissions.length < RESPONDENT_THRESHOLD,
      released: Boolean(release),
      release,
    });
  }
  res.json({ managers: rows });
});

/**
 * Stable anonymousId assignment (index order from the same underlying query) — safe because
 * upward-feedback submission is only possible during the cycle's collecting_feedback phase,
 * which has already ended by the time People review/release this cycle's feedback, so the
 * submission set behind these indices cannot change between preview and release.
 */
function toAnonymousSubmissions(submissions: Awaited<ReturnType<typeof getUpwardFeedbackByManager>>) {
  return submissions.map((s, i) => ({
    anonymousId: `respondent-${i + 1}`,
    strengths: s.strengths,
    improvements: s.improvements,
    hr_notes: s.hr_notes,
    allow_hr_followup: s.allow_hr_followup,
  }));
}

router.get('/cycles/:cycleId/upward-feedback/:managerId/raw', async (req, res) => {
  const submissions = await getUpwardFeedbackByManager(String(req.params.cycleId), String(req.params.managerId));
  // People-only: raw content, no author identity beyond what this authorized endpoint returns
  // to an already-authenticated People admin (enforced by the router-level middleware).
  res.json({ submissions: toAnonymousSubmissions(submissions) });
});

router.post('/cycles/:cycleId/upward-feedback/:managerId/draft-summary', async (req, res) => {
  const submissions = await getUpwardFeedbackByManager(String(req.params.cycleId), String(req.params.managerId));
  const manager = await getEmployeeById(String(req.params.managerId));
  const anonymized = submissions.map((s) => [s.strengths, s.improvements].filter(Boolean).join(' | ')).filter(Boolean);
  const result = await reviewCoach.draftUpwardSummary({
    managerName: manager?.name ?? 'Manager',
    cycleName: String(req.params.cycleId),
    anonymizedComments: anonymized,
  });
  // Always returned as an editable draft — never released automatically.
  res.json({ draftSummary: result.summary });
});

/** Renders exactly the content approved for release — no author identity, ever. */
function buildManagerFacingMessage(
  cycleName: string,
  mode: UpwardReleaseMode,
  summaryText: string | undefined,
  selectedCommentIds: string[],
  anonymized: ReturnType<typeof toAnonymousSubmissions>
): string {
  const lines = [`Upward feedback summary for the ${cycleName} cycle:`];
  if ((mode === 'summary_only' || mode === 'summary_and_comments') && summaryText?.trim()) {
    lines.push('', summaryText.trim());
  }
  if (mode === 'comments_only' || mode === 'summary_and_comments') {
    const selected = anonymized.filter((s) => selectedCommentIds.includes(s.anonymousId));
    if (selected.length) {
      lines.push('', 'Selected anonymous comments:');
      for (const s of selected) {
        if (s.strengths) lines.push(`• ${s.strengths}`);
        if (s.improvements) lines.push(`• ${s.improvements}`);
      }
    }
  }
  return lines.join('\n');
}

router.post(
  '/cycles/:cycleId/upward-feedback/:managerId/release',
  requirePrimaryApproverMiddleware,
  async (req: AuthedRequest, res) => {
    const managerId = String(req.params.managerId);
    const cycleId = String(req.params.cycleId);
    const mode = req.body?.mode as UpwardReleaseMode | undefined;
    const summaryText = req.body?.summary_text as string | undefined;
    const selectedCommentIds = (req.body?.selected_comment_ids as string[] | undefined) ?? [];
    const overrideReason = req.body?.threshold_override_reason as string | undefined;

    if (!mode || !['none', 'summary_only', 'comments_only', 'summary_and_comments'].includes(mode)) {
      res.status(400).json({ error: 'mode is required' });
      return;
    }

    const submissions = await getUpwardFeedbackByManager(cycleId, managerId);
    const belowThreshold = submissions.length < RESPONDENT_THRESHOLD;
    if (belowThreshold && mode !== 'none' && !overrideReason?.trim()) {
      res.status(400).json({
        error: 'below_threshold_confirmation_required',
        message: 'Fewer than 3 respondents — an explicit override reason is required to release anything.',
      });
      return;
    }

    const release = await recordUpwardFeedbackRelease({
      cycle_id: cycleId,
      manager_id: managerId,
      mode,
      summary_text: mode === 'summary_only' || mode === 'summary_and_comments' ? summaryText : undefined,
      selected_comment_ids: mode === 'comments_only' || mode === 'summary_and_comments' ? selectedCommentIds : [],
      respondent_count: submissions.length,
      below_threshold: belowThreshold,
      threshold_override_reason: belowThreshold ? overrideReason : undefined,
      prepared_by: req.actor!.employee.id,
      released_by: req.actor!.employee.id,
    });

    await logAudit({
      entity_type: 'upward_feedback_release',
      entity_id: managerId,
      action: 'release',
      actor_id: req.actor!.employee.id,
      cycle_id: cycleId,
      manager_id: managerId,
      details: { mode, version: release.version, belowThreshold },
    });

    // Deliver the exact released content privately to the manager — never the raw submissions,
    // never author identity, and never anything beyond what was just approved for release.
    if (mode !== 'none') {
      const manager = await getEmployeeById(managerId);
      if (manager?.slack_id) {
        const cycle = await getCycleById(cycleId);
        const message = buildManagerFacingMessage(
          cycle?.name ?? cycleId,
          mode,
          release.summary_text,
          release.selected_comment_ids,
          toAnonymousSubmissions(submissions)
        );
        await enqueueJob(
          'notify_slack_dm',
          {
            slackUserId: manager.slack_id,
            employeeId: manager.id,
            text: message,
            dedupeType: 'upward_feedback_release',
            dedupeKey: `${cycleId}:${release.version}`,
          },
          hashKey('upward_release_notify', cycleId, managerId, String(release.version))
        );
      }
    }

    res.status(201).json({ release });
  }
);

export default router;
