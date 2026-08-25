import { useEffect, useMemo, useState } from 'react';
import { api, ApiRequestError } from '../api';
import type { DirectoryImportSummary, Employee, ImportPlan } from '../types';
import { DataView } from '../components/DataState';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function Directory() {
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [imports, setImports] = useState<DirectoryImportSummary[] | null>(null);
  const [importsError, setImportsError] = useState<unknown>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [managerFilter, setManagerFilter] = useState('all');

  const loadEmployees = () => {
    setLoading(true);
    api
      .listEmployees()
      .then((r) => setEmployees(r.employees))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  };

  const loadImports = () => {
    api
      .listImports()
      .then((r) => setImports(r.imports))
      .catch((e) => setImportsError(e));
  };

  useEffect(() => {
    loadEmployees();
    loadImports();
  }, []);

  const managerById = useMemo(() => {
    const map = new Map<string, Employee>();
    (employees ?? []).forEach((e) => map.set(e.id, e));
    return map;
  }, [employees]);

  const filtered = useMemo(() => {
    if (!employees) return [];
    return employees.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      if (managerFilter !== 'all' && e.manager_id !== managerFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !e.name.toLowerCase().includes(q) &&
          !e.email.toLowerCase().includes(q) &&
          !(e.department ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [employees, search, statusFilter, managerFilter]);

  return (
    <div>
      <h1>Employee Directory</h1>

      <div className="card">
        <div className="toolbar">
          <input
            type="text"
            placeholder="Search name, email, department"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 260 }}
            aria-label="Search employees"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
            aria-label="Filter by status"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <select
            value={managerFilter}
            onChange={(e) => setManagerFilter(e.target.value)}
            aria-label="Filter by manager"
          >
            <option value="all">All managers</option>
            {(employees ?? [])
              .filter((e) => (employees ?? []).some((x) => x.manager_id === e.id))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
          <a className="btn btn-sm" href="/api/console/exports/employee-directory.csv">
            Export CSV
          </a>
        </div>

        <DataView
          loading={loading}
          error={error}
          data={employees}
          isEmpty={(d) => d.length === 0}
          emptyLabel="No employees found."
        >
          {() => (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Department</th>
                  <th>Manager</th>
                  <th>Status</th>
                  <th>Slack</th>
                  <th>People admin</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => (
                  <tr key={e.id}>
                    <td>{e.name}</td>
                    <td>{e.email}</td>
                    <td>{e.department ?? '—'}</td>
                    <td>{e.manager_id ? managerById.get(e.manager_id)?.name ?? e.manager_id : '—'}</td>
                    <td>
                      <span className={`badge ${e.status === 'active' ? 'success' : ''}`}>
                        {e.status}
                      </span>
                    </td>
                    <td>
                      {e.slack_id ? (
                        <span className="badge success">resolved</span>
                      ) : (
                        <span className="badge warning">unresolved</span>
                      )}
                    </td>
                    <td>{e.is_people_admin ? 'Yes' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DataView>
      </div>

      <ImportPanel onCommitted={() => { loadEmployees(); loadImports(); }} />

      <div className="card">
        <div className="section-title">Import history</div>
        <DataView
          loading={imports === null && !importsError}
          error={importsError}
          data={imports}
          isEmpty={(d) => d.length === 0}
          emptyLabel="No imports yet."
        >
          {(rows) => (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Authoritative</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th>Unchanged</th>
                  <th>Deactivated</th>
                  <th>Unresolved</th>
                  <th>Warnings</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.created_at).toLocaleString()}</td>
                    <td>{r.source}</td>
                    <td>{r.authoritative_snapshot ? 'Yes' : 'No'}</td>
                    <td>{r.status}</td>
                    <td>{r.created_count}</td>
                    <td>{r.updated_count}</td>
                    <td>{r.unchanged_count}</td>
                    <td>{r.deactivated_count}</td>
                    <td>{r.unresolved_count}</td>
                    <td>{r.warning_count}</td>
                    <td>{r.error_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DataView>
      </div>
    </div>
  );
}

function ImportPanel({ onCommitted }: { onCommitted: () => void }) {
  const [csvText, setCsvText] = useState('');
  const [fileName, setFileName] = useState('');
  const [authoritative, setAuthoritative] = useState(false);
  const [confirmAuthoritative, setConfirmAuthoritative] = useState(false);

  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRunError, setDryRunError] = useState<unknown>(null);

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<unknown>(null);
  const [commitResult, setCommitResult] = useState<DirectoryImportSummary | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
    setFileName(file.name);
    setPlan(null);
    setCommitResult(null);
  };

  const runDryRun = async () => {
    setDryRunning(true);
    setDryRunError(null);
    setCommitResult(null);
    try {
      const result = await api.importDryRun(csvText, authoritative);
      setPlan(result.plan);
    } catch (e) {
      setDryRunError(e);
      setPlan(null);
    } finally {
      setDryRunning(false);
    }
  };

  const doCommit = async () => {
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await api.importCommit(csvText, authoritative, authoritative ? true : false);
      setCommitResult(result.summary);
      setPlan(null);
      onCommitted();
    } catch (e) {
      setCommitError(e);
      throw e;
    } finally {
      setCommitting(false);
    }
  };

  const hasErrors = (plan?.errors.length ?? 0) > 0;
  const canCommit = !!plan && !hasErrors && (!authoritative || confirmAuthoritative);

  return (
    <div className="card">
      <div className="section-title">Import employee directory (CSV)</div>
      <p className="help-text">
        Columns: name, email, manager_email, department, status (optional slack_id).
      </p>
      <div className="field">
        <label htmlFor="csv-file">CSV file</label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        {fileName && <div className="help-text">Loaded: {fileName}</div>}
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={authoritative}
            onChange={(e) => {
              setAuthoritative(e.target.checked);
              setConfirmAuthoritative(false);
              setPlan(null);
            }}
          />
          This file is the complete, authoritative employee directory (missing employees will be
          deactivated)
        </label>
      </div>

      <button className="btn" onClick={runDryRun} disabled={!csvText || dryRunning}>
        {dryRunning ? 'Running dry run…' : 'Run dry run'}
      </button>

      {dryRunError !== null && (
        <div className="state-block error">{String((dryRunError as Error)?.message ?? dryRunError)}</div>
      )}

      {plan && (
        <div style={{ marginTop: 16 }}>
          <div className="grid grid-cols-4">
            <div className="stat-tile">
              <div className="stat-value">{plan.createdCount}</div>
              <div className="stat-label">Create</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value">{plan.updatedCount}</div>
              <div className="stat-label">Update</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value">{plan.unchangedCount}</div>
              <div className="stat-label">Unchanged</div>
            </div>
            <div className="stat-tile">
              <div className="stat-value">{plan.deactivatedCount}</div>
              <div className="stat-label">Deactivate</div>
            </div>
          </div>

          {plan.unresolvedCount > 0 && (
            <p className="help-text">{plan.unresolvedCount} row(s) could not be resolved to a Slack account.</p>
          )}

          {plan.warnings.length > 0 && (
            <div className="card">
              <strong>Warnings ({plan.warnings.length})</strong>
              <ul>
                {plan.warnings.map((w, i) => (
                  <li key={i}>
                    {w.row ? `Row ${w.row}: ` : ''}
                    {w.email ? `${w.email} — ` : ''}
                    {w.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.errors.length > 0 && (
            <div className="card">
              <strong style={{ color: 'var(--color-danger)' }}>Errors ({plan.errors.length})</strong>
              <ul>
                {plan.errors.map((w, i) => (
                  <li key={i}>
                    {w.row ? `Row ${w.row}: ` : ''}
                    {w.email ? `${w.email} — ` : ''}
                    {w.message}
                  </li>
                ))}
              </ul>
              <p className="help-text">Fix the source file and re-run the dry run before committing.</p>
            </div>
          )}

          <div className="card" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Email</th>
                  <th>Action</th>
                  <th>Changes</th>
                  <th>Slack</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>{r.email}</td>
                    <td>
                      <span
                        className={`badge ${
                          r.action === 'error'
                            ? 'danger'
                            : r.action === 'unresolved'
                              ? 'warning'
                              : r.action === 'deactivate'
                                ? 'warning'
                                : r.action === 'create' || r.action === 'update'
                                  ? 'success'
                                  : ''
                        }`}
                      >
                        {r.action}
                      </span>
                    </td>
                    <td className="mono">
                      {r.changes
                        ? Object.entries(r.changes)
                            .map(([field, ch]) => `${field}: ${String(ch.from)} → ${String(ch.to)}`)
                            .join('; ')
                        : '—'}
                    </td>
                    <td>{r.slack_resolved === undefined ? '—' : r.slack_resolved ? 'resolved' : 'unresolved'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {authoritative && (
            <div className="field" style={{ marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={confirmAuthoritative}
                  onChange={(e) => setConfirmAuthoritative(e.target.checked)}
                />
                I confirm this is the full, authoritative employee directory. Any active
                employees not present in this file will be deactivated.
              </label>
            </div>
          )}

          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            disabled={!canCommit || committing}
            onClick={() => setShowConfirmDialog(true)}
          >
            Commit import
          </button>

          {commitError !== null && (
            <div className="state-block error">
              {String((commitError as ApiRequestError)?.message ?? commitError)}
            </div>
          )}
        </div>
      )}

      {commitResult && (
        <div className="card" style={{ marginTop: 12 }}>
          <strong>Import committed.</strong> Created {commitResult.created_count}, updated{' '}
          {commitResult.updated_count}, deactivated {commitResult.deactivated_count}, unchanged{' '}
          {commitResult.unchanged_count}.
        </div>
      )}

      {showConfirmDialog && plan && (
        <ConfirmDialog
          title="Commit directory import"
          impact={
            <p>
              This will create <strong>{plan.createdCount}</strong>, update{' '}
              <strong>{plan.updatedCount}</strong>
              {authoritative && (
                <>
                  , and deactivate <strong>{plan.deactivatedCount}</strong>
                </>
              )}{' '}
              employee record(s). This action cannot be undone automatically.
            </p>
          }
          confirmLabel="Commit import"
          onConfirm={doCommit}
          onClose={() => setShowConfirmDialog(false)}
        />
      )}
    </div>
  );
}
