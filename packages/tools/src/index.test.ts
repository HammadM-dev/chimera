import test from 'node:test';
import assert from 'node:assert/strict';
import * as tools from './index.ts';

test('module loads', () => {
  assert.equal(typeof tools, 'object');
});
