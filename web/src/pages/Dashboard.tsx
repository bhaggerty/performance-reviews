import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { DashboardData } from '../types';
import { DataView } from '../components/DataState';

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .dashboard()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <h1>Dashboard</h1>
      <DataView loading={loading} error={error} data={data}>
        {(d) => {
          const cycleId = d.cycle?.id;
          return (
            <>
              <div className="card">
                <div className="section-title">Active cycle</div>
                {d.cycle ? (
                  <>
                    <div>
                      <strong>{d.cycle.name}</strong>{' '}
                      <span className="badge">{d.cycle.status.replace(/_/g, ' ')}</span>
                    </div>
                    <div className="text-muted" style={{ marginTop: 8 }}>
                      Timezone: {d.cycle.timezone}
                    </div>
                    <div className="two-col" style={{ marginTop: 12 }}>
                      <div>
                        <div className="help-text">Key deadlines</div>
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                          {Object.entries(d.cycle.deadlines || {})
                            .filter(([, v]) => v)
                            .map(([k, v]) => (
                              <li key={k}>
                                {k.replace(/_/g, ' ')}: {new Date(v as string).toLocaleDateString()}
                              </li>
                            ))}
                        </ul>
                      </div>
                      <div>
                        <div className="help-text">Completion</div>
                        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                          {Object.entries(d.completion || {}).map(([k, v]) => (
                            <li key={k}>
                              {k.replace(/_/g, ' ')}: {v}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <Link className="btn btn-sm" to={`/cycles/${cycleId}`}>
                        View cycle
                      </Link>{' '}
                      <Link className="btn btn-sm" to={`/cycles/${cycleId}/reviews`}>
                        Review queue
                      </Link>
                    </div>
                  </>
                ) : (
                  <div className="text-muted">
                    No active cycle. <Link to="/cycles">Create one</Link>.
                  </div>
                )}
              </div>

              <div className="grid grid-cols-4" style={{ marginTop: 16 }}>
                <QueueTile
                  label="People review waiting"
                  value={d.queues.people_review_waiting}
                  to={cycleId ? `/cycles/${cycleId}/reviews` : undefined}
                />
                <QueueTile
                  label="Primary approval waiting"
                  value={d.queues.primary_approval_waiting}
                  to={cycleId ? `/cycles/${cycleId}/reviews` : undefined}
                />
                <QueueTile
                  label="At risk waiting"
                  value={d.queues.at_risk_waiting}
                  to={cycleId ? `/cycles/${cycleId}/at-risk` : undefined}
                />
                <QueueTile
                  label="Ready for release"
                  value={d.queues.ready_for_release}
                  to={cycleId ? `/cycles/${cycleId}/reviews` : undefined}
                />
                <QueueTile
                  label="Released, unacknowledged"
                  value={d.queues.released_unacknowledged}
                  to={cycleId ? `/cycles/${cycleId}/reviews` : undefined}
                />
                <QueueTile
                  label="Failed jobs"
                  value={d.operations.failed_jobs}
                  to="/operations"
                  warn={d.operations.failed_jobs > 0}
                />
              </div>
            </>
          );
        }}
      </DataView>
    </div>
  );
}

function QueueTile({
  label,
  value,
  to,
  warn,
}: {
  label: string;
  value: number;
  to?: string;
  warn?: boolean;
}) {
  const body = (
    <div className="stat-tile" style={warn && value > 0 ? { borderColor: 'var(--color-danger)' } : undefined}>
      <div className="stat-value" style={warn && value > 0 ? { color: 'var(--color-danger)' } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
  if (!to) return body;
  return (
    <Link to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
      {body}
    </Link>
  );
}
