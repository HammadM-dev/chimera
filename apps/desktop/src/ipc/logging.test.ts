import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInvokeLogEntry, REDACTED } from './logging.ts';
import { getChannel } from './registry.ts';

const baseEnvelope = { v: 1, requestId: 'req-1' };

for (const channel of ['vault:setSecret', 'connection:create', 'licence:activate']) {
  test(`${channel} log entry redacts payload`, () => {
    const def = getChannel(channel);
    assert.ok(def, `expected ${channel} to be registered`);
    assert.equal(def.sensitive, true, `expected ${channel} to be flagged sensitive`);

    const entry = formatInvokeLogEntry(
      { ...baseEnvelope, channel, payload: { secret: 'do-not-log-me' } },
      def,
    );

    assert.equal(entry.payload, REDACTED);
  });
}

test('workflow:list log entry is not redacted', () => {
  const def = getChannel('workflow:list');
  assert.ok(def, 'expected workflow:list to be registered');
  assert.equal(def.sensitive, false);

  const payload = { status: 'active' };
  const entry = formatInvokeLogEntry({ ...baseEnvelope, channel: 'workflow:list', payload }, def);

  assert.deepEqual(entry.payload, payload);
});

test('an unregistered channel redacts by default (fail closed)', () => {
  const entry = formatInvokeLogEntry(
    { ...baseEnvelope, channel: 'not:registered', payload: { might: 'be sensitive' } },
    undefined,
  );

  assert.equal(entry.payload, REDACTED);
});
