import { ChimeraError } from '@chimera/errors';

// F2.7's third memory tier — semantic recall over a local sqlite-vec index.
//
// Not implemented here, by decision recorded in docs/ROADMAP.md M2-10: it needs
// the same embedding infrastructure as M9-3's semantic response cache, and
// standing that up twice on two SHOULD-tagged features neither of which gates
// an earlier demo is work done twice.
//
// The interface exists, and calling it throws. That is the point: a node
// configured with `memory.vectorStore: true` has to fail where the user can see
// it, not silently do nothing and leave them believing their agent has a memory
// it does not have.

export interface VectorSearchResult {
  id: string;
  text: string;
  score: number;
}

export interface VectorStore {
  add: (id: string, text: string) => Promise<void>;
  search: (query: string, limit?: number) => Promise<VectorSearchResult[]>;
}

const UNAVAILABLE =
  'The vector store is not available until M9, when it is built alongside the semantic cache. ' +
  'Set memory.vectorStore to false, or use workspace facts for knowledge that must persist.';

export class VectorStoreUnavailableError extends ChimeraError {
  constructor(details: Record<string, unknown> = {}) {
    super('MEMORY_VECTOR_STORE_UNAVAILABLE', UNAVAILABLE, details);
  }
}

/**
 * Throws unless the caller's memory configuration is one this build supports.
 *
 * Called at invocation time rather than at save time so it holds for a workflow
 * imported from elsewhere, or edited by hand, that no validator in this build
 * ever saw.
 */
export interface MemoryConfig {
  scratchpad?: boolean;
  workspaceFacts?: boolean;
  vectorStore?: boolean;
}

export function assertMemoryAvailable(
  memory: MemoryConfig | undefined,
  context: Record<string, unknown> = {},
): void {
  if (memory?.vectorStore === true) throw new VectorStoreUnavailableError(context);
}

export function createVectorStore(): VectorStore {
  return {
    add: () => Promise.reject(new VectorStoreUnavailableError()),
    search: () => Promise.reject(new VectorStoreUnavailableError()),
  };
}
