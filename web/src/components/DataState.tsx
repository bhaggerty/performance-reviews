import type { ReactNode } from 'react';
import { ApiRequestError } from '../api';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="state-block">{label}</div>;
}

export function EmptyState({ label }: { label: string }) {
  return <div className="state-block">{label}</div>;
}

export function ErrorState({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) {
      const code = error.body?.error;
      if (code === 'requires_primary_approver' || code === 'not_primary_approver') {
        return (
          <div className="state-block error">
            <strong>Primary Approver required.</strong>
            <div>{error.body?.message || 'This action can only be performed by the cycle Primary Approver.'}</div>
          </div>
        );
      }
      return (
        <div className="state-block error">
          <strong>Not authorized.</strong>
          <div>{error.body?.message || 'You do not have permission to view this.'}</div>
        </div>
      );
    }
    if (error.status === 401) {
      return (
        <div className="state-block error">
          <strong>Session expired.</strong>
          <div>Please sign in again.</div>
        </div>
      );
    }
    return (
      <div className="state-block error">
        <strong>Something went wrong.</strong>
        <div>{error.message}</div>
      </div>
    );
  }
  return (
    <div className="state-block error">
      <strong>Something went wrong.</strong>
      <div>{String(error)}</div>
    </div>
  );
}

/** Renders one of loading/error/empty/content based on the state given. */
export function DataView<T>({
  loading,
  error,
  data,
  isEmpty,
  emptyLabel = 'Nothing to show yet.',
  children,
}: {
  loading: boolean;
  error: unknown;
  data: T | null;
  isEmpty?: (data: T) => boolean;
  emptyLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (data === null || data === undefined) return <EmptyState label={emptyLabel} />;
  if (isEmpty && isEmpty(data)) return <EmptyState label={emptyLabel} />;
  return <>{children(data)}</>;
}
