import type { TraceEvent } from '@chimera/core';

// What a step is doing, in words, while it is doing it.
//
// The trace is an audit record: exact, complete, and unreadable at a glance —
// `tool_call` with a JSON blob of arguments is the right thing to keep and the
// wrong thing to show somebody watching a run. This turns each event into one
// line a person would actually write: "Opened bankofengland.co.uk", "Searched
// for UK base rate", "Read 3 files".
//
// Nothing here is the source of truth. The trace viewer still shows the raw
// events; this is the live feed, and it is allowed to omit and to summarise.

export interface Activity {
  nodeId: string;
  /** Millis, so the window can show how long the current thing has been going. */
  at: number;
  /** One line, already in a person's words. */
  text: string;
  /** What kind of thing this was, for the icon beside it. */
  kind: 'thinking' | 'search' | 'web' | 'file' | 'mail' | 'tool' | 'done' | 'problem';
  /**
   * A file this step produced, when it produced one.
   *
   * Carried on the activity rather than announced separately so the window can
   * show it in place — the moment it was written, in the order things happened.
   */
  artifact?: { path: string; name: string; bytes: number | null };
  /** A screenshot or image, as a data URI. Only ever set when there is one. */
  image?: string;
}

/** Everything after the first dot: `search.web` is the search server's `web`. */
function toolParts(toolId: string): { server: string; name: string } {
  const dot = toolId.indexOf('.');
  return dot === -1
    ? { server: toolId, name: '' }
    : { server: toolId.slice(0, dot), name: toolId.slice(dot + 1) };
}

function hostOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/**
 * One tool call, described.
 *
 * The point is to name the *thing*, not the tool: "Opened
 * bankofengland.co.uk" rather than "http.request". Somebody watching wants to
 * know where their agent has been, and a tool id tells them nothing they can
 * check.
 */
function describeCall(
  toolId: string,
  args: Record<string, unknown>,
): { text: string; kind: Activity['kind'] } {
  const { server, name } = toolParts(toolId);

  if (server === 'search') {
    const query = firstString(args, ['query']);
    return {
      text: query === '' ? 'Searching the web' : `Searching for “${query}”`,
      kind: 'search',
    };
  }

  if (server === 'http' || server === 'browser') {
    const host = hostOf(args['url']);
    if (name === 'navigate' || name === 'request') {
      return { text: host === '' ? 'Opening a page' : `Opening ${host}`, kind: 'web' };
    }
    if (name === 'extract' || name === 'read' || name === 'html') {
      return { text: 'Reading the page', kind: 'web' };
    }
    if (name === 'screenshot') return { text: 'Taking a picture of the page', kind: 'web' };
    if (name === 'click') {
      const target = firstString(args, ['selector', 'text']);
      return { text: target === '' ? 'Clicking' : `Clicking ${target}`, kind: 'web' };
    }
    if (name === 'type') return { text: 'Filling in a field', kind: 'web' };
    return { text: host === '' ? 'Using the browser' : `Using ${host}`, kind: 'web' };
  }

  if (server === 'filesystem') {
    const target = firstString(args, ['path']);
    const shown = target === '' ? '' : ` ${target.split('/').pop() ?? target}`;
    if (name === 'writeFile') return { text: `Writing${shown}`, kind: 'file' };
    if (name === 'makeDirectory') return { text: `Making a folder${shown}`, kind: 'file' };
    if (name === 'listDirectory')
      return { text: `Looking in${shown === '' ? ' a folder' : shown}`, kind: 'file' };
    return { text: `Reading${shown}`, kind: 'file' };
  }

  if (server.startsWith('email')) {
    if (name === 'send' || name === 'reply') return { text: 'Sending an email', kind: 'mail' };
    return { text: 'Reading the mailbox', kind: 'mail' };
  }

  if (server === 'memory') {
    return {
      text: name === 'remember' ? 'Making a note for next time' : 'Checking what it already knows',
      kind: 'tool',
    };
  }

  if (server === 'shell') {
    const command = firstString(args, ['command']);
    return { text: command === '' ? 'Running a command' : `Running ${command}`, kind: 'tool' };
  }

  return { text: `Using ${toolId}`, kind: 'tool' };
}

