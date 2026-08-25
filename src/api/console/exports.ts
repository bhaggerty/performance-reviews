import { Router } from 'express';
import { listEmployees, getEmployeeById } from '../../db/employees';
import { getReviewsByCycle } from '../../db/reviews';
import { listDocumentsForEmployee } from '../../db/documents';
import { searchAudit, listAuditByActor } from '../../db/audit';
import { getUpwardFeedbackByManager, getLatestUpwardFeedbackRelease } from '../../db/upwardFeedback';
import { logAudit } from '../../db/audit';
import { presignDocumentUrl } from '../../services/documents';
import type { AuthedRequest } from '../../web/authMiddleware';

const router = Router();

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  // Row values are always primitives (string/number/boolean/undefined) by construction in this
  // file's export builders — never a plain object — so String() here is a safe stringify, not
  // an accidental "[object Object]".
  const escape = (v: unknown) => {
    const text = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n');
}

async function audited(
  req: AuthedRequest,
  exportType: string,
  cycleId: string | undefined,
  fn: () => Promise<Record<string, unknown>[]>
) {
  const rows = await fn();
  await logAudit({
    entity_type: 'export',
    entity_id: exportType,
    action: 'export',
    actor_id: req.actor!.employee.id,
    cycle_id: cycleId,
    details: { rowCount: rows.length },
  });
  return rows;
}

router.get('/cycles/:cycleId/exports/completion-report.csv', async (req: AuthedRequest, res) => {
  const employees = (await listEmployees()).filter((e) => e.status === 'active');
  const reviews = await getReviewsByCycle(String(req.params.cycleId));
  const rows = await audited(req, 'completion_report', String(req.params.cycleId), () =>
    Promise.resolve(
      employees.map((e) => {
        const review = reviews.find((r) => r.employee_id === e.id);
        return {
          employee_id: e.id,
          name: e.name,
          department: e.department,
          manager_id: e.manager_id ?? '',
          review_status: review?.people_state ?? 'not_submitted',
        };
      })
    )
  );
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows));
});

router.get('/exports/employee-directory.csv', async (req: AuthedRequest, res) => {
  const rows = await audited(req, 'employee_directory', undefined, async () =>
    (await listEmployees()).map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      department: e.department,
      manager_id: e.manager_id ?? '',
      status: e.status,
    }))
  );
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows));
});

router.get('/cycles/:cycleId/exports/review-status.csv', async (req: AuthedRequest, res) => {
  const rows = await audited(req, 'review_status', String(req.params.cycleId), async () =>
    (await getReviewsByCycle(String(req.params.cycleId))).map((r) => ({
      employee_id: r.employee_id,
      manager_id: r.manager_id,
      status: r.status,
      people_state: r.people_state,
      version: r.version,
      submitted_at: r.submitted_at,
    }))
  );
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows));
});

router.get('/cycles/:cycleId/exports/upward-feedback-admin.csv', async (req: AuthedRequest, res) => {
  const employees = await listEmployees();
  const managerIds = new Set(employees.map((e) => e.manager_id).filter(Boolean) as string[]);
  const rows = await audited(req, 'upward_feedback_admin', String(req.params.cycleId), async () => {
    const out: Record<string, unknown>[] = [];
    for (const managerId of managerIds) {
      const submissions = await getUpwardFeedbackByManager(String(req.params.cycleId), managerId);
      if (!submissions.length) continue;
      const release = await getLatestUpwardFeedbackRelease(String(req.params.cycleId), managerId);
      out.push({
        manager_id: managerId,
        respondent_count: submissions.length,
        below_threshold: submissions.length < 3,
        released: Boolean(release),
        release_mode: release?.mode ?? '',
      });
    }
    return out;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows));
});

router.get('/employees/:employeeId/final-packet', async (req: AuthedRequest, res) => {
  const employee = await getEmployeeById(String(req.params.employeeId));
  if (!employee) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const docs = (await listDocumentsForEmployee(String(req.params.employeeId))).filter((d) => d.visibility !== 'hr');
  await logAudit({
    entity_type: 'final_packet',
    entity_id: String(req.params.employeeId),
    action: 'export',
    actor_id: req.actor!.employee.id,
  });
  // S3-archived documents get a short-lived presigned link, issued only after the request
  // above has already been authorized and audited — never a permanent/public S3 URL. Webhook-
  // archived documents already carry their own externally-governed URL and are left as-is.
  const documentsWithLinks = await Promise.all(
    docs.map(async (doc) => {
      if (doc.archive_backend !== 's3') return doc;
      return { ...doc, archive_url: (await presignDocumentUrl(doc)) ?? doc.archive_url };
    })
  );
  res.json({ employee: { id: employee.id, name: employee.name }, documents: documentsWithLinks });
});

router.get('/exports/audit-report.csv', async (req: AuthedRequest, res) => {
  const actorId = req.query.actor_id as string | undefined;
  const rows = await audited(req, 'audit_report', undefined, async () => {
    const events = actorId ? await listAuditByActor(actorId) : await searchAudit({ actorId: req.actor!.employee.id });
    return events.map((e) => ({
      id: e.id,
      entity_type: e.entity_type,
      entity_id: e.entity_id,
      action: e.action,
      actor_id: e.actor_id,
      cycle_id: e.cycle_id ?? '',
      created_at: e.created_at,
    }));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.send(toCsv(rows));
});

export default router;
