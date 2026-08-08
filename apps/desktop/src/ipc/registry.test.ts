import test from 'node:test';
import assert from 'node:assert/strict';
import { listChannels, CHANNEL_REGISTRY } from './registry.ts';

test('every channel name is unique', () => {
  const names = listChannels().map((c) => c.channel);
  assert.equal(new Set(names).size, names.length, 'duplicate channel name in the registry');
});

test('every channel has a positive integer version', () => {
  for (const def of listChannels()) {
    assert.ok(Number.isInteger(def.v) && def.v > 0, `${def.channel} has an invalid v: ${def.v}`);
  }
});

test('registry map and list agree', () => {
  assert.equal(CHANNEL_REGISTRY.size, listChannels().length);
  for (const def of listChannels()) {
    assert.equal(CHANNEL_REGISTRY.get(def.channel), def);
  }
});

test('every documented channel from docs/ARCHITECTURE.md section 4 is registered', () => {
  const expected = [
    'workflow:save',
    'workflow:list',
    'workflow:get',
    'run:start',
    'run:cancel',
    'run:subscribe',
    'run:event',
    'provider:testConnection',
    'connection:create',
    'connection:list',
    'vault:setSecret',
    'vault:hasSecret',
    'licence:activate',
    'licence:status',
    'template:import',
    'eval:run',
  ];
  for (const channel of expected) {
    assert.ok(CHANNEL_REGISTRY.has(channel), `expected ${channel} to be registered`);
  }
});
