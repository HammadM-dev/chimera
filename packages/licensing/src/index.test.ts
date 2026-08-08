import test from 'node:test';
import assert from 'node:assert/strict';
import * as licensing from './index.ts';

test('module loads', () => {
  assert.equal(typeof licensing, 'object');
});
