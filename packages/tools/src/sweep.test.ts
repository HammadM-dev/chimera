import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSandbox, sweepSandboxes } from './sandbox.ts';

// Run directories, and getting rid of the old ones.
//
// Nothing removed them. Sixty-six had accumulated on the development machine
// before anybody looked, each holding whatever its run had been working on —
// which is a privacy question as much as a disk one.

function base(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-sweep-'));
}

/** Backdates a directory so the sweep sees it as old. */
function age(dir: string, days: number): void {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(dir, when, when);
}

test('a run directory older than the limit is removed, with what is inside it', () => {
  const root = base();
  const old = createSandbox(root, 'run-old');
  fs.writeFileSync(path.join(old.root, 'contract.txt'), 'private', 'utf8');
  age(old.root, 10);

  assert.deepEqual(sweepSandboxes(root, 7 * 24 * 60 * 60 * 1000), { removed: 1 });
  assert.equal(fs.existsSync(old.root), false);
});

test('a recent run is left alone — its files are the only copy of what it made', () => {
  const root = base();
  const recent = createSandbox(root, 'run-recent');
  fs.writeFileSync(path.join(recent.root, 'answer.txt'), 'keep me', 'utf8');

  assert.deepEqual(sweepSandboxes(root, 7 * 24 * 60 * 60 * 1000), { removed: 0 });
  assert.equal(fs.readFileSync(path.join(recent.root, 'answer.txt'), 'utf8'), 'keep me');
});

test('the sweep takes the old and leaves the new in the same directory', () => {
  const root = base();
  const old = createSandbox(root, 'run-old');
  const recent = createSandbox(root, 'run-recent');
  age(old.root, 30);

  assert.deepEqual(sweepSandboxes(root, 7 * 24 * 60 * 60 * 1000), { removed: 1 });
  assert.equal(fs.existsSync(old.root), false);
  assert.equal(fs.existsSync(recent.root), true);
});

test('a sandbox root that does not exist yet is not an error', () => {
  const missing = path.join(os.tmpdir(), 'chimera-sweep-never-9f2c');
  assert.deepEqual(sweepSandboxes(missing, 1000), { removed: 0 });
});

test('a stray file beside the run directories is not touched', () => {
  const root = base();
  const stray = path.join(root, 'notes.txt');
  fs.writeFileSync(stray, 'not a run', 'utf8');
  age(stray, 30);

  assert.deepEqual(sweepSandboxes(root, 7 * 24 * 60 * 60 * 1000), { removed: 0 });
  assert.equal(fs.existsSync(stray), true);
});
