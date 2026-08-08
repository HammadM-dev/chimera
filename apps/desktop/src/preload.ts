import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { getChannel } from './ipc/registry.ts';
import { INVOKE_CHANNEL, EVENT_CHANNEL } from './ipc/channelNames.ts';
import { throwIpcError, parseIpcError } from './ipc/clientError.ts';
import type { InvokeEnvelope, EventEnvelope, WireResult } from './ipc/types.ts';

// contextBridge.exposeInMainWorld is the ONLY renderer-to-main path — see
// CLAUDE.md and docs/ARCHITECTURE.md section 4. Nothing else is exposed.

async function invoke<TRes = unknown>(channel: string, payload: unknown): Promise<TRes> {
  // Fail fast, locally: an unregistered/non-invokable channel never makes
  // an IPC round trip at all. Main-process dispatch checks again regardless
  // (docs/ARCHITECTURE.md's dispatcher is the real enforcement point) —
  // this is a fast path, not the only line of defence.
  const def = getChannel(channel);
  if (!def || def.kind !== 'invoke') {
    throwIpcError({
      code: 'IPC_UNREGISTERED_CHANNEL',
      message: `No invokable channel registered: "${channel}"`,
      details: { channel },
    });
  }

  const envelope: InvokeEnvelope = {
    v: def.v,
    channel,
    requestId: crypto.randomUUID(),
    payload,
  };

  const result = (await ipcRenderer.invoke(INVOKE_CHANNEL, envelope)) as WireResult<TRes>;

  if (!result.ok) {
    throwIpcError(result.error);
  }

  return result.data;
}

function on<TPayload = unknown>(
  channel: string,
  callback: (payload: TPayload) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, envelope: EventEnvelope<TPayload>): void => {
    if (envelope.channel === channel) {
      callback(envelope.payload);
    }
  };
  ipcRenderer.on(EVENT_CHANNEL, listener);
  return () => {
    ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  };
}

contextBridge.exposeInMainWorld('chimera', { invoke, on, parseError: parseIpcError });
