import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { ReviewCycle, SelfReflectionPrompt } from '../types';
import { DataView } from '../components/DataState';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  collecting_feedback: 'Collecting feedback',
  manager_reviews: 'Manager reviews',
  people_review: 'People review',
  released: 'Released',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export function Cycles() {
  const [cycles, setCycles] = useState<ReviewCycle[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    setLoading(true);
    api
      .listCycles()
      .then((r) => setCycles(r.cycles))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div>
      <h1>Cycle Management</h1>

      <div className="card">
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? 'Cancel' : 'New cycle'}
          </button>
        </div>

        {showCreate && (
          <CreateCycleForm
            onCreated={(cycle) => {
              setShowCreate(false);
              load();
              navigate(`/cycles/${cycle.id}`);
            }}
          />
        )}

        <DataView
          loading={loading}
          error={error}
          data={cycles}
          isEmpty={(d) => d.length === 0}
          emptyLabel="No review cycles yet."
        >
          {(rows) => (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Timezone</th>
                  <th>Target release</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/cycles/${c.id}`)}>
                    <td>{c.name}</td>
                    <td>
                      <span className="badge">{STATUS_LABEL[c.status] ?? c.status}</span>
                    </td>
                    <td>{c.timezone}</td>
                    <td>
                      {c.deadlines?.target_release_date
                        ? new Date(c.deadlines.target_release_date).toLocaleDateString()
                        : '—'}
                    </td>
                    <td>
                      <Link className="btn btn-sm" to={`/cycles/${c.id}`}>
                        View
                      </Link>
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

function CreateCycleForm({ onCreated }: { onCreated: (cycle: ReviewCycle) => void }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [maxPeers, setMaxPeers] = useState(3);
  const [deadlines, setDeadlines] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<SelfReflectionPrompt[]>([
    { key: 'accomplishments', label: 'Key accomplishments this cycle', required: true },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const DEADLINE_FIELDS: Array<{ key: string; label: string }> = [
    { key: 'cycle_start', label: 'Cycle start' },
    { key: 'self_reflection_due', label: 'Self-reflection due' },
    { key: 'peer_requests_due', label: 'Peer requests due' },
    { key: 'peer_feedback_due', label: 'Peer feedback due' },
    { key: 'upward_feedback_due', label: 'Upward feedback due' },
    { key: 'manager_reviews_due', label: 'Manager reviews due' },
    { key: 'target_release_date', label: 'Target release date' },
    { key: 'acknowledgement_due', label: 'Acknowledgement due' },
    { key: 'cycle_close', label: 'Cycle close' },
  ];

  const updatePrompt = (idx: number, field: keyof SelfReflectionPrompt, value: string | boolean) => {
    setPrompts((p) => p.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cleanedDeadlines = Object.fromEntries(
        Object.entries(deadlines)
          .filter(([, v]) => v)
          .map(([k, v]) => [k, new Date(v).toISOString()])
      );
      const result = await api.createCycle({
        name,
        timezone,
        max_peers: maxPeers,
        deadlines: cleanedDeadlines,
        self_reflection_prompts: prompts,
      });
      onCreated(result.cycle);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="card" style={{ marginBottom: 16 }}>
      <div className="field">
        <label htmlFor="cycle-name">Cycle name</label>
        <input id="cycle-name" type="text" required value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="two-col">
        <div className="field">
          <label htmlFor="cycle-tz">Timezone</label>
          <input id="cycle-tz" type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="cycle-max-peers">Max peer reviewers</label>
          <input
            id="cycle-max-peers"
            type="number"
            min={1}
            value={maxPeers}
            onChange={(e) => setMaxPeers(Number(e.target.value))}
          />
        </div>
      </div>

      <div className="section-title">Deadlines</div>
      <div className="grid grid-cols-3">
        {DEADLINE_FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`deadline-${f.key}`}>{f.label}</label>
            <input
              id={`deadline-${f.key}`}
              type="date"
              value={deadlines[f.key] ?? ''}
              onChange={(e) => setDeadlines((d) => ({ ...d, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="section-title">Self-reflection prompts</div>
      {prompts.map((p, i) => (
        <div className="two-col" key={i} style={{ marginBottom: 8 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`prompt-label-${i}`}>Prompt {i + 1}</label>
            <input
              id={`prompt-label-${i}`}
              type="text"
              value={p.label}
              onChange={(e) => updatePrompt(i, 'label', e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={p.required}
                onChange={(e) => updatePrompt(i, 'required', e.target.checked)}
              />
              Required
            </label>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPrompts((arr) => arr.filter((_, idx) => idx !== i))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() =>
          setPrompts((arr) => [
            ...arr,
            { key: `prompt_${arr.length + 1}`, label: '', required: false },
          ])
        }
      >
        Add prompt
      </button>

      {error !== null && (
        <div className="state-block error">{String((error as Error)?.message ?? error)}</div>
      )}

      <div style={{ marginTop: 16 }}>
        <button type="submit" className="btn btn-primary" disabled={submitting || !name}>
          {submitting ? 'Creating…' : 'Create cycle'}
        </button>
      </div>
    </form>
  );
}
