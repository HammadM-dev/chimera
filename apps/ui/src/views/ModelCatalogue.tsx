import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { PinButton } from './ModelOptions.tsx';

// A connection's models, laid out so the two questions people actually ask can
// be answered at a glance: what does this cost, and can it call tools.
//
// The connection row used to say "419 models" and stop there. Every one of
// those had a price and a context window sitting in the database, imported and
// then never shown, which meant choosing a model was guesswork against a name.

export interface CatalogueEntry {
  id: string;
  displayName: string;
  vendor: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  toolCalling: string;
  vision: string;
}

/** `1000000` reads as 1M, `128000` as 128K. Long numbers in a dense row do not. */
function compact(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`;
  if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}K`;
  return String(tokens);
}

/**
 * A price per million, at the precision it deserves.
 *
 * Sub-dollar models are the majority on a router and `$0` for all of them would
 * be useless, so those get cents. Free is written as a word: `$0.00` invites the
 * reader to wonder whether it means free or unknown, and those are the two
 * things this column exists to keep apart.
 */
function money(perMillion: number | null): string {
  if (perMillion === null) return '—';
  if (perMillion === 0) return 'Free';
  if (perMillion < 1) return `$${perMillion.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${perMillion.toFixed(2)}`;
}

export function ModelCatalogue({
  connectionId,
  label,
}: {
  connectionId: string;
  label: string;
}): JSX.Element {
  const [models, setModels] = useState<CatalogueEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await bridge().invoke<{ models: CatalogueEntry[] }>('connection:catalogue', {
        connectionId,
      });
      setModels(result.models);
    } catch (err) {
      setNote(describeError(err).message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching =
      needle === ''
        ? models
        : models.filter(
            (model) =>
              model.id.toLowerCase().includes(needle) ||
              model.displayName.toLowerCase().includes(needle),
          );

    const byVendor = new Map<string, CatalogueEntry[]>();
    for (const model of matching) {
      const existing = byVendor.get(model.vendor);
      if (existing) existing.push(model);
      else byVendor.set(model.vendor, [model]);
    }
    return [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, filter]);

  const shown = groups.reduce((total, [, entries]) => total + entries.length, 0);
  const priced = models.filter((model) => model.inputPerMillion !== null).length;

  return (
    <div className="catalogue" data-testid="model-catalogue">
      <div className="catalogue__head">
        <input
          className="control"
          data-testid="catalogue-filter"
          placeholder={`Search ${label} models`}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
        />
        <span className="catalogue__count">
          {loading
            ? 'Loading'
            : filter.trim() === ''
              ? `${String(models.length)} models · ${String(priced)} priced`
              : `${String(shown)} of ${String(models.length)}`}
        </span>
      </div>

      {note !== '' && <p className="agent-card__prompt">{note}</p>}

      {!loading && models.length === 0 && (
        <p className="agent-card__prompt">
          No catalogue imported for this connection. Models can still be typed by name.
        </p>
      )}

      {!loading && models.length > 0 && shown === 0 && (
        <p className="agent-card__prompt">No model matches that.</p>
      )}

      <div className="catalogue__scroll scroll">
        {groups.map(([vendor, entries]) => (
          <section key={vendor} className="catalogue__group">
            <header className="catalogue__vendor">
              <span>{vendor}</span>
              <span className="catalogue__vendor-count">{entries.length}</span>
            </header>

            {entries.map((model) => (
              <div key={model.id} className="model" data-testid="catalogue-model">
                <div className="model__name">
                  <span className="model__title">{model.displayName}</span>
                  <span className="model__id">{model.id}</span>
                </div>

                <div className="model__facts">
                  {/* Price first: it is the field people came to read, and the
                      one the run will be held to. */}
                  <span className="model__price" title="Input / output per million tokens">
                    {money(model.inputPerMillion)}
                    <span className="model__slash"> / </span>
                    {money(model.outputPerMillion)}
                  </span>
                  <span className="model__context" title="Context window">
                    {compact(model.contextWindowTokens)}
                  </span>
                  <span className="model__marks">
                    {model.toolCalling === 'supported' && (
                      <span className="model__mark" title="Can call tools">
                        Tools
                      </span>
                    )}
                    {model.vision === 'supported' && (
                      <span className="model__mark" title="Can read images">
                        Vision
                      </span>
                    )}
                    {model.inputPerMillion === null && (
                      <span
                        className="model__mark model__mark--warn"
                        title="No verified price — a spend cap cannot be enforced on this model"
                      >
                        Unpriced
                      </span>
                    )}
                  </span>
                  {/* The pin, on the row rather than only beside a picker.
                      This is the list somebody scrolls when deciding what they
                      use; making them choose it in a dropdown first and pin it
                      there would be the long way round. */}
                  <PinButton modelKey={`${connectionId}::${model.id}`} />
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
