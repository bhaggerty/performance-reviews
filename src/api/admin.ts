import { Router } from 'express';
import { createCycle, updateCycleStatus, listCycles } from '../db/cycles';
import { listEmployees, upsertEmployee, getEmployeeBySlackId, updateEmployee } from '../db/employees';
import { parse } from 'csv-parse/sync';

const router = Router();

// Simple API key or internal-only (no auth for Phase 1 - secure via ECS/ALB and network)
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function checkAdmin(req: { headers: { authorization?: string }; query: { secret?: string } }): boolean {
  if (!ADMIN_SECRET) return true;
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.secret;
  return auth === ADMIN_SECRET;
}

// GET /admin/cycles - list cycles
router.get('/cycles', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  listCycles()
    .then((cycles) => res.json(cycles))
    .catch((err) => res.status(500).json({ error: String(err) }));
});

// POST /admin/cycles - create cycle
router.post('/cycles', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { name, start_date, end_date, status } = req.body || {};
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date, end_date required' });
  }
  createCycle(name, start_date, end_date, status || 'draft')
    .then((cycle) => res.status(201).json(cycle))
    .catch((err) => res.status(500).json({ error: String(err) }));
});

// PATCH /admin/cycles/:id/status - open/close cycle
router.patch('/cycles/:id/status', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { status } = req.body || {};
  if (!status || !['draft', 'open', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'status must be draft|open|closed' });
  }
  updateCycleStatus(id, status)
    .then((cycle) => (cycle ? res.json(cycle) : res.status(404).json({ error: 'Not found' })))
    .catch((err) => res.status(500).json({ error: String(err) }));
});

// GET /admin/employees - list employees
router.get('/employees', (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  listEmployees()
    .then((employees) => res.json(employees))
    .catch((err) => res.status(500).json({ error: String(err) }));
});

// POST /admin/employees/upload-csv - upload CSV to populate directory
// CSV: name, email, slack_id, manager_email, department
router.post('/employees/upload-csv', async (req, res) => {
  if (!checkAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const raw = req.body;
  let csvText: string;
  if (typeof raw === 'string') csvText = raw;
  else if (Buffer.isBuffer(raw)) csvText = raw.toString('utf-8');
  else if (raw?.data) csvText = typeof raw.data === 'string' ? raw.data : Buffer.from(raw.data).toString('utf-8');
  else return res.status(400).json({ error: 'Send CSV as body (text) or { data: "csv string" }' });

  try {
    const rows = parse(csvText, { columns: true, skip_empty_lines: true });
    const byEmail = new Map<string, string>(); // email -> employee id
    const created: string[] = [];
    const updated: string[] = [];

    // First pass: create or find all employees (manager_id set when manager already in map)
    for (const row of rows) {
      const name = (row.name ?? row.Name ?? '').trim();
      const email = (row.email ?? row.Email ?? '').trim().toLowerCase();
      const slack_id = (row.slack_id ?? row.Slack_ID ?? '').trim();
      const manager_email = (row.manager_email ?? row.manager_email ?? '').trim().toLowerCase();
      const department = (row.department ?? row.Department ?? '').trim();
      if (!email) continue;

      let manager_id: string | null = null;
      if (manager_email && byEmail.has(manager_email)) manager_id = byEmail.get(manager_email)!;

      const existing = slack_id ? await getEmployeeBySlackId(slack_id) : null;
      if (existing) {
        byEmail.set(email, existing.id);
        updated.push(email);
        continue;
      }
      const emp = await upsertEmployee({
        slack_id: slack_id || `pending-${email}`,
        name: name || email,
        email,
        manager_id,
        department,
        status: 'active',
      });
      byEmail.set(email, emp.id);
      created.push(email);
    }

    // Second pass: set manager_id for anyone whose manager was created in this CSV
    for (const row of rows) {
      const email = (row.email ?? row.Email ?? '').trim().toLowerCase();
      const manager_email = (row.manager_email ?? row.manager_email ?? '').trim().toLowerCase();
      if (!email || !manager_email || !byEmail.has(manager_email)) continue;
      const empId = byEmail.get(email);
      const managerId = byEmail.get(manager_email);
      if (empId && managerId) await updateEmployee(empId, { manager_id: managerId });
    }

    res.json({ created: created.length, updated: updated.length, total: rows.length });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

export default router;
