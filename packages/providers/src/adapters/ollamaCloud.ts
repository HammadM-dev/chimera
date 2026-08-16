import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';

/**
 * Ollama Cloud — Ollama's hosted models, not the daemon on your machine.
 *
 * A separate kind from `ollama` rather than the same one with a different base
 * URL, for two reasons that both matter. It takes a real credential, where the
 * local daemon takes none; and M1-9's local-only mode must be able to tell them
 * apart, because "local-only" means nothing if a connection labelled Ollama can
 * be pointed at somebody else's server.
 *
 * Its OpenAI-compatible layer is at `https://ollama.com/v1` — not `/api/v1`.
 */
export class OllamaCloudAdapter extends OpenAiCompatibleAdapter {
  constructor(deps: AdapterDependencies = defaultDependencies) {
    super(
      {
        kind: 'ollama-cloud',
        provider: 'Ollama Cloud',
        defaultBaseUrl: 'https://ollama.com/v1',
        requiresCredential: true,
      },
      deps,
    );
  }
}
