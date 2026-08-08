export const REDACTED = '[redacted]';

export interface LoggableInvokeRecord {
  v: number;
  channel: string;
  requestId: string;
  payload: unknown;
}

// Fails closed: an unregistered channel (channelDef undefined) redacts too —
// we don't know what it might have been carrying, so silence beats a guess.
export function formatInvokeLogEntry(
  envelope: LoggableInvokeRecord,
  channelDef: { sensitive: boolean } | undefined,
): LoggableInvokeRecord {
  const sensitive = channelDef?.sensitive ?? true;
  return {
    ...envelope,
    payload: sensitive ? REDACTED : envelope.payload,
  };
}
