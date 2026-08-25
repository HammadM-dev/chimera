import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { ProviderError } from '@chimera/errors';
import {
  connectionsRepository,
  deleteSecret,
  setSecret,
  settingsRepository,
  type AuthRef,
  type SearchProvider,
  type CachePolicySettings,
  type ModelTiers,
  type TelemetrySettings,
} from '@chimera/store';
import {
  HealthMonitor,
  adapterFor,
  capabilityMatrix,
  PROVIDER_KINDS,
  createConnectionRegistry,
  type ConnectionRegistry,
  type ModelCapabilities,
  type ProviderConnection,
  type ProviderKind,
} from '@chimera/providers';
import { getStore } from '../store/lifecycle.ts';
import { getChannel } from '../ipc/registry.ts';
import { EVENT_CHANNEL } from '../ipc/channelNames.ts';
import { Governor } from '@chimera/core';

// The main process's provider surface: what the IPC handlers call. Kept out of
// registry.ts so the channel definitions stay importable by the sandboxed
// preload (see the header comment there).

let registry: ConnectionRegistry | undefined;

function providerRegistry(): ConnectionRegistry {
  registry ??= createConnectionRegistry(getStore());
  return registry;
}

export function closeProviderRegistry(): void {
  registry?.close();
  registry = undefined;
  monitor = undefined;
}

export interface CreateConnectionRequest {
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  inlineKey?: string;
}

/**
 * Exchanges a raw key for a vault handle and stores the connection.
 *
 * The key is written to the OS keychain and the handle is what reaches SQLite —
 * the boundary CLAUDE.md draws ("secrets never leave the vault, not into
 * SQLite"). The raw value is not returned, not logged, and not kept: this
 * function is the only place in the main process that ever holds one, and it
 * holds it for the length of one call.
 */
export function createConnection(request: CreateConnectionRequest): {
  id: string;
  label: string;
  kind: string;
} {
  const db = getStore();

  // A local endpoint may legitimately have no key. Rather than inventing a
  // placeholder secret to satisfy the column, store a handle to an empty value
  // so the column stays a handle and never a raw string.
  const authRef: AuthRef = setSecret('connection', request.inlineKey ?? '');

  const created = connectionsRepository.create(db, {
    label: request.label,
    kind: request.kind,
    authRef,
    baseUrl: request.baseUrl ?? null,
  });

  registry?.refresh();
  return { id: created.id, label: created.label, kind: created.kind };
}

export interface ConnectionSummary {
  id: string;
  label: string;
  kind: string;
  baseUrl: string | null;
  healthState: string;
  /**
   * Model ids this connection can reach, from its imported catalogue.
   *
   * Empty when nothing has been imported — a hand-added connection, say. The
   * picker falls back to a text field in that case rather than offering an
   * empty list, but a connection that imported 211 models must show them: they
   * were stored and then invisible, which is indistinguishable from broken.
   */
  models: string[];
}

/**
 * Connections the renderer may see and select.
 *
 * Reads through the registry rather than the repository so local-only mode
 * (M1-9) filters here too — a picker that listed a forbidden connection would
 * let the user choose one the workspace has explicitly ruled out. `authRef` is
 * deliberately not included: the renderer has no use for a vault handle.
 */
/**
 * Removes a connection, and the credential that went with it.
 *
 * There was no way to remove one at all: a key typed wrongly, or a provider
 * somebody stopped using, stayed in the list for good. And `deleteSecret` was
 * called from nowhere in this app, so even when the row went the OS keychain
 * entry would have stayed behind — the same leak the test suite spent a day
 * teaching us about, waiting to happen in the product.
 */
export function removeConnection(id: string): { removed: boolean } {
  const db = getStore();
  const existing = connectionsRepository.get(db, id);
  if (!existing) return { removed: false };

  connectionsRepository.remove(db, id);
  try {
    deleteSecret(existing.authRef);
  } catch {
    // The row is gone either way. A keychain that will not answer is not a
    // reason to leave a connection the user asked to be rid of.
  }
  return { removed: true };
}

