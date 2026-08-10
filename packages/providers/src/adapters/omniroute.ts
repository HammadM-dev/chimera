import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, type AdapterDependencies } from './http.ts';

/**
 * OmniRoute — a gateway the user installs and authenticates themselves
 * (master plan F1.5: "CHIMERA ships a config option, not a token supply").
 *
 * Runs locally on port 20128 by default, and `listModels()` maps straight onto
 * its `/v1/models` catalogue, which is the base class's behaviour unchanged —
 * F1.5's import step needs nothing provider-specific.
 *
 * `requiresCredential` is false because a local instance may be unauthenticated;
 * demanding a key would make that configuration impossible to express.
 */
export const OMNIROUTE_DEFAULT_BASE_URL = 'http://localhost:20128/v1';

export class OmniRouteAdapter extends OpenAiCompatibleAdapter {
  constructor(deps: AdapterDependencies = defaultDependencies) {
    super(
      {
        kind: 'omniroute',
        provider: 'OmniRoute',
        defaultBaseUrl: OMNIROUTE_DEFAULT_BASE_URL,
        requiresCredential: false,
      },
      deps,
    );
  }
}
