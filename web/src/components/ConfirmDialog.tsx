import { useState } from 'react';
import type { ReactNode } from 'react';

interface ConfirmDialogProps {
  title: string;
  impact: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/**
 * A modal confirmation dialog for destructive / high-impact actions.
 * Renders `impact` as plain-language description of what will happen.
 */
export function ConfirmDialog({
  title,
  impact,
  confirmLabel = 'Confirm',
  danger = false,
  requireText,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typedText, setTypedText] = useState('');

  const canConfirm = !requireText || typedText === requireText;

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <div className="dialog">
        <h3 id="confirm-dialog-title">{title}</h3>
        <div>{impact}</div>
        {requireText && (
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="confirm-type-text">Type "{requireText}" to confirm</label>
            <input
              id="confirm-type-text"
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
            />
          </div>
        )}
        {error && (
          <div className="state-block error" style={{ padding: '8px 0', textAlign: 'left' }}>
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={handleConfirm}
            disabled={busy || !canConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
