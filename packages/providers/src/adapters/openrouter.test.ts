import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterAdapter } from './openrouter.ts';

// OpenRouter's catalogue, and the reason this adapter has one of its own.
//
// Four hundred models, almost none of them in the static matrix. Read as a
// plain `/v1/models` list they all price as `unknown`, and a model that cannot
// be priced cannot be held to a spend cap — the Governor refuses to enforce a
// budget on a number nobody verified. So the catalogue is the budget.
//
// The fixture below is one real entry from the live API, copied on 2026-08-25,
// trimmed only of fields nothing reads.

const ENTRY = {
  id: 'meta/muse-spark-1.2-contributor',
  name: 'Meta: Muse Spark 1.2 Contributor',
  context_length: 1_048_576,
  architecture: { input_modalities: ['text', 'image', 'video', 'file', 'audio'] },
  pricing: { prompt: '0.0000001', completion: '0.0000002' },
  top_provider: { max_completion_tokens: null },
  supported_parameters: [
    'max_tokens',
    'response_format',
    'structured_outputs',
    'tool_choice',
    'tools',
  ],
};

function adapterFor(payload: unknown): OpenRouterAdapter {
  return new OpenRouterAdapter({
    transport: {
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify(payload), { status: 200 }),
        )) as unknown as typeof globalThis.fetch,
    },
    resolveSecret: () => 'sk-test',
  });
}

const OPTIONS = { authRef: 'vault:connection:0'.padEnd(48, '0') as never };

test('a per-token price becomes dollars per million, so a cap can be enforced', async () => {
  const models = await adapterFor({ data: [ENTRY] }).listModels(OPTIONS);
  const pricing = models[0]?.capabilities?.pricing;

  assert.equal(pricing?.kind, 'metered');
  // 0.0000001/token is ten cents a million, not a tenth of a millionth of one.
  assert.equal(pricing?.kind === 'metered' ? pricing.inputPerMillion : null, 0.1);
  assert.equal(pricing?.kind === 'metered' ? pricing.outputPerMillion : null, 0.2);
});

test('a free model is priced at zero, not left unpriced', async () => {
  // "0" is a real price. Reading it as missing would put every free model on
  // OpenRouter beyond the reach of a spend cap for no reason.
  const free = { ...ENTRY, pricing: { prompt: '0', completion: '0' } };
  const models = await adapterFor({ data: [free] }).listModels(OPTIONS);
  const pricing = models[0]?.capabilities?.pricing;

  assert.equal(pricing?.kind, 'metered');
  assert.equal(pricing?.kind === 'metered' ? pricing.inputPerMillion : null, 0);
});

test('a price that will not parse is unknown rather than a guess', async () => {
  const broken = { ...ENTRY, pricing: { prompt: 'ask us', completion: '0.1' } };
  const models = await adapterFor({ data: [broken] }).listModels(OPTIONS);

  assert.equal(models[0]?.capabilities?.pricing?.kind, 'unknown');
});

test('supported parameters decide tool calling, and their absence is not a no', async () => {
  const listed = await adapterFor({ data: [ENTRY] }).listModels(OPTIONS);
  assert.equal(listed[0]?.capabilities?.toolCalling, 'supported');
  assert.equal(listed[0]?.capabilities?.structuredOutput, 'supported');

  const without = { ...ENTRY, supported_parameters: ['max_tokens'] };
  const plain = await adapterFor({ data: [without] }).listModels(OPTIONS);
  assert.equal(plain[0]?.capabilities?.toolCalling, 'unsupported');

  // Silence is not a denial. A catalogue that lists nothing has told us nothing.
  const silent: Record<string, unknown> = { ...ENTRY };
  delete silent['supported_parameters'];
  const quiet = await adapterFor({ data: [silent] }).listModels(OPTIONS);
  assert.equal(quiet[0]?.capabilities?.toolCalling, 'unknown');
});

test('image input means vision, and no modality list means we do not know', async () => {
  const seeing = await adapterFor({ data: [ENTRY] }).listModels(OPTIONS);
  assert.equal(seeing[0]?.capabilities?.vision, 'supported');

  const textOnly = { ...ENTRY, architecture: { input_modalities: ['text'] } };
  const blind = await adapterFor({ data: [textOnly] }).listModels(OPTIONS);
  assert.equal(blind[0]?.capabilities?.vision, 'unsupported');

  const noArch: Record<string, unknown> = { ...ENTRY };
  delete noArch['architecture'];
  const quiet = await adapterFor({ data: [noArch] }).listModels(OPTIONS);
  assert.equal(quiet[0]?.capabilities?.vision, 'unknown');
});

test('a response without the richer shape still yields a usable list', async () => {
  // Something impersonating OpenRouter, or a shape that changes under us. The
  // import should degrade to names rather than fail.
  const plain = await adapterFor({ data: [{ id: 'openai/gpt-5-mini' }] }).listModels(OPTIONS);

  assert.equal(plain[0]?.id, 'openai/gpt-5-mini');
  assert.equal(plain[0]?.displayName, 'openai/gpt-5-mini');
  assert.equal(plain[0]?.capabilities?.pricing?.kind, 'unknown');
});
