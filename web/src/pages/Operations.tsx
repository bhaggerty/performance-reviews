import { useEffect, useState } from 'react';
import { api } from '../api';
import type { OperationsJobs, OutboxJob } from '../types';
import { DataView } from '../components/DataState';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function Operations() {
  const [jobs, setJobs] = useState<OperationsJobs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryTarget, setRetryTarget] = useState<OutboxJob | null>(null);

  const load = () => {
    setLoading(true);
    api
      .listJobs()
      .then(setJobs)
      .catch(setError)
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div>
      <h1>Operations</h1>

      <DataView loading={loading} error={error} data={jobs}>
        {(j) => (
          <>
            <JobTable title="Dead letter" rows={j.deadLetter} allowRetry onRetry={setRetryTarget} />
            <JobTable title="Failed" rows={j.failed} />
            <JobTable title="Processing" rows={j.processing} />
            <JobTable title="Pending" rows={j.pending} />
          </>
        )}
      </DataView>

      {retryTarget && (
        <ConfirmDialog
          title="Retry job"
          impact={
            <p>
              This re-enqueues job <strong>{retryTarget.id}</strong> ({retryTarget.type}) for
              another attempt.
            </p>
          }
          confirmLabel="Retry"
          onConfirm={async () => {
            await api.retryJob(retryTarget.id);
            load();
          }}
          onClose={() => setRetryTarget(null)}
        />
      )}
    </div>
  );
}

function JobTable({
  title,
  rows,
  allowRetry,
  onRetry,
}: {
  title: string;
  rows: OutboxJob[];
  allowRetry?: boolean;
  onRetry?: (job: OutboxJob) => void;
}) {
  return (
    <div className="card">
      <div className="section-title">
        {title} ({rows.length})
      </div>
      {rows.length === 0 ? (
        <p className="text-muted">None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Run after</th>
              <th>Last error</th>
              {allowRetry && <th></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((job) => (
              <tr key={job.id}>
                <td>{job.type}</td>
                <td>{job.status}</td>
                <td>
                  {job.attempts} / {job.max_attempts}
                </td>
                <td>{new Date(job.run_after).toLocaleString()}</td>
                <td className="text-muted">{job.last_error ?? '—'}</td>
                {allowRetry && (
                  <td>
                    <button className="btn btn-sm" onClick={() => onRetry?.(job)}>
                      Retry
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
