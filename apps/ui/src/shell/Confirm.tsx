import type { JSX, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import './confirm.css';

// "Are you sure?" for the things that do not come back.
//
// Not `window.confirm`: Electron renders that as an OS dialog in the platform's
// own styling, which arrives looking like it came from somewhere else, and it
// blocks the renderer while it is up. This is the same surface as the rest of
// the app and says what will be lost rather than asking a general question.
//
// Deliberately not used for everything. A confirm on an action somebody takes
// often is a keystroke they learn to dismiss without reading, which makes the
// one that mattered no safer.

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element | null {
  const cancel = useRef<HTMLButtonElement | null>(null);

  // Focus lands on the way out, not on the way through: opening a dialog with
  // the destructive button focused turns a stray Return into the thing it was
  // asking about.
  useEffect(() => {
    if (open) cancel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm__scrim" data-testid="confirm">
      <div className="confirm" role="dialog" aria-modal="true" aria-label={title}>
        <p className="confirm__title">{title}</p>
        <div className="confirm__body">{body}</div>
        <div className="confirm__actions">
          <button
            type="button"
            className="button"
            data-testid="confirm-cancel"
            ref={cancel}
            onClick={onCancel}
          >
            Keep it
          </button>
          <button
            type="button"
            className="button button--danger"
            data-testid="confirm-ok"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
