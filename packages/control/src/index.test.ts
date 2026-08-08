import test from 'node:test';
import assert from 'node:assert/strict';
import * as control from './index.ts';

test('module loads', () => {
  assert.equal(typeof control, 'object');
});
