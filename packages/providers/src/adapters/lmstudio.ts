import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';

/** LM Studio's local server. Takes no credential. */
export class LmStudioAdapter extends OpenAiCompatibleAdapter {
  constructor(deps: AdapterDependencies = defaultDependencies) {
    super(
      {
        kind: 'lmstudio',
        provider: 'LM Studio',
        defaultBaseUrl: 'http://localhost:1234/v1',
        requiresCredential: false,
      },
      deps,
    );
  }

  protected override get probeModel(): string {
    return 'local-model';
  }
}
