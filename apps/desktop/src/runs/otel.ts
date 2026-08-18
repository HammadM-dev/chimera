import { createHash } from 'node:crypto';
import {
  runsRepository,
  settingsRepository,
  tracesRepository,
  type TelemetrySettings,
} from '@chimera/store';
import { getStore } from '../store/lifecycle.ts';

// M9-5. A run, in the shape the rest of the observability world reads.
//
// OTLP over HTTP with a JSON body, written out by hand rather than pulled in
// with the OpenTelemetry SDK. CLAUDE.md requires asking before adding a
// dependency, and what this needs is one POST of a documented JSON envelope —
// against several megabytes of SDK whose exporters, context propagation and
// instrumentation this app has no use for. The same reasoning as the cron
// parser and the JSON-schema validator.

// Whether prompts and answers travel with the timings is the important
// default in this file, and it is off. A run's trace holds what the user asked
// and what the model said — their business, their customers' names, the
// contents of their files. Sending timings and token counts to a collector is
// observability; sending the text is exporting the business.
export function telemetrySettings(): TelemetrySettings {
  return settingsRepository.read(getStore()).telemetry;
}

/** A UUID is thirty-two hex characters, which is exactly an OTLP trace id. */
function traceIdOf(runId: string): string {
  const stripped = runId.replace(/-/g, '');
  return stripped.length === 32
    ? stripped
    : createHash('sha256').update(runId).digest('hex').slice(0, 32);
}

function spanIdOf(runId: string, nodeId: string): string {
  return createHash('sha256').update(`${runId}:${nodeId}`).digest('hex').slice(0, 16);
}

const nanos = (iso: string): string => `${String(new Date(iso).getTime())}000000`;

interface Attribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

const text = (key: string, value: string): Attribute => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): Attribute => ({
  key,
  value: { intValue: String(Math.round(value)) },
});
const real = (key: string, value: number): Attribute => ({ key, value: { doubleValue: value } });

/**
 * One run as OTLP spans: the run, and a span per node inside it.
 *
 * Per node rather than per trace event: a fan-out over a thousand items writes
 * tens of thousands of events, and a collector handed one span each would be
 * being used as a log store. The events become span events on their node,
 * which is what they are.
 */
export function spansFor(runId: string, includePayloads: boolean): unknown[] {
  const db = getStore();
  const run = runsRepository.get(db, runId);
  if (!run) return [];

  const traceId = traceIdOf(runId);
  const rootId = spanIdOf(runId, '__run__');
  const events = tracesRepository.listForRun(db, runId);

  let name = 'run';
  try {
    name = (JSON.parse(run.inputJson) as { name?: string }).name ?? 'run';
  } catch {
    name = 'run';
  }

  const spans: unknown[] = [
    {
      traceId,
      spanId: rootId,
      name,
      kind: 1,
      startTimeUnixNano: nanos(run.startedAt),
      endTimeUnixNano: nanos(run.endedAt ?? new Date().toISOString()),
      attributes: [
        text('chimera.run.id', run.id),
        text('chimera.run.status', run.status),
        text('chimera.run.trigger', run.triggerType),
        text('chimera.workflow.id', run.workflowId),
      ],
      status: { code: run.status === 'succeeded' ? 1 : 2 },
    },
  ];

  const byNode = new Map<string, typeof events>();
  for (const event of events) {
    byNode.set(event.nodeId, [...(byNode.get(event.nodeId) ?? []), event]);
  }

  for (const [nodeId, nodeEvents] of byNode) {
    const first = nodeEvents[0];
    const last = nodeEvents[nodeEvents.length - 1];
    if (!first || !last) continue;

    const tokens = nodeEvents.reduce(
      (total, event) => total + (event.tokensIn ?? 0) + (event.tokensOut ?? 0),
      0,
    );
    const cost = nodeEvents.reduce((total, event) => total + (event.costUsd ?? 0), 0);

    spans.push({
      traceId,
      spanId: spanIdOf(runId, nodeId),
      parentSpanId: rootId,
      name: nodeId,
      kind: 1,
      startTimeUnixNano: nanos(first.ts),
      endTimeUnixNano: nanos(last.ts),
      attributes: [
        text('chimera.node.id', nodeId),
        int('chimera.node.tokens', tokens),
        real('chimera.node.cost_usd', cost),
      ],
      events: nodeEvents.map((event) => ({
        timeUnixNano: nanos(event.ts),
        name: event.eventType,
        attributes: includePayloads
          ? [text('chimera.payload', event.payloadJson.slice(0, 8_000))]
          : [],
      })),
    });
  }

  return spans;
}

/**
 * Sends a run to the collector, if this workspace has one.
 *
 * Never throws and never retries. Telemetry that could fail a run, or that
 * queued up behind an unreachable collector, would be a run that depends on an
 * observability endpoint — which is the wrong way round.
 */
export async function exportRun(runId: string): Promise<{ sent: boolean; detail: string }> {
  const settings = telemetrySettings();
  if (!settings.enabled || settings.endpoint.trim() === '') return { sent: false, detail: '' };

  const spans = spansFor(runId, settings.includePayloads);
  if (spans.length === 0) return { sent: false, detail: 'nothing to send' };

  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(settings.headersJson) as Record<string, string>;
  } catch {
    headers = {};
  }

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [text('service.name', 'chimera'), text('service.version', '0.0.0')],
        },
        scopeSpans: [{ scope: { name: 'chimera' }, spans }],
      },
    ],
  };

  try {
    const response = await fetch(`${settings.endpoint.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { sent: response.ok, detail: response.ok ? '' : `HTTP ${String(response.status)}` };
  } catch (err) {
    return { sent: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
