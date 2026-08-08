// Local to apps/desktop for now — M0-4 lands before M0-7 (packages/core's
// error taxonomy) in ticket order, and M0-4 doesn't depend on M0-7. Shape
// deliberately mirrors what packages/core/src/errors.ts establishes later
// (a stable `code`, a `details` bag) so the two are easy to unify if a
// later milestone wants apps/desktop to route through the shared taxonomy.
export class IpcError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IpcError';
    this.code = code;
    this.details = details;
  }

  toWireFormat(): { code: string; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class UnregisteredChannelError extends IpcError {
  constructor(channel: string) {
    super('IPC_UNREGISTERED_CHANNEL', `No channel registered: "${channel}"`, { channel });
    this.name = 'UnregisteredChannelError';
  }
}

export class InvalidPayloadError extends IpcError {
  constructor(channel: string, issues: unknown) {
    super('IPC_INVALID_PAYLOAD', `Payload for "${channel}" failed schema validation`, {
      channel,
      issues,
    });
    this.name = 'InvalidPayloadError';
  }
}

// docs/ARCHITECTURE.md: "A handler receiving an envelope with an unexpected
// v for its channel rejects... silent coercion between envelope versions is
// not permitted." That doc names the eventual packages/core ValidationError
// (M0-7, not built yet) — kept as a distinct local error/code for now so
// the two are easy to tell apart in a trace once they're unified.
export class ChannelVersionMismatchError extends IpcError {
  constructor(channel: string, expected: number, received: number) {
    super(
      'IPC_VERSION_MISMATCH',
      `Channel "${channel}" expects envelope v${expected}, received v${received}`,
      { channel, expected, received },
    );
    this.name = 'ChannelVersionMismatchError';
  }
}