export function listConnections(): {
  connections: ConnectionSummary[];
  localOnlyMode: boolean;
  kinds: string[];
} {
  const registryInstance = providerRegistry();
  return {
    connections: registryInstance.list().map((connection) => ({
      id: connection.id,
      label: connection.label,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
      healthState: connection.healthState,
      models: modelsOf(connection),
    })),
    localOnlyMode: registryInstance.localOnlyMode(),
    kinds: [...PROVIDER_KINDS],
  };
}

/** Model ids out of a connection's cached capability blob. */
function modelsOf(connection: ProviderConnection): string[] {
  return Object.keys(connection.capabilities).sort();
}

/**
 * How many connections the workspace has, unfiltered by local-only mode.
 *
 * Read at window creation to decide whether this is a first launch. Counts
 * everything rather than what is currently visible: a workspace with cloud
 * connections hidden by local-only mode is configured, not empty, and showing
 * it a setup guide would be telling the user something untrue about their own
 * workspace.
 */
export function connectionCount(): number {
  return providerRegistry().listAll().length;
}

/** The connection a caller outside this module needs, resolved and checked. */
export function connectionFor(connectionId: string): ProviderConnection {
  return resolve(connectionId);
}

function resolve(connectionId: string): ProviderConnection {
  const connection = providerRegistry().get(connectionId);
  if (!connection) {
    // Covers both "no such row" and "hidden by local-only mode". The renderer
    // gets one honest message rather than a distinction it cannot act on.
    throw new ProviderError(
      'PROVIDER_CONNECTION_UNAVAILABLE',
      `No usable connection with id "${connectionId}". It may have been removed, or hidden by local-only mode.`,
      { connectionId },
    );
  }
  return connection;
}

export async function testConnection(
  connectionId: string,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  const connection = resolve(connectionId);
  const adapter = adapterFor(connection.kind);
  const result = await adapter.testConnection({
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  });
  return result.detail === undefined
    ? { ok: result.ok, latencyMs: result.latencyMs }
    : { ok: result.ok, latencyMs: result.latencyMs, detail: result.detail };
}

export interface ChatRequest {
  connectionId: string;
  model: string;
  prompt: string;
}

/**
 * Starts a streamed completion and returns immediately with a stream id.
 *
 * The stream is pumped in the background, pushing `chat:delta` events at the
 * renderer as they arrive. Errors are delivered as a terminal `error` delta
 * rather than being thrown: the invoke has already resolved by the time the
 * stream fails, so a throw here would become an unhandled rejection in the main
 * process and the renderer would simply wait forever.
 */
