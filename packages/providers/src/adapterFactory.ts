import { AnthropicAdapter } from './adapters/anthropic.ts';
import { OpenAiAdapter } from './adapters/openai.ts';
import { GoogleAdapter } from './adapters/google.ts';
import { OpenRouterAdapter } from './adapters/openrouter.ts';
import { OmniRouteAdapter } from './adapters/omniroute.ts';
import { OllamaAdapter } from './adapters/ollama.ts';
import { LmStudioAdapter } from './adapters/lmstudio.ts';
import { OpenAiCompatibleAdapter } from './adapters/openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './adapters/http.ts';
import type { ProviderAdapter } from './adapter.ts';
import type { ProviderKind } from './registry.ts';

// The one place a provider kind becomes a concrete adapter.
//
// This is a lookup table rather than a chain of `if (kind === ...)`, and it is
// exhaustive by type: adding a kind to PROVIDER_KINDS without adding a builder
// here fails to compile. A partial map with a runtime fallback would let a new
// provider silently resolve to the wrong adapter.
type Builder = (deps: AdapterDependencies) => ProviderAdapter;

const BUILDERS: Readonly<Record<ProviderKind, Builder>> = {
  anthropic: (deps) => new AnthropicAdapter(deps),
  openai: (deps) => new OpenAiAdapter(deps),
  google: (deps) => new GoogleAdapter(deps),
  openrouter: (deps) => new OpenRouterAdapter(deps),
  omniroute: (deps) => new OmniRouteAdapter(deps),
  ollama: (deps) => new OllamaAdapter(deps),
  lmstudio: (deps) => new LmStudioAdapter(deps),
  'openai-compatible': (deps) =>
    new OpenAiCompatibleAdapter(
      {
        kind: 'openai-compatible',
        provider: 'OpenAI-compatible endpoint',
        // Every such connection supplies its own baseUrl; this default exists
        // only so the type is satisfied and is never reached in practice,
        // because the registry rejects a connection of this kind without one.
        defaultBaseUrl: 'http://localhost:8000/v1',
        requiresCredential: false,
      },
      deps,
    ),
};

export function adapterFor(
  kind: ProviderKind,
  deps: AdapterDependencies = defaultDependencies,
): ProviderAdapter {
  return BUILDERS[kind](deps);
}
