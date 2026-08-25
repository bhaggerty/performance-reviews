import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type {
  UpwardFeedbackManagerSummary,
  UpwardFeedbackMode,
  UpwardFeedbackSubmission,
} from '../types';
import { DataView } from '../components/DataState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../AuthContext';

export function UpwardFeedback() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const [managers, setManagers] = useState<UpwardFeedbackManagerSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => {
    if (!cycleId) return;
    setLoading(true);
    api
      .listUpwardFeedback(cycleId)
      .then((r) => setManagers(r.managers))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  };

  useEffect(load, [cycleId]);

  if (!cycleId) return null;

  const selectedSummary = managers?.find((m) => m.manager.id === selected) ?? null;

  return (
    <div>
      <p>
        <Link to={`/cycles/${cycleId}`}>&larr; Cycle</Link>
      </p>
      <h1>Upward Feedback</h1>

      <div className="card">
        <DataView
          loading={loading}
          error={error}
          data={managers}
          isEmpty={(d) => d.length === 0}
          emptyLabel="No managers in scope for upward feedback this cycle."
        >
          {(rows) => (
            <table>
              <thead>
                <tr>
                  <th>Manager</th>
                  <th>Respondents</th>
                  <th>Below threshold</th>
                  <th>Released</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr
                    key={m.manager.id}
                    className="clickable"
                    onClick={() => setSelected(m.manager.id)}
                  >
                    <td>{m.manager.name}</td>
                    <td>{m.respondentCount}</td>
                    <td>{m.belowThreshold && <span className="badge warning">below threshold</span>}</td>
                    <td>{m.released && <span className="badge success">released</span>}</td>
                    <td>
                      <button className="btn btn-sm">View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DataView>
      </div>

      {selectedSummary && cycleId && (
        <ManagerPanel
          cycleId={cycleId}
          summary={selectedSummary}
          onClose={() => setSelected(null)}
          onReleased={load}
        />
      )}
    </div>
  );
}

function ManagerPanel({
  cycleId,
  summary,
  onClose,
  onReleased,
}: {
  cycleId: string;
  summary: UpwardFeedbackManagerSummary;
  onClose: () => void;
  onReleased: () => void;
}) {
  const { me } = useAuth();
  const [submissions, setSubmissions] = useState<UpwardFeedbackSubmission[] | null>(null);
  const [rawLoading, setRawLoading] = useState(true);
  const [rawError, setRawError] = useState<unknown>(null);

  const [mode, setMode] = useState<UpwardFeedbackMode>('summary_only');
  const [summaryText, setSummaryText] = useState(summary.release?.summary_text ?? '');
  const [selectedComments, setSelectedComments] = useState<Set<string>>(
    new Set(summary.release?.selected_comment_ids ?? [])
  );
  const [overrideReason, setOverrideReason] = useState(summary.release?.threshold_override_reason ?? '');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<unknown>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [releaseError, setReleaseError] = useState<unknown>(null);

  useEffect(() => {
    setRawLoading(true);
    api
      .rawUpwardFeedback(cycleId, summary.manager.id)
      .then((r) => setSubmissions(r.submissions))
      .catch(setRawError)
      .finally(() => setRawLoading(false));
  }, [cycleId, summary.manager.id]);

  const toggleComment = (id: string) => {
    setSelectedComments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const requestDraft = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const result = await api.draftUpwardSummary(cycleId, summary.manager.id);
      if (result.draftSummary) setSummaryText(result.draftSummary);
    } catch (e) {
      setDraftError(e);
    } finally {
      setDrafting(false);
    }
  };

  const needsOverride = summary.belowThreshold && !overrideReason.trim();

  const doRelease = async () => {
    setReleaseError(null);
    try {
      await api.releaseUpwardFeedback(cycleId, summary.manager.id, {
        mode,
        summary_text: mode !== 'comments_only' ? summaryText : undefined,
        selected_comment_ids:
          mode !== 'summary_only' ? Array.from(selectedComments) : undefined,
        threshold_override_reason: summary.belowThreshold ? overrideReason.trim() : undefined,
      });
      onReleased();
      onClose();
    } catch (e) {
      setReleaseError(e);
      throw e;
    }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div className="section-title">Upward feedback for {summary.manager.name}</div>
        <button className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>

      {summary.belowThreshold && (
        <div className="card" style={{ background: 'var(--color-warning-bg)', borderColor: 'transparent' }}>
          <strong>Re-identification risk warning:</strong> This manager has only{' '}
          {summary.respondentCount} respondent(s), below the anonymity threshold of 3. Releasing
          feedback with so few respondents may allow the manager to identify who said what. An
          override reason is required to proceed.
        </div>
      )}

      <div className="section-title" style={{ marginTop: 12 }}>
        Raw anonymized submissions (People-only — never shown to the manager)
      </div>
      {rawLoading && <div className="state-block">Loading…</div>}
      {rawError !== null && (
        <div className="state-block error">{String((rawError as Error)?.message ?? rawError)}</div>
      )}
      {submissions && submissions.length === 0 && <p className="text-muted">No submissions.</p>}
      {submissions?.map((s) => (
        <div key={s.anonymousId} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <strong>{s.anonymousId}</strong>
            {mode !== 'summary_only' && (
              <label style={{ fontWeight: 400, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={selectedComments.has(s.anonymousId)}
                  onChange={() => toggleComment(s.anonymousId)}
                />
                Include in release
              </label>
            )}
          </div>
          {s.strengths && <div>Strengths: {s.strengths}</div>}
          {s.improvements && <div>Improvements: {s.improvements}</div>}
          {s.hr_notes && (
            <div className="help-text">
              People-only note: {s.hr_notes} ({s.allow_hr_followup ? 'follow-up OK' : 'no follow-up'})
            </div>
          )}
        </div>
      ))}

      <div className="section-title" style={{ marginTop: 16 }}>
        Prepare release
      </div>
      <div className="field">
        <label htmlFor="uf-mode">Release mode</label>
        <select id="uf-mode" value={mode} onChange={(e) => setMode(e.target.value as UpwardFeedbackMode)}>
          <option value="none">None (do not release)</option>
          <option value="summary_only">Summary only</option>
          <option value="comments_only">Selected comments only</option>
          <option value="summary_and_comments">Summary and selected comments</option>
        </select>
      </div>

      {(mode === 'summary_only' || mode === 'summary_and_comments') && (
        <div className="field">
          <label htmlFor="uf-summary">Summary (AI-assisted draft, always editable)</label>
          <textarea
            id="uf-summary"
            value={summaryText}
            onChange={(e) => setSummaryText(e.target.value)}
            rows={6}
          />
          <button className="btn btn-sm" type="button" onClick={requestDraft} disabled={drafting} style={{ marginTop: 6 }}>
            {drafting ? 'Drafting…' : 'Generate AI draft'}
          </button>
          {draftError !== null && (
            <div className="help-text" style={{ color: 'var(--color-danger)' }}>
              Draft unavailable: {String((draftError as Error)?.message ?? draftError)}
            </div>
          )}
        </div>
      )}

      {summary.belowThreshold && (
        <div className="field">
          <label htmlFor="uf-override">Override reason (required — below anonymity threshold)</label>
          <textarea
            id="uf-override"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
        </div>
      )}

      <div className="card">
        <div className="section-title">Preview: exactly what the manager will see</div>
        {mode === 'none' && <p className="text-muted">Nothing will be released.</p>}
        {(mode === 'summary_only' || mode === 'summary_and_comments') && (
          <>
            <div className="help-text">Summary</div>
            <div>{summaryText || <em>No summary text.</em>}</div>
          </>
        )}
        {(mode === 'comments_only' || mode === 'summary_and_comments') && (
          <>
            <div className="help-text" style={{ marginTop: 8 }}>
              Selected comments ({selectedComments.size})
            </div>
            {submissions
              ?.filter((s) => selectedComments.has(s.anonymousId))
              .map((s) => (
                <div key={s.anonymousId} style={{ marginTop: 6 }}>
                  {s.strengths && <div>{s.strengths}</div>}
                  {s.improvements && <div>{s.improvements}</div>}
                </div>
              ))}
          </>
        )}
      </div>

      {releaseError !== null && (
        <div className="state-block error">{String((releaseError as Error)?.message ?? releaseError)}</div>
      )}

      <button
        className="btn btn-primary"
        style={{ marginTop: 12 }}
        title={!me?.roles.isPrimaryApprover ? 'Requires Primary Approver' : undefined}
        disabled={mode === 'none' || needsOverride}
        onClick={() => setShowConfirm(true)}
      >
        Release to manager
      </button>

      {showConfirm && (
        <ConfirmDialog
          title="Release upward feedback"
          impact={
            <p>
              This releases upward feedback for <strong>{summary.manager.name}</strong> in mode{' '}
              <strong>{mode.replace(/_/g, ' ')}</strong>. The manager will be notified via Slack.
              {!me?.roles.isPrimaryApprover &&
                ' This requires the Primary Approver — you may see a permission error.'}
            </p>
          }
          confirmLabel="Release"
          onConfirm={doRelease}
          onClose={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
