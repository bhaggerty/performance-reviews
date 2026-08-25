import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { CycleStatus, EligiblePopulation, ReviewCycle } from '../types';
import { DataView } from '../components/DataState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useAuth } from '../AuthContext';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  collecting_feedback: 'Collecting feedback',
  manager_reviews: 'Manager reviews',
  people_review: 'People review',
  released: 'Released',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const FORWARD_TRANSITION: Partial<Record<CycleStatus, CycleStatus>> = {
  draft: 'collecting_feedback',
  collecting_feedback: 'manager_reviews',
  manager_reviews: 'people_review',
  people_review: 'released',
  released: 'closed',
};

const REQUIRES_PRIMARY_TARGETS: CycleStatus[] = ['collecting_feedback', 'cancelled', 'closed'];

export function CycleDetail() {
  const { cycleId } = useParams<{ cycleId: string }>();
  const { me } = useAuth();
  const [cycle, setCycle] = useState<ReviewCycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [population, setPopulation] = useState<EligiblePopulation | null>(null);
  const [pendingTransition, setPendingTransition] = useState<CycleStatus | null>(null);
  const [transitionError, setTransitionError] = useState<unknown>(null);

  const load = () => {
    if (!cycleId) return;
    setLoading(true);
    api
      .getCycle(cycleId)
      .then((r) => setCycle(r.cycle))
      .catch((e) => setError(e))
      .finally(() => setLoading(false));
    api
      .eligiblePopulation(cycleId)
      .then(setPopulation)
      .catch(() => undefined);
  };

  useEffect(load, [cycleId]);

  if (!cycleId) return null;

  const isPrimaryApprover = !!me?.roles.isPrimaryApprover;
  const forwardTarget = cycle ? FORWARD_TRANSITION[cycle.status] : undefined;
  const canCancel = cycle && cycle.status !== 'closed' && cycle.status !== 'cancelled';

  const doTransition = async (status: CycleStatus) => {
    if (!cycleId) return;
    setTransitionError(null);
    try {
      const result = await api.transitionCycle(cycleId, status);
      setCycle(result.cycle);
    } catch (e) {
      setTransitionError(e);
      throw e;
    }
  };

  return (
    <div>
      <p>
        <Link to="/cycles">&larr; All cycles</Link>
      </p>
      <DataView loading={loading} error={error} data={cycle}>
        {(c) => (
          <>
            <h1>
              {c.name} <span className="badge">{STATUS_LABEL[c.status] ?? c.status}</span>
            </h1>

            <div className="card">
              <div className="section-title">Details</div>
              <div className="two-col">
                <div>
                  <div className="help-text">Timezone</div>
                  <div>{c.timezone}</div>
                  <div className="help-text" style={{ marginTop: 10 }}>
                    Max peer reviewers
                  </div>
                  <div>{c.max_peers}</div>
                  <div className="help-text" style={{ marginTop: 10 }}>
                    Eligible population
                  </div>
                  <div>{population ? population.count : '—'}</div>
                </div>
                <div>
                  <div className="help-text">Deadlines</div>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {Object.entries(c.deadlines || {})
                      .filter(([, v]) => v)
                      .map(([k, v]) => (
                        <li key={k}>
                          {k.replace(/_/g, ' ')}: {new Date(v as string).toLocaleDateString()}
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="section-title">Phase transitions</div>
              <div className="toolbar">
                {forwardTarget && (
                  <TransitionButton
                    target={forwardTarget}
                    isPrimaryApprover={isPrimaryApprover}
                    onClick={() => setPendingTransition(forwardTarget)}
                  />
                )}
                {canCancel && (
                  <TransitionButton
                    target="cancelled"
                    danger
                    isPrimaryApprover={isPrimaryApprover}
                    onClick={() => setPendingTransition('cancelled')}
                  />
                )}
                {!forwardTarget && !canCancel && (
                  <span className="text-muted">This cycle is in a terminal state.</span>
                )}
              </div>
              {transitionError !== null && (
                <div className="state-block error">
                  {String((transitionError as Error)?.message ?? transitionError)}
                </div>
              )}
            </div>

            <div className="card">
              <div className="section-title">Related pages</div>
              <div className="toolbar">
                <Link className="btn btn-sm" to={`/cycles/${c.id}/reviews`}>
                  Review queue
                </Link>
                <Link className="btn btn-sm" to={`/cycles/${c.id}/at-risk`}>
                  At risk queue
                </Link>
                <Link className="btn btn-sm" to={`/cycles/${c.id}/upward-feedback`}>
                  Upward feedback
                </Link>
                <Link className="btn btn-sm" to={`/cycles/${c.id}/reminders`}>
                  Reminders
                </Link>
                <Link className="btn btn-sm" to={`/cycles/${c.id}/exports`}>
                  Exports
                </Link>
              </div>
            </div>

            {pendingTransition && (
              <ConfirmDialog
                title={`Transition to ${STATUS_LABEL[pendingTransition] ?? pendingTransition}`}
                danger={pendingTransition === 'cancelled'}
                impact={
                  <p>
                    {pendingTransition === 'cancelled'
                      ? `This will cancel the "${c.name}" cycle. This cannot be undone.`
                      : `This will move the "${c.name}" cycle from ${STATUS_LABEL[c.status]} to ${
                          STATUS_LABEL[pendingTransition] ?? pendingTransition
                        }. This affects what all employees and managers can do in Slack.`}
                    {REQUIRES_PRIMARY_TARGETS.includes(pendingTransition) && !isPrimaryApprover && (
                      <>
                        {' '}
                        <strong>This transition requires the cycle Primary Approver — you may see a
                        permission error.</strong>
                      </>
                    )}
                  </p>
                }
                confirmLabel="Transition"
                onConfirm={() => doTransition(pendingTransition)}
                onClose={() => setPendingTransition(null)}
              />
            )}
          </>
        )}
      </DataView>
    </div>
  );
}

function TransitionButton({
  target,
  isPrimaryApprover,
  danger,
  onClick,
}: {
  target: CycleStatus;
  isPrimaryApprover: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  const requiresPrimary = REQUIRES_PRIMARY_TARGETS.includes(target);
  const title =
    requiresPrimary && !isPrimaryApprover
      ? 'Requires Primary Approver — you can still try, but the server will reject it'
      : undefined;
  return (
    <button
      className={danger ? 'btn btn-danger' : 'btn'}
      onClick={onClick}
      title={title}
      aria-label={
        target === 'cancelled' ? 'Cancel cycle' : `Advance to ${STATUS_LABEL[target] ?? target}`
      }
    >
      {target === 'cancelled' ? 'Cancel cycle' : `Advance to ${STATUS_LABEL[target] ?? target}`}
      {requiresPrimary && !isPrimaryApprover ? ' *' : ''}
    </button>
  );
}
