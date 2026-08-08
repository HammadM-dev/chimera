import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from './index.ts';

test('module loads', () => {
  assert.equal(typeof providers, 'object');
});
