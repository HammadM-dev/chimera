import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from './index.ts';

test('module loads', () => {
  assert.equal(typeof core, 'object');
});
