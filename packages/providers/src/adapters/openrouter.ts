import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';

/**
 * OpenRouter — an OpenAI-compatible router in front of many providers.
 *
 * Its model ids are `vendor/model` (`anthropic/claude-opus-5`), which is
 * exactly the form `capabilityMatrix.get()` already resolves by retrying on the
 * final path segment, so no special handling is needed here.
 */
export class OpenRouterAdapter extends OpenAiCompatibleAdapter {
  constructor(deps: AdapterDependencies = defaultDependencies) {
    super(
      {
        kind: 'openrouter',
        provider: 'OpenRouter',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
      },
      deps,
    );
  }

  protected override get probeModel(): string {
    return 'openai/gpt-5-mini';
  }
}
