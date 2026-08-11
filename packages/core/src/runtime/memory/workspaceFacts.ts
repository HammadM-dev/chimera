import type Database from 'better-sqlite3';
import { ValidationError } from '@chimera/errors';
import { workspaceFactsRepository, type WorkspaceFact } from '@chimera/store';

// F2.7's second memory tier: curated facts that outlive a run.
//
// Curated is the operative word. This is not "everything the agent saw" — it is
// a small key-value store a person can read, edit, and delete, which is what
// makes it trustworthy enough to put in a prompt. The vector store (F2.7's
// third tier) is the uncurated one, and it arrives at M9.

export interface FactSource {
  /** `user` when a person typed it, otherwise the id of the run that wrote it. */
  source: string;
}

export interface WorkspaceFactsStore {
  list: () => WorkspaceFact[];
  get: (key: string) => string | undefined;
  set: (key: string, value: string, source: FactSource) => WorkspaceFact;
  remove: (key: string) => boolean;
  /** Rendered for the prompt. Empty string when the workspace has no facts. */
  render: () => string;
}

const MAX_KEY_LENGTH = 200;
const MAX_VALUE_LENGTH = 4_000;

export function createWorkspaceFacts(db: Database.Database): WorkspaceFactsStore {
  return {
    list: () => workspaceFactsRepository.list(db),
    get: (key) => workspaceFactsRepository.get(db, key)?.value,

    set(key, value, source) {
      const trimmed = key.trim();
      if (trimmed === '') {
        throw new ValidationError('FACT_KEY_EMPTY', 'A workspace fact needs a key.', {});
      }
      if (trimmed.length > MAX_KEY_LENGTH || value.length > MAX_VALUE_LENGTH) {
        // Bounded because these go into every prompt for the workspace. An
        // agent that could write an unbounded fact could push the real
        // instructions out of the context window with its own text.
        throw new ValidationError(
          'FACT_TOO_LARGE',
          `A workspace fact is limited to ${String(MAX_KEY_LENGTH)} characters of key and ${String(MAX_VALUE_LENGTH)} of value.`,
          { key: trimmed.slice(0, 40), keyLength: trimmed.length, valueLength: value.length },
        );
      }
      return workspaceFactsRepository.set(db, trimmed, value, source.source);
    },

    remove: (key) => workspaceFactsRepository.remove(db, key),

    render() {
      const facts = workspaceFactsRepository.list(db);
      if (facts.length === 0) return '';
      // The source travels with the fact. What an agent asserted and what the
      // user stated are not equally trustworthy, and a rendering that flattened
      // the two would quietly launder the difference.
      return facts.map((fact) => `${fact.key}: ${fact.value} (source: ${fact.source})`).join('\n');
    },
  };
}
