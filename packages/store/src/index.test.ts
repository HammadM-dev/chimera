import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from './index.ts';

test('module loads', () => {
  assert.equal(typeof store, 'object');
});
