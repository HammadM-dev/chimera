import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { getChannel } from './registry.ts';
import type { InvokeEnvelope, EventEnvelope, WireResult } from './types.ts';
import {
  IpcError,
  UnregisteredChannelError,
  InvalidPayloadError,
  ChannelVersionMismatchError,
} from './errors.ts';
import { formatInvokeLogEntry } from './logging.ts';
import { INVOKE_CHANNEL, EVENT_CHANNEL } from './channelNames.ts';

export { INVOKE_CHANNEL, EVENT_CHANNEL };

function logInvoke(envelope: InvokeEnvelope): void {
  const def = getChannel(envelope.channel);
  console.log('[ipc]', JSON.stringify(formatInvokeLogEntry(envelope, def)));
}

async function dispatch(envelope: InvokeEnvelope): Promise<WireResult<unknown>> {
  const def = getChannel(envelope.channel);

  if (!def) {
    return { ok: false, error: new UnregisteredChannelError(envelope.channel).toWireFormat() };
  }
  if (def.kind !== 'invoke') {
    return {
      ok: false,
      error: new IpcError(
        'IPC_NOT_INVOKABLE',
        `"${envelope.channel}" is a push-only event channel, not invokable`,
      ).toWireFormat(),
    };
  }
  if (def.v !== envelope.v) {
    return {
      ok: false,
      error: new ChannelVersionMismatchError(envelope.channel, def.v, envelope.v).toWireFormat(),
    };
  }

  const parsedRequest = def.requestSchema.safeParse(envelope.payload);
  if (!parsedRequest.success) {
    return {
      ok: false,
      error: new InvalidPayloadError(envelope.channel, parsedRequest.error.issues).toWireFormat(),
    };
  }

  try {
    const result = await def.handler(parsedRequest.data);
    const parsedResponse = def.responseSchema.safeParse(result);
    if (!parsedResponse.success) {
      return {
        ok: false,
        error: new InvalidPayloadError(
          envelope.channel,
          parsedResponse.error.issues,
        ).toWireFormat(),
      };
    }
    return { ok: true, data: parsedResponse.data };
  } catch (err) {
    if (err instanceof IpcError) {
      return { ok: false, error: err.toWireFormat() };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: new IpcError('IPC_HANDLER_ERROR', message).toWireFormat() };
  }
}

export function registerIpcMainHandlers(): void {
  ipcMain.handle(INVOKE_CHANNEL, async (_event: IpcMainInvokeEvent, envelope: InvokeEnvelope) => {
    logInvoke(envelope);
    return dispatch(envelope);
  });
}

export function sendEvent<TPayload>(
  webContents: WebContents,
  channel: string,
  payload: TPayload,
): void {
  const def = getChannel(channel);
  if (!def || def.kind !== 'event') {
    throw new IpcError(
      'IPC_UNKNOWN_EVENT_CHANNEL',
      `"${channel}" is not a registered event channel`,
    );
  }
  const envelope: EventEnvelope<TPayload> = { v: def.v, channel, payload };
  webContents.send(EVENT_CHANNEL, envelope);
}
