import type { ModelCapabilities } from './capabilityMatrix.ts';
// The single internal request/response shape every adapter normalises to and
// from. OpenAI-compatible in structure because that is the shape most providers
// and most tooling already speak, so the majority of adapters are a thin
// translation rather than a rewrite.
//
// CLAUDE.md hard rule 7: "Provider differences live in adapters only.
// Everything above chimera-providers sees one normalised interface. Model
// differences are expressed as capability data, never as branching logic in the
// engine." These types are the concrete form of that rule — if a field here
// only makes sense for one provider, it does not belong here, it belongs in
// that adapter or in the capability matrix (M1-3).

/**
 * A JSON Schema fragment, as carried by tool parameter definitions and
 * structured-output contracts.
 *
 * Deliberately structural and permissive rather than a full JSON Schema type:
 * the value is handed to a provider verbatim, and modelling every keyword would
 * be a large surface with no payoff, since it is the provider that validates
 * it. Typed as an object rather than `unknown` so callers cannot pass a bare
 * string by accident, and never as `any`.
 */
export type JsonSchema = Record<string, unknown>;

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  /** IANA media type, e.g. "image/png". */
  mediaType: string;
  /** Base64-encoded bytes. Never a URL — see the note on egress in docs/SECURITY.md. */
  data: string;
}

export type ContentPart = TextContent | ImageContent;

export interface ToolCall {
  /** Provider-assigned id, echoed back on the matching tool result message. */
  id: string;
  name: string;
  /** Already parsed. Adapters own the provider's argument encoding, not callers. */
  arguments: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  /**
   * A plain string is shorthand for a single text part. Adapters must accept
   * both forms; callers should not have to build a parts array to send a
   * sentence.
   */
  content: string | ContentPart[];
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on `role: 'tool'` messages, matching the ToolCall.id it answers. */
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export type ResponseFormat =
  { type: 'text' } | { type: 'json_schema'; name: string; schema: JsonSchema };

export interface NormalisedRequest {
  model: string;
  messages: Message[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
}

export type FinishReason = 'stop' | 'length' | 'toolCalls' | 'contentFilter';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache hits, where the provider reports them. Governor cost arithmetic (M3) uses this. */
  cachedInputTokens?: number;
  /** Billed-but-invisible reasoning tokens, where the provider reports them. */
  reasoningTokens?: number;
}

export interface NormalisedResponse {
  /** Provider-assigned response id, kept for the audit trace. */
  id: string;
  /** The model that actually served the request, which routers may change. */
  model: string;
  content: ContentPart[];
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: Usage;
}

/**
 * There is deliberately no `raw` field carrying the provider's original
 * payload.
 *
 * It would be convenient for debugging and it is exactly how hard rule 7 erodes:
 * once the raw response is reachable above this package, the first `if
 * (raw.anthropic_specific_field)` in the engine is a small, reasonable-looking
 * commit. An adapter that wants to record a provider payload for the audit
 * trace emits it as a trace event from inside the adapter, where provider
 * specifics are allowed to exist.
 */

export type StreamEvent =
  | { type: 'start'; id: string; model: string }
  | { type: 'textDelta'; text: string }
  | {
      type: 'toolCallDelta';
      /** Position in the response's tool-call list; deltas for one call share an index. */
      index: number;
      id?: string;
      name?: string;
      /** Partial JSON. Callers accumulate; adapters do not parse mid-stream. */
      argumentsDelta?: string;
    }
  | { type: 'finish'; finishReason: FinishReason; usage: Usage };

export interface ModelDescriptor {
  id: string;
  /** Human-facing name where the provider gives one; otherwise the id. */
  displayName: string;
  /**
   * What the provider says this model can do and what it charges.
   *
   * Absent for most providers: `/v1/models` in its ordinary form is a list of
   * names and nothing else. A few publish the rest — OpenRouter carries price,
   * context length and supported parameters for every model it routes to — and
   * where they do, taking their word for it beats a static table that cannot
   * know about a model released this morning.
   *
   * Partial on purpose. A provider that publishes price but says nothing about
   * vision should leave vision alone rather than assert `'unsupported'`, so
   * whatever is known statically still stands.
   */
  capabilities?: Partial<Omit<ModelCapabilities, 'modelId' | 'displayName'>>;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** Populated when `ok` is false. Never contains the credential. */
  detail?: string;
}

/** Narrows the shorthand string form of `Message.content` to parts. */
export function toContentParts(content: string | ContentPart[]): ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/** Concatenates every text part, ignoring images. The common "just give me the answer" read. */
export function textOf(response: NormalisedResponse): string {
  return withoutReasoning(
    response.content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text)
      .join(''),
  );
}

/**
 * Removes a model's private reasoning from its answer.
 *
 * Several open-weight families — DeepSeek, Qwen, gpt-oss — emit their working
 * inside `<think>` tags in the ordinary content field rather than in a separate
 * channel. Left in, it is what the user reads: a run finished and showed them
 * "Perhaps the correct approach is... Not possible... Let's try a different
 * approach... </think>" followed, eventually, by the answer.
 *
 * Both shapes are handled. A properly closed block goes whole; a reply that
 * begins mid-thought and only closes — which is what arrives when a provider
 * has already trimmed the opening tag — loses everything up to the close.
 * Nothing is removed from a reply with no closing tag at all, since that is
 * either an ordinary answer or a truncated one, and cutting an ordinary answer
 * because it mentions the word would be worse than leaving a stray tag.
 */
export function withoutReasoning(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  const close = cleaned.toLowerCase().lastIndexOf('</think>');
  if (close !== -1) cleaned = cleaned.slice(close + '</think>'.length);

  return cleaned.trim();
}
