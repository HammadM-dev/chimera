import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { ProviderError } from '@chimera/errors';
import {
  connectionsRepository,
  deleteSecret,
  setSecret,
  settingsRepository,
  type AuthRef,
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
  type ProviderConnection,
  type ProviderKind,
} from '@chimera/providers';
import { getStore } from '../store/lifecycle.ts';
import { getChannel } from '../ipc/registry.ts';
import { EVENT_CHANNEL } from '../ipc/channelNames.ts';

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
  const pricing = capabilityMatrix.get(model).pricing;
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
        models.map((model) => [model.id, { displayName: model.displayName }]),
      ),
      limits: {},
    }),
  );
  providerRegistry().refresh();
  return { models: models.length };
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

export function getTelemetry(): { telemetry: TelemetrySettings } {
  return { telemetry: settingsRepository.read(getStore()).telemetry };
}

export function setTelemetry(telemetry: TelemetrySettings): { telemetry: TelemetrySettings } {
  settingsRepository.setTelemetry(getStore(), telemetry);
  return getTelemetry();
}