export function startChat(webContents: WebContents, request: ChatRequest): { streamId: string } {
  const connection = resolve(request.connectionId);
  const adapter = adapterFor(connection.kind);
  const streamId = randomUUID();

  // CLAUDE.md: "Every model call and every tool call goes through the Governor.
  // There is no bypass path." This one did not, and had not since it was
  // written — a raw prompt straight to `streamChat`, no authorisation, no
  // record. It is a diagnostic panel rather than an agent, so what it needs
  // from the Governor is the capability check and the refusal, not a budget: a
  // model that cannot take a plain prompt should be turned away here rather
  // than a hundred tokens later, and a run reading the trace should be able to
  // tell "checked and permitted" from "never checked".
  const governor = new Governor('permissive');
  const authorization = governor.authorizeModelCall({
    runId: streamId,
    nodeId: 'chat',
    roleId: 'chat',
    iteration: 0,
    depth: 0,
    purpose: 'act',
    connectionId: request.connectionId,
    model: request.model,
    // Four characters to a token, the same rough constant the agent loop uses.
    estimatedInputTokens: Math.ceil(request.prompt.length / 4),
    estimatedOutputTokens: 512,
    requiredCapabilities: [],
  });

  const options = {
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  };

  // The envelope is built here rather than through mainDispatch's sendEvent,
  // because that module imports ipcMain and would drag Electron into every
  // consumer of this file — including the unit tests.
  const deltaChannel = getChannel('chat:delta');
  const push = (payload: Record<string, unknown>): void => {
    // The window can close mid-stream; a destroyed webContents throws on send.
    if (webContents.isDestroyed() || !deltaChannel) return;
    webContents.send(EVENT_CHANNEL, {
      v: deltaChannel.v,
      channel: 'chat:delta',
      payload: { streamId, ...payload },
    });
  };

  void (async () => {
    if (authorization.decision === 'deny') {
      push({
        type: 'error',
        errorCode: authorization.code,
        errorMessage: authorization.message,
      });
      return;
    }

    try {
      for await (const event of adapter.streamChat(
        { model: request.model, messages: [{ role: 'user', content: request.prompt }] },
        options,
      )) {
        if (event.type === 'start') push({ type: 'start' });
        else if (event.type === 'textDelta') push({ type: 'text', text: event.text });
        else if (event.type === 'finish') {
          push({
            type: 'finish',
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            finishReason: event.finishReason,
          });
        }
      }
    } catch (err) {
      const isProviderError = err instanceof ProviderError;
      push({
        type: 'error',
        errorCode: isProviderError ? err.code : 'PROVIDER_UNKNOWN_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return { streamId };
}

/**
 * Cost for a completed exchange, in USD.
 *
 * Returns null rather than a number when the model has no verified price
 * (M1-3): showing "$0.00" for an unpriced model would read as free, which is
 * the one wrong answer with a financial consequence.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  // Through the same lookup the Governor uses, so the price shown before a run
  // and the price enforced during it are the same number. Reading the static
  // matrix directly here meant the preview said "cannot estimate" for a model
  // whose price the provider publishes.
  const pricing = capabilitiesLookup()(model).pricing;
  if (pricing.kind === 'local') return 0;
  if (pricing.kind !== 'metered') return null;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

let monitor: HealthMonitor | undefined;

/**
 * Probes every visible connection once and returns their refreshed states.
 *
 * The monitor is held across calls because the circuit breaker is stateful —
 * "three consecutive failures" is not a fact a fresh breaker can know. Probing
 * is sequential from the renderer's point of view (one sweep per request) but
 * concurrent inside `sweep()`, so one unreachable provider does not delay the
 * others.
 */
export async function sweepHealth(): Promise<{ connections: ConnectionSummary[] }> {
  const registryInstance = providerRegistry();
  monitor ??= new HealthMonitor(getStore());

  const connections = registryInstance.list();
  await monitor.sweep(
    connections.map((connection) => ({
      connectionId: connection.id,
      adapter: adapterFor(connection.kind),
      options: {
        authRef: connection.authRef,
        ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
      },
    })),
  );

  // The probe wrote health_state to SQLite; the registry caches rows, so it has
  // to be told to re-read or the status bar would show the state from before
  // the sweep it just asked for.
  registryInstance.refresh();
  return { connections: listConnections().connections };
}

/**
 * Reads a connection's model catalogue and caches it.
 *
 * Every provider, not just OmniRoute. Without this a connection added through
 * the form had no models at all, so the chat panel fell back to a text box and
 * the canvas had nothing to bind a step to — a connection that worked and
 * looked broken. Failure is not fatal: a provider whose catalogue endpoint is
 * unavailable is still usable by typing a model name.
 */
export async function importCatalogue(connectionId: string): Promise<{ models: number }> {
  const connection = resolve(connectionId);
  const adapter = adapterFor(connection.kind);

  const models = await adapter.listModels({
    authRef: connection.authRef,
    ...(connection.baseUrl === null ? {} : { baseUrl: connection.baseUrl }),
  });

  connectionsRepository.updateCapabilities(
    getStore(),
    connectionId,
    JSON.stringify({
      capabilities: Object.fromEntries(
        models.map((model) => [
          model.id,
          {
            displayName: model.displayName,
            // Whatever the provider said about the model, kept as it came.
            // Most providers say nothing and this is absent; OpenRouter
            // publishes price, context length and supported parameters for all
            // four hundred-odd models it routes to, and without keeping them
            // every one of those prices as `unknown` — which means no spend cap
            // can be enforced on any of them.
            ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
          },
        ]),
      ),
      limits: {},
    }),
  );
  providerRegistry().refresh();
  return { models: models.length };
}

/**
 * Model capabilities, with what providers publish taking precedence.
 *
 * The static matrix in `packages/providers` holds models somebody checked by
 * hand. It cannot hold OpenRouter's four hundred, it will never hold a model
 * released this morning, and everything it misses falls back to `unknown` —
 * including the price, which is the field with a consequence: the Governor
 * refuses to enforce a spend cap on a price nobody verified, so an unpriced
 * model is an unbudgeted one.
 *
 * A provider that publishes its own catalogue has better information than any
 * table shipped in a build, so where a connection cached capability data for a
 * model, it wins. Merged field by field rather than wholesale: a provider that
 * publishes price but says nothing about vision should not erase what the
 * matrix knows about vision.
 *
 * Built once and closed over rather than read per call — a model lookup happens
 * on every model call in a run, and this would otherwise be a database read
 * each time.
 *
 * Split in two so the merge can be tested without a database or an Electron
 * process behind it: this half is given the catalogues, `capabilitiesLookup`
 * below fetches them.
 */
export function buildCapabilitiesLookup(
  catalogues: readonly (string | null)[],
): (model: string) => ModelCapabilities {
  const published = new Map<string, Partial<ModelCapabilities>>();

  for (const catalogue of catalogues) {
    if (catalogue === null) continue;
    let parsed: { capabilities?: Record<string, { capabilities?: Partial<ModelCapabilities> }> };
    try {
      parsed = JSON.parse(catalogue) as typeof parsed;
    } catch {
      // A catalogue that will not read back is not a reason to fail a run. The
      // static matrix still answers, exactly as it did before any of this.
      continue;
    }

    for (const [modelId, entry] of Object.entries(parsed.capabilities ?? {})) {
      if (entry.capabilities !== undefined && !published.has(modelId)) {
        published.set(modelId, entry.capabilities);
      }
    }
  }

  return (model: string): ModelCapabilities => {
    const base = capabilityMatrix.get(model);
    const extra = published.get(model);
    if (extra === undefined) return base;

    // `undefined` means "the provider did not say", which must not overwrite
    // what the matrix knows. `null` on a numeric field is a real answer —
    // "no stated limit" — and does overwrite.
    const merged: ModelCapabilities = { ...base, modelId: model };
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        (merged as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return merged;
  };
}

/** The same, over this workspace's connections. */
export function capabilitiesLookup(): (model: string) => ModelCapabilities {
  return buildCapabilitiesLookup(
    connectionsRepository.list(getStore()).map((connection) => connection.capabilitiesJson),
  );
}

export interface CatalogueEntry {
  id: string;
  displayName: string;
  /** The vendor half of `vendor/model`, or the connection's kind. */
  vendor: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  /** Null when this model has no verified price and so cannot be budgeted. */
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  toolCalling: string;
  vision: string;
}

/**
 * One connection's models, with everything known about each.
 *
 * The connection row said "419 models" and offered no way to look at them, so
 * the catalogue this app works hard to import was a number on a label. What a
 * person actually wants to know before binding a step is what a model costs and
 * whether it can call tools, and both are now answerable.
 */
export function catalogueOf(connectionId: string): { models: CatalogueEntry[] } {
  const connection = resolve(connectionId);
  const lookup = capabilitiesLookup();

  const models = Object.entries(connection.capabilities).map(([id, value]): CatalogueEntry => {
    const stored = (value ?? {}) as { displayName?: string };
    const known = lookup(id);
    const priced = known.pricing.kind === 'metered' ? known.pricing : null;
    const slash = id.indexOf('/');

    return {
      id,
      displayName: stored.displayName ?? id,
      // `anthropic/claude-opus-5` groups under Anthropic. A bare id has no
      // vendor half and groups under the provider it came from, which for a
      // single-vendor connection is the only sensible heading anyway.
      vendor: slash > 0 ? id.slice(0, slash) : connection.kind,
      contextWindowTokens: known.contextWindowTokens,
      maxOutputTokens: known.maxOutputTokens,
      inputPerMillion: priced?.inputPerMillion ?? null,
      outputPerMillion: priced?.outputPerMillion ?? null,
      toolCalling: known.toolCalling,
      vision: known.vision,
    };
  });

  models.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.id.localeCompare(b.id));
  return { models };
}

export function setLocalOnlyMode(enabled: boolean): void {
  settingsRepository.setLocalOnlyMode(getStore(), enabled);
}

/**
 * Which connection and model this workspace calls cheap, standard and frontier.
 *
 * Read and written here rather than in a settings service of its own, because
 * every value in it is a provider connection and a model id — the two things
 * this module already owns.
 */
export function getTiers(): { tiers: ModelTiers } {
  return { tiers: settingsRepository.read(getStore()).modelTiers };
}

export function setTiers(tiers: ModelTiers): { tiers: ModelTiers } {
  settingsRepository.setModelTiers(getStore(), tiers);
  return getTiers();
}

export function getCachePolicy(): { policy: CachePolicySettings } {
  return { policy: settingsRepository.read(getStore()).cache };
}

export function setCachePolicy(policy: CachePolicySettings): { policy: CachePolicySettings } {
  settingsRepository.setCachePolicy(getStore(), policy);
  return getCachePolicy();
}

/**
 * The search service this workspace uses, and whether it has a key.
 *
 * Returns `hasKey`, never the key. A settings panel needs to show whether one
 * is set; it has no business being able to read it back (CLAUDE.md: "Secrets
 * never leave the vault").
 */
export function getSearch(): { provider: SearchProvider; region: string; hasKey: boolean } {
  const search = settingsRepository.read(getStore()).search;
  return { provider: search.provider, region: search.region, hasKey: search.authRef !== '' };
}

export function setSearch(input: {
  provider: SearchProvider;
  region: string;
  /** The key, when the user has just typed one. Absent leaves the stored one alone. */
  apiKey?: string;
}): { provider: SearchProvider; region: string; hasKey: boolean } {
  const db = getStore();
  const existing = settingsRepository.read(db).search;

  let authRef = existing.authRef;
  if (input.provider === 'none') {
    // Switching back to the built-in search drops the key rather than leaving
    // it in the keychain for a service nothing will call again.
    if (authRef !== '') {
      try {
        deleteSecret(authRef as AuthRef);
      } catch {
        // Already gone, or a keychain that will not talk to us. Either way the
        // handle is being dropped from the settings on the next line.
      }
    }
    authRef = '';
  } else if (input.apiKey !== undefined && input.apiKey !== '') {
    // Replacing a key means removing the old one, not stacking a second entry
    // beside it — that is how a keychain fills up with dead handles.
    if (authRef !== '') {
      try {
        deleteSecret(authRef as AuthRef);
      } catch {
        // See above.
      }
    }
    authRef = setSecret('search', input.apiKey);
  }

  settingsRepository.setSearch(db, { provider: input.provider, region: input.region, authRef });
  return getSearch();
}

export function getTelemetry(): { telemetry: TelemetrySettings } {
  return { telemetry: settingsRepository.read(getStore()).telemetry };
}

export function setTelemetry(telemetry: TelemetrySettings): { telemetry: TelemetrySettings } {
  settingsRepository.setTelemetry(getStore(), telemetry);
  return getTelemetry();
}
