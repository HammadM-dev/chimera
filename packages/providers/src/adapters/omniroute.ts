import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, getJson, type AdapterDependencies } from './http.ts';
import type { AdapterCallOptions } from '../adapter.ts';
import type { HealthState } from '../registry.ts';
import type { SelfReportingAdapter } from '../health.ts';

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

export class OmniRouteAdapter extends OpenAiCompatibleAdapter implements SelfReportingAdapter {
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

  /**
   * OmniRoute manages provider health itself, so CHIMERA reads its answer
   * rather than computing a second, competing one (F1.6: "defer to it rather
   * than double-managing").
   *
   * The health path is not pinned down by the master plan beyond "surfaces its
   * health endpoint", so this tries `/health` on the origin and falls back to
   * the model catalogue when that 404s. Reachability of `/v1/models` is a
   * weaker but honest signal — it proves the gateway is answering — and the
   * fallback means a differently-named health route degrades to a working
   * check rather than to a permanently unknown connection.
   */
  async reportedHealth(options: AdapterCallOptions): Promise<HealthState> {
    const base = options.baseUrl ?? this.defaultBaseUrl;
    const origin = base.replace(/\/v1\/?$/, '');

    try {
      const payload = await getJson<{ status?: string; healthy?: boolean }>({
        transport: this.deps.transport,
        provider: this.provider,
        url: `${origin}/health`,
        headers: this.headers(options),
        secrets: this.secrets(options),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (payload.healthy === false) return 'unavailable';
      if (typeof payload.status === 'string' && payload.status.toLowerCase() !== 'ok') {
        return 'degraded';
      }
      return 'healthy';
    } catch {
      const models = await this.listModels(options);
      return models.length > 0 ? 'healthy' : 'unavailable';
    }
  }
}
