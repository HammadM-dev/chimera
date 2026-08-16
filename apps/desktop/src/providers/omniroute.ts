import { connectionsRepository, setSecret, type AuthRef } from '@chimera/store';
import {
  OmniRouteAdapter,
  OMNIROUTE_DEFAULT_BASE_URL,
  defaultTransport,
  type ModelDescriptor,
} from '@chimera/providers';
import { getStore } from '../store/lifecycle.ts';

// F1.5's detect → guide → verify → import flow. CHIMERA supplies a config
// option, never a token: the user installs and authenticates OmniRoute under
// their own accounts, so nothing here offers to do that for them.

export type OmniRouteState = 'detected' | 'not-detected';

// Never dereferenced: the probe adapter's resolveSecret answers from its own
// argument. It exists only because AdapterCallOptions requires the field.
const PROBE_AUTH_REF = 'vault:connection:00000000-0000-0000-0000-000000000000' as AuthRef;

/**
 * Where to look for OmniRoute.
 *
 * The port is fixed at 20128 in production. The override exists so the E2E
 * suite can stand a stub on an ephemeral port: binding 20128 in a test would
 * fight the developer's own OmniRoute install for the port, and skipping the
 * test when that happens would mean the flow is least tested on the machines
 * that actually have OmniRoute.
 */
export function defaultBaseUrl(): string {
  const override = process.env.CHIMERA_OMNIROUTE_BASE_URL;
  return override !== undefined && override !== '' ? override : OMNIROUTE_DEFAULT_BASE_URL;
}

export interface DetectionResult {
  state: OmniRouteState;
  baseUrl: string;
  models: ModelDescriptor[];
}

/**
 * Probes the local OmniRoute instance.
 *
 * "Not detected" is a normal, expected answer — most users will not have it
 * installed — so this never throws. A thrown error would surface in the UI as a
 * failure toast, which is exactly the outcome acceptance criterion 2 forbids:
 * the correct response to "no OmniRoute here" is install guidance, not an
 * error.
 */
export async function detect(
  baseUrl = defaultBaseUrl(),
  apiKey?: string,
): Promise<DetectionResult> {
  // Detection runs before any connection exists, so there is no vault handle to
  // read. The key — set by the user in OmniRoute's Endpoints section, and
  // absent for the common unauthenticated case — is resolved straight from the
  // argument. Passing a fabricated handle instead would raise VaultError, and
  // that error, caught below, would report a running OmniRoute as absent.
  const adapter = new OmniRouteAdapter({
    transport: defaultTransport,
    resolveSecret: () => (apiKey === undefined || apiKey === '' ? undefined : apiKey),
  });
  try {
    const models = await adapter.listModels({
      authRef: PROBE_AUTH_REF,
      baseUrl,
    });
    // listModels() swallows a missing catalogue and returns [], so an empty
    // list means "nothing usable answered here" rather than "installed but
    // empty" — treating it as detected would import a connection with no models.
    return models.length > 0
      ? { state: 'detected', baseUrl, models }
      : { state: 'not-detected', baseUrl, models: [] };
  } catch {
    return { state: 'not-detected', baseUrl, models: [] };
  }
}

export interface ImportResult {
  connectionId: string;
  modelCount: number;
  created: boolean;
}

/**
 * Creates (or reuses) the OmniRoute connection and caches its catalogue.
 *
 * Idempotent by design: re-running detection is the documented recovery path
 * when a user installs OmniRoute mid-flow, and a second run must not leave two
 * identical connections behind.
 */
export async function importCatalogue(
  baseUrl = defaultBaseUrl(),
  apiKey?: string,
): Promise<ImportResult> {
  const db = getStore();
  const detection = await detect(baseUrl, apiKey);
  if (detection.state === 'not-detected') {
    return { connectionId: '', modelCount: 0, created: false };
  }

  const capabilitiesJson = JSON.stringify({
    capabilities: Object.fromEntries(
      detection.models.map((model) => [model.id, { displayName: model.displayName }]),
    ),
    limits: {},
  });

  const existing = connectionsRepository.list(db).find((row) => row.kind === 'omniroute');
  if (existing) {
    connectionsRepository.updateCapabilities(db, existing.id, capabilitiesJson);
    return { connectionId: existing.id, modelCount: detection.models.length, created: false };
  }

  // The user's key when they set one, an empty secret when they did not: the
  // column holds a vault handle by contract, and a gateway with no key still
  // needs a well-formed one.
  const created = connectionsRepository.create(db, {
    label: 'OmniRoute',
    kind: 'omniroute',
    baseUrl,
    authRef: setSecret('connection', apiKey ?? ''),
    capabilitiesJson,
    healthState: 'healthy',
  });

  return { connectionId: created.id, modelCount: detection.models.length, created: true };
}
