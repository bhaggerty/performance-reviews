import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { ReminderPreview, ReminderType } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';

const REMINDER_TYPES: Array<{ type: ReminderType; label: string; informational?: boolean }> = [
  { type: 'self_reflection_missing', label: 'Self-reflection missing' },
  { type: 'peer_request_pending', label: 'Peer request pending' },
  { type: 'peer_feedback_incomplete', label: 'Peer feedback incomplete' },
  { type: 'upward_feedback_missing', label: 'Upward feedback missing' },
  { type: 'manager_review_missing', label: 'Manager review missing' },
  { type: 'manager_review_returned', label: 'Manager review returned' },
  { type: 'people_review_waiting', label: 'People review waiting', informational: true },
  { type: 'primary_approval_waiting', label: 'Primary approval waiting', informational: true },
  { type: 'released_unacknowledged', label: 'Released, unacknowledged' },
];

export function Reminders() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const [type, setType] = useState<ReminderType>('self_reflection_missing');
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [showSend, setShowSend] = useState(false);
  const [sendResult, setSendResult] = useState<{ enqueued: number; skipped: number } | null>(null);

  const current = REMINDER_TYPES.find((t) => t.type === type)!;

  const loadPreview = () => {
    if (!cycleId) return;
    setLoading(true);
    setError(null);
    setSendResult(null);
    api
      .previewReminder(cycleId, type)
      .then((p) => {
        setPreview(p);
        setExcluded(new Set());
      })
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(loadPreview, [cycleId, type]);

  const toggleExclude = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const doSend = async () => {
    if (!cycleId) return;
    const result = await api.sendReminder(cycleId, type, Array.from(excluded));
    setSendResult(result);
  };

  if (!cycleId) return null;

  return (
    <div>
      <p>
        <Link to={`/cycles/${cycleId}`}>&larr; Cycle</Link>
      </p>
      <h1>Reminders</h1>

      <div className="card">
        <div className="field">
          <label htmlFor="reminder-type">Reminder type</label>
          <select id="reminder-type" value={type} onChange={(e) => setType(e.target.value as ReminderType)}>
            {REMINDER_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {loading && <div className="state-block">Loading preview…</div>}
        {error !== null && (
          <div className="state-block error">{String((error as Error)?.message ?? error)}</div>
        )}

        {preview && !loading && (
          <>
            <div className="card">
              <div className="section-title">Message preview</div>
              <p>{preview.message}</p>
            </div>

            <div className="section-title">
              Recipients ({preview.recipients.length - excluded.size} of {preview.recipients.length})
            </div>
            {preview.recipients.length === 0 ? (
              <p className="text-muted">No recipients — everyone is up to date.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Reason</th>
                    {!current.informational && <th>Exclude</th>}
                  </tr>
                </thead>
                <tbody>
                  {preview.recipients.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td>{r.reason}</td>
                      {!current.informational && (
                        <td>
                          <input
                            type="checkbox"
                            checked={excluded.has(r.id)}
                            onChange={() => toggleExclude(r.id)}
                            aria-label={`Exclude ${r.name}`}
                          />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {current.informational ? (
              <p className="help-text" style={{ marginTop: 12 }}>
                This is an informational count only — no Slack message is sent for this type since
                there is no single employee recipient.
              </p>
            ) : (
              <button
                className="btn btn-primary"
                style={{ marginTop: 12 }}
                disabled={preview.recipients.length === 0}
                onClick={() => setShowSend(true)}
              >
                Send reminder
              </button>
            )}

            {sendResult && (
              <div className="card">
                Enqueued {sendResult.enqueued}, skipped {sendResult.skipped}.
              </div>
            )}
          </>
        )}
      </div>

      {showSend && preview && (
        <ConfirmDialog
          title="Send reminder"
          impact={
            <p>
              This sends the "{current.label}" reminder to{' '}
              <strong>{preview.recipients.length - excluded.size}</strong> recipient(s) via Slack.
            </p>
          }
          confirmLabel="Send"
          onConfirm={doSend}
          onClose={() => setShowSend(false)}
        />
      )}
    </div>
  );
}
