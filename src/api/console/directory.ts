import { Router } from 'express';
import express from 'express';
import { listEmployees } from '../../db/employees';
import { listDirectoryImports } from '../../db/directoryImports';
import { CsvEmployeeDirectorySource } from '../../services/directoryImport/csvSource';
import { commitImport, planImport } from '../../services/directoryImport/importer';
import { logAudit } from '../../db/audit';
import { logger } from '../../logger';
import { slackApp } from '../../slack/app';
import type { AuthedRequest } from '../../web/authMiddleware';

const router = Router();
const csvSource = new CsvEmployeeDirectorySource();

router.get('/directory/employees', async (_req, res) => {
  const employees = await listEmployees();
  res.json({ employees });
});

router.get('/directory/imports', async (_req, res) => {
  res.json({ imports: await listDirectoryImports() });
});

/**
 * Resolves a Slack user ID by normalized email via `users.lookupByEmail` (requires the
 * `users:read.email` bot scope). Called once per row missing `slack_id` during import — this
 * is an admin/batch path, not a hot user-facing one, so sequential calls are acceptable.
 * A missing Slack account (`users_not_found`) is expected and not an error; any other failure
 * is logged and treated the same as "not resolved" so a single lookup issue never blocks import.
 */
async function resolveSlackIdByEmail(email: string): Promise<string | undefined> {
  try {
    const result = await slackApp.client.users.lookupByEmail({ email });
    return result.user?.id;
  } catch (error) {
    const code = (error as { data?: { error?: string } })?.data?.error;
    if (code !== 'users_not_found') {
      logger.warn('Slack users.lookupByEmail failed', { error: code ?? 'unknown' });
    }
    return undefined;
  }
}

router.post('/directory/import/dry-run', express.text({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const rows = csvSource.fetchRows(req.body);
    const authoritative = req.query.authoritative === 'true';
    const { plan } = await planImport(rows, { authoritativeSnapshot: authoritative, resolveSlackIdByEmail });
    res.json({ plan });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Import failed.' });
  }
});

router.post(
  '/directory/import/commit',
  express.text({ type: '*/*', limit: '2mb' }),
  async (req: AuthedRequest, res) => {
    const authoritative = req.query.authoritative === 'true';
    if (authoritative && req.query.confirm !== 'true') {
      res.status(400).json({ error: 'Authoritative full-snapshot imports require an explicit confirm=true.' });
      return;
    }
    try {
      const rows = csvSource.fetchRows(req.body);
      const summary = await commitImport(rows, {
        authoritativeSnapshot: authoritative,
        resolveSlackIdByEmail,
        actorId: req.actor!.employee.id,
        sourceName: 'csv-upload',
      });
      await logAudit({
        entity_type: 'directory_import',
        entity_id: summary.id,
        action: 'commit',
        actor_id: req.actor!.employee.id,
        details: {
          created: summary.created_count,
          updated: summary.updated_count,
          deactivated: summary.deactivated_count,
        },
      });
      res.json({ summary });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Import failed.' });
    }
  }
);

export default router;
