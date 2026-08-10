import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';

/** OpenAI proper. The translation lives in the base class. */
export class OpenAiAdapter extends OpenAiCompatibleAdapter {
  constructor(deps: AdapterDependencies = defaultDependencies) {
    super(
      { kind: 'openai', provider: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
      deps,
    );
  }
}
