import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';

// Folders CHIMERA may read.
//
// Read access, and the panel says so rather than leaving it to be assumed: a
// permission somebody cannot state back to you is one they have not really
// given. Revoking is one click, next to the thing it revokes.

interface Grant {
  path: string;
  grantedAt: string;
  missing: boolean;
}

export function FileGrantsPanel(): JSX.Element {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ grants: Grant[] }>('files:grants', {});
      setGrants(result.grants);
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="panel" data-testid="file-grants">
      <h3 className="panel__title">Folders CHIMERA can read</h3>
      <p className="agent-card__prompt">
        Agents can read files in these folders and nothing else. They cannot change or delete
        anything in them — writing still only happens inside a run&apos;s own workspace.
      </p>

      {grants.length === 0 && (
        <p className="agent-card__prompt" data-testid="file-grants-empty">
          No folders granted. Grant one to let an automation work on files where they already live.
        </p>
      )}

      {grants.map((grant) => (
        <div key={grant.path} className="connection-row" data-testid={`grant-${grant.path}`}>
          <span className={grant.missing ? 'grant__path grant__path--missing' : 'grant__path'}>
            {grant.path}
          </span>
          <span className="connection-row__meta">
            {grant.missing ? 'no longer there' : `granted ${grant.grantedAt.slice(0, 10)}`}
          </span>
          <button
            type="button"
            className="button button--quiet"
            data-testid="grant-revoke"
            onClick={() => {
              void (async () => {
                await bridge().invoke('files:revoke', { path: grant.path });
                await refresh();
              })();
            }}
          >
            Revoke
          </button>
        </div>
      ))}

      <button
        type="button"
        className="button"
        data-testid="grant-add"
        disabled={busy}
        onClick={() => {
          void (async () => {
            setBusy(true);
            setNote('');
            try {
              const result = await bridge().invoke<{ granted: boolean; reason: string }>(
                'files:grant',
                {},
              );
              if (!result.granted && result.reason !== '') setNote(result.reason);
              await refresh();
            } catch (err) {
              setNote(describeError(err).message);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        Grant a folder
      </button>

      {note !== '' && (
        <p className="connections__error" data-testid="grant-note" role="alert">
          {note}
        </p>
      )}
    </div>
  );
}
