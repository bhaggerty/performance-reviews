import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { PeopleState, ReviewQueueRow } from '../types';
import { DataView } from '../components/DataState';

const PEOPLE_STATE_LABEL: Record<PeopleState, string> = {
  not_submitted: 'Not submitted',
  manager_draft: 'Manager draft',
  submitted: 'Submitted',
  people_reviewing: 'People reviewing',
  returned_to_manager: 'Returned to manager',
  people_review_complete: 'People review complete',
  awaiting_primary_approval: 'Awaiting primary approval',
  approved: 'Approved',
  released: 'Released',
  acknowledged: 'Acknowledged',
};

export function ReviewQueue() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ReviewQueueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [atRiskOnly, setAtRiskOnly] = useState(false);

  useEffect(() => {
    if (!cycleId) return;
    setLoading(true);
    api
      .listReviews(cycleId)
      .then((r) => setRows(r.reviews))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  }, [cycleId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (atRiskOnly && r.review.status !== 'at_risk') return false;
      if (stateFilter !== 'all' && r.review.people_state !== stateFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !r.employee.name.toLowerCase().includes(q) &&
          !(r.manager?.name ?? '').toLowerCase().includes(q) &&
          !(r.employee.department ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rows, search, stateFilter, atRiskOnly]);

  if (!cycleId) return null;

  return (
    <div>
      <p>
        <Link to={`/cycles/${cycleId}`}>&larr; Cycle</Link>
      </p>
      <h1>Review Queue</h1>

      <div className="card">
        <div className="toolbar">
          <input
            type="text"
            placeholder="Search employee, manager, department"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 280 }}
            aria-label="Search reviews"
          />
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} aria-label="Filter by people state">
            <option value="all">All states</option>
            {Object.entries(PEOPLE_STATE_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
            <input type="checkbox" checked={atRiskOnly} onChange={(e) => setAtRiskOnly(e.target.checked)} />
            At risk only
          </label>
        </div>

        <DataView
          loading={loading}
          error={error}
          data={rows}
          isEmpty={(d) => d.length === 0}
          emptyLabel="No reviews for this cycle yet."
        >
          {() => (
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Manager</th>
                  <th>Department</th>
                  <th>Status</th>
                  <th>People state</th>
                  <th>At risk</th>
                  <th>Released</th>
                  <th>Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.employee.id}
                    className="clickable"
                    onClick={() => navigate(`/cycles/${cycleId}/reviews/${r.employee.id}`)}
                  >
                    <td>{r.employee.name}</td>
                    <td>{r.manager?.name ?? '—'}</td>
                    <td>{r.employee.department ?? '—'}</td>
                    <td>{r.review.status.replace(/_/g, ' ')}</td>
                    <td>{PEOPLE_STATE_LABEL[r.review.people_state]}</td>
                    <td>
                      {r.review.status === 'at_risk' && <span className="badge danger">at risk</span>}
                    </td>
                    <td>{r.release ? new Date(r.release.released_at).toLocaleDateString() : '—'}</td>
                    <td>
                      {r.acknowledgement
                        ? new Date(r.acknowledgement.acknowledged_at).toLocaleDateString()
                        : '—'}
                    </td>
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
