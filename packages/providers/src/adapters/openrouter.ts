import { OpenAiCompatibleAdapter } from './openaiCompatible.ts';
import { defaultDependencies, getJson, type AdapterDependencies } from './http.ts';
import type { AdapterCallOptions } from '../adapter.ts';
import type { ModelDescriptor } from '../normalised.ts';
import type { Pricing, Support } from '../capabilityMatrix.ts';

/**
 * OpenRouter — an OpenAI-compatible router in front of many providers.
 *
 * Its model ids are `vendor/model` (`anthropic/claude-opus-5`), which is
 * exactly the form `capabilityMatrix.get()` already resolves by retrying on the
 * final path segment, so no special handling is needed for lookups.
 *
 * What is special is its catalogue. OpenRouter publishes price, context length
 * and supported parameters for every model it routes to — four hundred and
 * nineteen of them the day this was written, almost none of which are in the
 * static matrix. Without that data every one of them prices as `unknown`, and a
 * model that cannot be priced cannot be held to a spend cap: the Governor
 * refuses to enforce a budget on a number nobody verified, which is right, and
 * leaves the user with no budget at all, which is not much use. So this adapter
 * reads what OpenRouter publishes rather than guessing or going without.
 */

/** OpenRouter's `/models` entry. Verified against the live API, 2026-08-25. */
interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
}

/**
 * Turns a per-token price string into dollars per million.
 *
 * OpenRouter quotes per token as a decimal string — `"0.0000001"` is ten cents
 * a million. Free models quote `"0"`, which is a real price and not a missing
 * one, so it must survive as `metered` at zero rather than becoming `unknown`.
 * Anything unparseable is `unknown`: a wrong number here becomes a wrong
 * budget, and no budget is easier to notice than a silently wrong one.
 */
function perMillion(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;

  // Rounded to six decimals, because `0.0000001 * 1_000_000` is
  // 0.09999999999999999 in binary floating point and this number is money. Six
  // decimals of a dollar per million tokens is a hundredth of a cent per
  // billion — far below anything a budget can act on, and far above the noise.
  return Math.round(parsed * 1_000_000 * 1_000_000) / 1_000_000;
}

function pricingOf(model: OpenRouterModel, verifiedAt: string): Pricing {
  const input = perMillion(model.pricing?.prompt);
  const output = perMillion(model.pricing?.completion);
  if (input === null || output === null) return { kind: 'unknown' };
  return {
    kind: 'metered',
    inputPerMillion: input,
    outputPerMillion: output,
    currency: 'USD',
    verifiedAt,
  };
}

/**
 * `supported_parameters` is a list of what the model accepts, so a name being
 * present is a positive statement and its absence is a negative one — this is
 * a catalogue that enumerates, not one that omits what it does not know.
 */
function supportOf(parameters: string[] | undefined, ...names: string[]): Support {
  if (parameters === undefined) return 'unknown';
  return names.some((name) => parameters.includes(name)) ? 'supported' : 'unsupported';
}

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

  /**
   * The catalogue, with everything OpenRouter says about each model.
   *
   * Falls back to the base implementation's plain id-and-name list if the
   * richer shape is not there — a gateway impersonating OpenRouter, or a
   * response shape that changes under us, should degrade to what every
   * OpenAI-compatible endpoint provides rather than fail the import outright.
   */
  override async listModels(options: AdapterCallOptions): Promise<ModelDescriptor[]> {
    let payload: { data?: OpenRouterModel[] };
    try {
      payload = await getJson<{ data?: OpenRouterModel[] }>({
        transport: this.deps.transport,
        provider: this.provider,
        url: `${options.baseUrl ?? this.defaultBaseUrl}/models`,
        headers: this.headers(options),
        secrets: this.secrets(options),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return [];
    }

    const models = payload.data ?? [];
    if (models.length === 0) return [];

    // The date the price was read, which is what `verifiedAt` means: not when
    // this file was written, but when the number came off the provider.
    const verifiedAt = new Date().toISOString().slice(0, 10);

    return models.map((model): ModelDescriptor => {
      const parameters = model.supported_parameters;
      const modalities = model.architecture?.input_modalities;

      return {
        id: model.id,
        displayName: model.name ?? model.id,
        capabilities: {
          contextWindowTokens: model.context_length ?? null,
          maxOutputTokens: model.top_provider?.max_completion_tokens ?? null,
          toolCalling: supportOf(parameters, 'tools', 'tool_choice'),
          structuredOutput: supportOf(parameters, 'structured_outputs', 'response_format'),
          // Every model OpenRouter routes to is reachable over its streaming
          // endpoint; `supported_parameters` says nothing either way, and
          // guessing 'unsupported' from silence would turn streaming off for
          // the entire catalogue.
          streaming: 'unknown',
          vision:
            modalities === undefined
              ? 'unknown'
              : modalities.includes('image')
                ? 'supported'
                : 'unsupported',
          pricing: pricingOf(model, verifiedAt),
        },
      };
    });
  }
}
