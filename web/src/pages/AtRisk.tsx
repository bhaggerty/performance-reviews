import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { ReviewDetail as ReviewDetailType, ReviewQueueRow } from '../types';
import { DataView } from '../components/DataState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../AuthContext';

export function AtRisk() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const [rows, setRows] = useState<ReviewQueueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () => {
    if (!cycleId) return;
    setLoading(true);
    api
      .listReviews(cycleId, true)
      .then((r) => setRows(r.reviews))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  };

  useEffect(load, [cycleId]);

  if (!cycleId) return null;

  return (
    <div>
      <p>
        <Link to={`/cycles/${cycleId}`}>&larr; Cycle</Link>
      </p>
      <h1>At Risk Queue</h1>
      <p className="text-muted">
        Reviews flagged "at risk" require additional documentation and Primary Approver sign-off
        before release.
      </p>

      <DataView
        loading={loading}
        error={error}
        data={rows}
        isEmpty={(d) => d.length === 0}
        emptyLabel="No at-risk reviews in this cycle."
      >
        {(list) => (
          <>
            {list.map((r) => (
              <AtRiskRow
                key={r.employee.id}
                cycleId={cycleId}
                row={r}
                expanded={expanded === r.employee.id}
                onToggle={() => setExpanded((e) => (e === r.employee.id ? null : r.employee.id))}
                onChanged={load}
              />
            ))}
          </>
        )}
      </DataView>
    </div>
  );
}

function AtRiskRow({
  cycleId,
  row,
  expanded,
  onToggle,
  onChanged,
}: {
  cycleId: string;
  row: ReviewQueueRow;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { me } = useAuth();
  const [detail, setDetail] = useState<ReviewDetailType | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [showApprove, setShowApprove] = useState(false);

  useEffect(() => {
    if (!expanded || detail) return;
    setDetailLoading(true);
    api
      .getReview(cycleId, row.employee.id)
      .then(setDetail)
      .catch(setDetailError)
      .finally(() => setDetailLoading(false));
  }, [expanded]);

  const atRisk = row.review.at_risk;

  return (
    <div className="card">
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <div>
          <strong>{row.employee.name}</strong>{' '}
          <span className="text-muted">— manager: {row.manager?.name ?? '—'}</span>
        </div>
        <div>
          <span className="badge">{row.review.people_state.replace(/_/g, ' ')}</span>{' '}
          <Link
            className="btn btn-sm"
            to={`/cycles/${cycleId}/reviews/${row.employee.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            Full review
          </Link>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 14 }}>
          {detailLoading && <div className="state-block">Loading details…</div>}
          {detailError !== null && (
            <div className="state-block error">{String((detailError as Error)?.message ?? detailError)}</div>
          )}

          <div className="section-title">At-risk documentation</div>
          <div className="two-col">
            <Field label="Concrete examples" value={atRisk?.concrete_examples} />
            <Field label="Prior communication" value={atRisk?.prior_communication} />
            <Field label="Support provided" value={atRisk?.support_provided} />
            <Field label="Expected improvement" value={atRisk?.expected_improvement} />
            <Field label="Timeline" value={atRisk?.timeline} />
            <Field label="People involvement" value={atRisk?.people_involvement} />
          </div>

          {detail && (
            <>
              <div className="section-title" style={{ marginTop: 14 }}>
                Approval history
              </div>
              {detail.approvals.length === 0 ? (
                <p className="text-muted">No approvals recorded yet.</p>
              ) : (
                <ul>
                  {detail.approvals.map((a) => (
                    <li key={a.id}>
                      {a.action} by {a.actor_id} (v{a.review_version}) —{' '}
                      {new Date(a.created_at).toLocaleString()}
                      {a.notes && ` — ${a.notes}`}
                    </li>
                  ))}
                </ul>
              )}

              <div className="section-title">Internal People Ops notes</div>
              {detail.notes.length === 0 ? (
                <p className="text-muted">No internal notes yet.</p>
              ) : (
                <ul>
                  {detail.notes.map((n) => (
                    <li key={n.id}>
                      {n.note} — <span className="text-muted">{new Date(n.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="toolbar" style={{ marginTop: 12 }}>
                <button
                  className="btn btn-primary"
                  title={!me?.roles.isPrimaryApprover ? 'Requires Primary Approver' : undefined}
                  onClick={() => setShowApprove(true)}
                >
                  Approve at-risk review
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {showApprove && (
        <ConfirmDialog
          title="Approve at-risk review"
          impact={
            <p>
              You are approving an <strong>at-risk</strong> review for{' '}
              <strong>{row.employee.name}</strong>. This confirms the documentation above is
              complete and accurate, and moves the review toward release.
            </p>
          }
          confirmLabel="Approve"
          onConfirm={async () => {
            await api.approveReview(cycleId, row.employee.id);
            onChanged();
          }}
          onClose={() => setShowApprove(false)}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="help-text">{label}</div>
      <div>{value || '—'}</div>
    </div>
  );
}
