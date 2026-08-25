import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { AuditEvent } from '../types';
import { DataView } from '../components/DataState';

export function Audit() {
  const [actorId, setActorId] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    if (!actorId && !(entityType && entityId)) {
      setValidationError('Provide an actor ID, or both an entity type and entity ID.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.listAudit({
        actor_id: actorId || undefined,
        entity_type: entityType || undefined,
        entity_id: entityId || undefined,
        cycle_id: cycleId || undefined,
        action: action || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined,
      });
      setEvents(result.events);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Audit</h1>

      <form className="card" onSubmit={submit}>
        <p className="help-text">Provide an actor ID, or both an entity type and entity ID.</p>
        <div className="grid grid-cols-3">
          <div className="field">
            <label htmlFor="audit-actor">Actor ID</label>
            <input id="audit-actor" type="text" value={actorId} onChange={(e) => setActorId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="audit-entity-type">Entity type</label>
            <input
              id="audit-entity-type"
              type="text"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="audit-entity-id">Entity ID</label>
            <input
              id="audit-entity-id"
              type="text"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="audit-cycle">Cycle ID</label>
            <input id="audit-cycle" type="text" value={cycleId} onChange={(e) => setCycleId(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="audit-action">Action</label>
            <input id="audit-action" type="text" value={action} onChange={(e) => setAction(e.target.value)} />
          </div>
          <div />
          <div className="field">
            <label htmlFor="audit-from">From</label>
            <input id="audit-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="audit-to">To</label>
            <input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        {validationError && <div className="state-block error">{validationError}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {(events !== null || error !== null) && (
        <div className="card">
          <DataView
            loading={false}
            error={error}
            data={events}
            isEmpty={(d) => d.length === 0}
            emptyLabel="No matching audit events."
          >
            {(rows) => (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Entity type</th>
                    <th>Entity ID</th>
                    <th>Actor</th>
                    <th>Cycle</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((ev) => (
                    <tr key={ev.id}>
                      <td>{new Date(ev.created_at).toLocaleString()}</td>
                      <td>{ev.action}</td>
                      <td>{ev.entity_type}</td>
                      <td className="mono">{ev.entity_id}</td>
                      <td>{ev.actor_id}</td>
                      <td>{ev.cycle_id ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </DataView>
        </div>
      )}
    </div>
  );
}
