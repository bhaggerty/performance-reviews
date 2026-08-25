import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { ReviewDetail as ReviewDetailType } from '../types';
import { DataView } from '../components/DataState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../AuthContext';

type DialogKind = 'return' | 'complete' | 'recommend' | 'approve' | 'release' | null;

export function ReviewDetail() {
  const { cycleId, employeeId } = useParams<{ cycleId: string; employeeId: string }>();
  const { me } = useAuth();
  const [detail, setDetail] = useState<ReviewDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [noteText, setNoteText] = useState('');
  const [noteSubmitting, setNoteSubmitting] = useState(false);
  const [noteError, setNoteError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const load = () => {
    if (!cycleId || !employeeId) return;
    setLoading(true);
    api
      .getReview(cycleId, employeeId)
      .then(setDetail)
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, [cycleId, employeeId]);

  if (!cycleId || !employeeId) return null;

  const submitNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setNoteSubmitting(true);
    setNoteError(null);
    try {
      await api.addNote(cycleId, employeeId, noteText.trim());
      setNoteText('');
      load();
    } catch (err) {
      setNoteError(err);
    } finally {
      setNoteSubmitting(false);
    }
  };

  return (
    <div>
      <p>
        <Link to={`/cycles/${cycleId}/reviews`}>&larr; Review queue</Link>
      </p>

      <DataView loading={loading} error={error} data={detail}>
        {(d) => (
          <>
            <h1>
              {d.employee.name}{' '}
              <span className="badge">{d.review.people_state.replace(/_/g, ' ')}</span>{' '}
              {d.review.status === 'at_risk' && <span className="badge danger">at risk</span>}
            </h1>
            <p className="text-muted">
              Manager: {d.manager?.name ?? '—'} · Department: {d.employee.department ?? '—'} ·
              Version {d.review.version}
            </p>

            {d.review.return_reason && (
              <div className="card">
                <strong>Return reason:</strong> {d.review.return_reason}
              </div>
            )}

            <div className="two-col" style={{ marginTop: 16 }}>
              <div className="card">
                <div className="section-title">Self-reflection</div>
                {d.selfReflection ? (
                  <>
                    {Object.entries(d.selfReflection.responses || {}).map(([k, v]) => (
                      <div key={k} style={{ marginBottom: 10 }}>
                        <div className="help-text">{k.replace(/_/g, ' ')}</div>
                        <div>{v}</div>
                      </div>
                    ))}
                    {d.selfReflection.submitted_at && (
                      <p className="help-text">
                        Submitted {new Date(d.selfReflection.submitted_at).toLocaleString()}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-muted">Not submitted.</p>
                )}
              </div>

              <div className="card">
                <div className="section-title">Peer feedback (named)</div>
                {d.peerFeedback.length === 0 ? (
                  <p className="text-muted">No peer feedback submitted.</p>
                ) : (
                  d.peerFeedback.map((pf) => (
                    <div key={pf.id} style={{ marginBottom: 12 }}>
                      <strong>{pf.reviewer_name ?? pf.reviewer_id ?? 'Unknown reviewer'}</strong>
                      {pf.strengths && <div>Strengths: {pf.strengths}</div>}
                      {pf.improvements && <div>Improvements: {pf.improvements}</div>}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="card">
              <div className="section-title">Manager review (v{d.review.version})</div>
              <div className="grid grid-cols-3">
                <Field label="Strengths" value={d.review.strengths} />
                <Field label="Focus areas" value={d.review.focus_areas} />
                <Field label="Examples" value={d.review.examples} />
                <Field label="Development areas" value={d.review.development_areas} />
                <Field label="Next cycle expectations" value={d.review.next_cycle_expectations} />
                <Field label="Manager support" value={d.review.manager_support} />
              </div>
              {d.review.follow_up_notes && <Field label="Follow-up notes" value={d.review.follow_up_notes} />}
            </div>

            {d.review.status === 'at_risk' && d.review.at_risk && (
              <div className="card">
                <div className="section-title">At-risk documentation</div>
                <div className="grid grid-cols-3">
                  <Field label="Concrete examples" value={d.review.at_risk.concrete_examples} />
                  <Field label="Prior communication" value={d.review.at_risk.prior_communication} />
                  <Field label="Support provided" value={d.review.at_risk.support_provided} />
                  <Field label="Expected improvement" value={d.review.at_risk.expected_improvement} />
                  <Field label="Timeline" value={d.review.at_risk.timeline} />
                  <Field label="People involvement" value={d.review.at_risk.people_involvement} />
                </div>
              </div>
            )}

            <div className="card">
              <div className="section-title">Version history</div>
              {d.history.length === 0 ? (
                <p className="text-muted">No prior versions.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Status</th>
                      <th>People state</th>
                      <th>Submitted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.history.map((h) => (
                      <tr key={h.version}>
                        <td>{h.version}</td>
                        <td>{h.status.replace(/_/g, ' ')}</td>
                        <td>{h.people_state.replace(/_/g, ' ')}</td>
                        <td>{h.submitted_at ? new Date(h.submitted_at).toLocaleString() : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <div className="section-title">Audit history</div>
              {d.auditEvents.length === 0 ? (
                <p className="text-muted">No audit events.</p>
              ) : (
                <ul>
                  {d.auditEvents.map((ev) => (
                    <li key={ev.id}>
                      <span className="mono">{new Date(ev.created_at).toLocaleString()}</span> —{' '}
                      {ev.action} ({ev.entity_type}) by {ev.actor_id}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card">
              <div className="section-title">Internal People Ops notes</div>
              <p className="help-text">Internal only — never shown to the employee or manager.</p>
              {d.notes.length === 0 ? (
                <p className="text-muted">No notes yet.</p>
              ) : (
                <ul>
                  {d.notes.map((n) => (
                    <li key={n.id}>
                      {n.note} —{' '}
                      <span className="text-muted">{new Date(n.created_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={submitNote} style={{ marginTop: 10 }}>
                <div className="field">
                  <label htmlFor="new-note">Add internal note</label>
                  <textarea id="new-note" value={noteText} onChange={(e) => setNoteText(e.target.value)} />
                </div>
                {noteError !== null && (
                  <div className="state-block error">{String((noteError as Error)?.message ?? noteError)}</div>
                )}
                <button className="btn" type="submit" disabled={noteSubmitting || !noteText.trim()}>
                  {noteSubmitting ? 'Adding…' : 'Add note'}
                </button>
              </form>
            </div>

            <div className="card">
              <div className="section-title">Actions</div>
              {actionError !== null && (
                <div className="state-block error">{String((actionError as Error)?.message ?? actionError)}</div>
              )}
              <div className="toolbar">
                <button className="btn" onClick={() => setDialog('return')}>
                  Return to manager
                </button>
                <button className="btn" onClick={() => setDialog('complete')}>
                  Mark people review complete
                </button>
                <button className="btn" onClick={() => setDialog('recommend')}>
                  Recommend
                </button>
                <button
                  className="btn btn-primary"
                  title={!me?.roles.isPrimaryApprover ? 'Requires Primary Approver' : undefined}
                  onClick={() => setDialog('approve')}
                >
                  Approve{d.review.status === 'at_risk' ? ' at-risk' : ''}
                </button>
                <button
                  className="btn btn-primary"
                  title={!me?.roles.isPrimaryApprover ? 'Requires Primary Approver' : undefined}
                  disabled={d.review.people_state !== 'approved'}
                  onClick={() => setDialog('release')}
                >
                  Release
                </button>
              </div>
            </div>

            {dialog === 'return' && (
              <ReturnDialog
                employeeName={d.employee.name}
                onConfirm={async (reason) => {
                  await api.returnReview(cycleId, employeeId, reason);
                  load();
                }}
                onClose={() => setDialog(null)}
              />
            )}

            {dialog === 'complete' && (
              <ConfirmDialog
                title="Mark people review complete"
                impact={<p>This marks the People review step complete for {d.employee.name}.</p>}
                confirmLabel="Mark complete"
                onConfirm={async () => {
                  await api.completeReview(cycleId, employeeId);
                  load();
                }}
                onClose={() => setDialog(null)}
              />
            )}

            {dialog === 'recommend' && (
              <ConfirmDialog
                title="Recommend review"
                impact={
                  <p>
                    This records your recommendation on {d.employee.name}'s review. It does not
                    approve or release the review.
                  </p>
                }
                confirmLabel="Recommend"
                onConfirm={async () => {
                  await api.recommendReview(cycleId, employeeId);
                  load();
                }}
                onClose={() => setDialog(null)}
              />
            )}

            {dialog === 'approve' && (
              <ConfirmDialog
                title="Approve review"
                impact={
                  <p>
                    {d.review.status === 'at_risk' && (
                      <>
                        This is an <strong>at-risk</strong> review.{' '}
                      </>
                    )}
                    This approves {d.employee.name}'s review (version {d.review.version}) for
                    release. {!me?.roles.isPrimaryApprover && 'This requires the Primary Approver — you may see a permission error.'}
                  </p>
                }
                confirmLabel="Approve"
                onConfirm={async () => {
                  try {
                    await api.approveReview(cycleId, employeeId);
                    load();
                  } catch (err) {
                    setActionError(err);
                    throw err;
                  }
                }}
                onClose={() => setDialog(null)}
              />
            )}

            {dialog === 'release' && (
              <ConfirmDialog
                title="Release review"
                impact={
                  <p>
                    This releases {d.employee.name}'s approved review to them via Slack
                    immediately. {!me?.roles.isPrimaryApprover && 'This requires the Primary Approver — you may see a permission error.'}
                  </p>
                }
                confirmLabel="Release"
                onConfirm={async () => {
                  try {
                    await api.releaseReview(cycleId, employeeId);
                    load();
                  } catch (err) {
                    setActionError(err);
                    throw err;
                  }
                }}
                onClose={() => setDialog(null)}
              />
            )}
          </>
        )}
      </DataView>
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

function ReturnDialog({
  employeeName,
  onConfirm,
  onClose,
}: {
  employeeName: string;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true">
      <div className="dialog">
        <h3>Return to manager</h3>
        <p>
          This sends {employeeName}'s review back to the manager for revision. A reason is
          required and will be shown to the manager.
        </p>
        <div className="field">
          <label htmlFor="return-reason">Reason</label>
          <textarea id="return-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </div>
        {error !== null && (
          <div className="state-block error">{String((error as Error)?.message ?? error)}</div>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !reason.trim()}>
            {busy ? 'Returning…' : 'Return to manager'}
          </button>
        </div>
      </div>
    </div>
  );
}