/** A data URI for an image the tool returned, if it returned one. */
function imageFrom(payload: Record<string, unknown>): string | undefined {
  const output = payload['output'];
  if (typeof output !== 'string') return undefined;
  // Screenshots come back base64. Anything else that happens to be base64 is
  // not shown, because a wall of pixels nobody asked for is worse than nothing.
  if (/^data:image\/(png|jpe?g|webp);base64,/.test(output)) return output.slice(0, 4_000_000);
  if (/^[A-Za-z0-9+/]{200,}={0,2}$/.test(output.trim())) {
    return `data:image/png;base64,${output.trim()}`;
  }
  return undefined;
}

/**
 * Reads a run's trace events into activity, remembering what it needs to.
 *
 * Stateful, and it has to be. A `tool_result` carries the tool id, the output
 * and whether it failed — and not the arguments, which are on the `tool_call`
 * that preceded it. So "the agent wrote report.csv" is a fact split across two
 * events joined by `callId`, and a mapper that looked at one event at a time
 * could describe the writing and never the written thing.
 *
 * One reader per run. The map is bounded by the calls a single run makes.
 */
export function createActivityReader(): {
  read: (event: TraceEvent, at?: number) => Activity | null;
} {
  const calls = new Map<string, { toolId: string; args: Record<string, unknown> }>();

  return {
    read(event, at = Date.now()) {
      return activityFor(event, at, calls);
    },
  };
}

/**
 * Turns one trace event into a line worth showing, or nothing.
 *
 * Most events are not worth showing. A prompt is not activity — it is the
 * machinery of asking — and a checkpoint is bookkeeping. Returning null for
 * those is what keeps the feed readable rather than a scrolling log.
 */
export function activityFor(
  event: TraceEvent,
  at: number = Date.now(),
  calls: Map<string, { toolId: string; args: Record<string, unknown> }> = new Map(),
): Activity | null {
  const payload = event.payload;

  if (event.eventType === 'tool_call') {
    const toolId = typeof payload['toolId'] === 'string' ? payload['toolId'] : '';
    const args = (payload['arguments'] ?? payload['params'] ?? {}) as Record<string, unknown>;
    const callId = typeof payload['callId'] === 'string' ? payload['callId'] : '';
    if (callId !== '') calls.set(callId, { toolId, args });

    const described = describeCall(toolId, args);
    return { nodeId: event.nodeId, at, text: described.text, kind: described.kind };
  }

  if (event.eventType === 'tool_result') {
    const failed = payload['isError'] === true;
    const toolId = typeof payload['toolId'] === 'string' ? payload['toolId'] : '';
    const image = imageFrom(payload);

    if (failed) {
      const output = typeof payload['output'] === 'string' ? payload['output'] : '';
      return {
        nodeId: event.nodeId,
        at,
        text: `That did not work: ${output.slice(0, 160)}`,
        kind: 'problem',
      };
    }

    // A successful read is not worth a line of its own — the call already said
    // what was being read. A written file is, because there is now a thing, and
    // the window offers to save it somewhere the user chooses.
    //
    // The path is on the *call*, not the result, so it comes from the map.
    const callId = typeof payload['callId'] === 'string' ? payload['callId'] : '';
    const remembered = calls.get(callId);
    const { server, name } = toolParts(toolId === '' ? (remembered?.toolId ?? '') : toolId);

    if (server === 'filesystem' && (name === 'writeFile' || name === 'makeDirectory')) {
      const target = firstString(remembered?.args ?? {}, ['path']);
      if (target !== '') {
        const leaf = target.split('/').pop() ?? target;
        return {
          nodeId: event.nodeId,
          at,
          text: name === 'makeDirectory' ? `Made the folder ${leaf}` : `Saved ${leaf}`,
          kind: 'file',
          artifact: {
            path: target,
            name: leaf,
            bytes:
              typeof remembered?.args['content'] === 'string'
                ? Buffer.byteLength(remembered.args['content'], 'utf8')
                : null,
          },
        };
      }
    }

    return image === undefined
      ? null
      : { nodeId: event.nodeId, at, text: 'Saw this', kind: 'web', image };
  }

  if (event.eventType === 'decision') {
    const decision = typeof payload['decision'] === 'string' ? payload['decision'] : '';
    if (decision === 'verified') {
      return { nodeId: event.nodeId, at, text: 'Checked its own work and moved on', kind: 'done' };
    }
    if (decision === 'continue') {
      const evidence = typeof payload['evidence'] === 'string' ? payload['evidence'] : '';
      return {
        nodeId: event.nodeId,
        at,
        text:
          evidence === ''
            ? 'Not done yet, going round again'
            : `Not done yet: ${evidence.slice(0, 160)}`,
        kind: 'thinking',
      };
    }
    return null;
  }

  return null;
}
