import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';

/** Ollama, on the user's own machine. Takes no credential. */
export class OllamaAdapter extends OpenAiCompatibleAdapter {
  constructor(deps: AdapterDependencies = defaultDependencies) {
    super(
      {
        kind: 'ollama',
        provider: 'Ollama',
        defaultBaseUrl: 'http://localhost:11434/v1',
        requiresCredential: false,
      },
      deps,
    );
  }

  protected override get probeModel(): string {
    return 'llama3.2';
  }
}
