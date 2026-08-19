import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutionError } from '@chimera/errors';
import { createSandbox } from './sandbox.ts';

// Granted folders: a user may let CHIMERA read somewhere outside the run's own
// workspace. Everything here is about the boundary of that grant, because the
// grant is the whole security question — a folder made readable must not become
// writable, and must not become a way to reach anywhere else.

function scratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `chimera-${name}-`));
}

const refused = (err: unknown): boolean => err instanceof ToolExecutionError;

test('a granted folder can be read, by absolute path', () => {
  const base = scratch('base');
  const granted = scratch('granted');
  fs.writeFileSync(path.join(granted, 'contract.txt'), 'renews 2027', 'utf8');

  const sandbox = createSandbox(base, 'run-1', [granted]);
  const resolved = sandbox.resolveForRead(path.join(granted, 'contract.txt'));
  assert.equal(fs.readFileSync(resolved, 'utf8'), 'renews 2027');
});

test('a granted folder is not writable — the grant is read access and only that', () => {
  const base = scratch('base');
  const granted = scratch('granted');
  const sandbox = createSandbox(base, 'run-1', [granted]);

  // `resolve` is what every write goes through, and there is no argument to it
  // that reaches a granted folder.
  assert.throws(() => sandbox.resolve(path.join(granted, 'new.txt')), refused);
});

test('nothing outside a grant is readable', () => {
  const base = scratch('base');
  const granted = scratch('granted');
  const secret = scratch('elsewhere');
  fs.writeFileSync(path.join(secret, 'keys.txt'), 'do not read me', 'utf8');

  const sandbox = createSandbox(base, 'run-1', [granted]);
  assert.throws(() => sandbox.resolveForRead(path.join(secret, 'keys.txt')), refused);
  assert.throws(() => sandbox.resolveForRead('/etc/passwd'), refused);
});

test('climbing out of a granted folder is refused', () => {
  const base = scratch('base');
  const parent = scratch('parent');
  const granted = path.join(parent, 'inner');
  fs.mkdirSync(granted);
  fs.writeFileSync(path.join(parent, 'sibling.txt'), 'not yours', 'utf8');

  const sandbox = createSandbox(base, 'run-1', [granted]);
  assert.throws(() => sandbox.resolveForRead(path.join(granted, '..', 'sibling.txt')), refused);
});

test('a symlink inside a granted folder cannot carry a read out of it', () => {
  const base = scratch('base');
  const granted = scratch('granted');
  const secret = scratch('elsewhere');
  fs.writeFileSync(path.join(secret, 'keys.txt'), 'do not read me', 'utf8');
  // The classic escape: something inside the permitted folder pointing out.
  fs.symlinkSync(path.join(secret, 'keys.txt'), path.join(granted, 'innocent.txt'));

  const sandbox = createSandbox(base, 'run-1', [granted]);
  assert.throws(() => sandbox.resolveForRead(path.join(granted, 'innocent.txt')), refused);
});

test('with no grant, nothing outside the workspace is readable at all', () => {
  const base = scratch('base');
  const elsewhere = scratch('elsewhere');
  fs.writeFileSync(path.join(elsewhere, 'x.txt'), 'x', 'utf8');

  const sandbox = createSandbox(base, 'run-1');
  assert.equal(sandbox.readable.length, 0);
  assert.throws(() => sandbox.resolveForRead(path.join(elsewhere, 'x.txt')), refused);

  // And the run's own workspace still reads, grant or no grant.
  fs.writeFileSync(path.join(sandbox.root, 'mine.txt'), 'mine', 'utf8');
  assert.equal(fs.readFileSync(sandbox.resolveForRead('mine.txt'), 'utf8'), 'mine');
});

test('a grant that no longer exists is dropped rather than breaking every run', () => {
  const base = scratch('base');
  const gone = path.join(os.tmpdir(), 'chimera-never-existed-9f2c');
  const sandbox = createSandbox(base, 'run-1', [gone]);
  assert.deepEqual(sandbox.readable, []);
});

test('a null byte is refused on the read path too', () => {
  const base = scratch('base');
  const granted = scratch('granted');
  const sandbox = createSandbox(base, 'run-1', [granted]);
  // Built rather than written, so this file carries no control character.
  const withNull = `contract${String.fromCharCode(0)}.txt`;
  assert.throws(() => sandbox.resolveForRead(withNull), refused);
});
