import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { ValidationError, ToolAllowlistError } from '@chimera/errors';
import { openDatabase } from '@chimera/store';
import {
  connectInProcess,
  createToolRegistry,
  createSandbox,
  createFilesystemServer,
} from '@chimera/tools';
import { createRoleRegistry, STARTER_ROLES } from './roleRegistry.ts';

const migrationsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'store',
  'src',
  'migrations',
);

function openTemp(): { db: Database.Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-roles-'));
  return { db: openDatabase({ dbPath: path.join(dir, 'test.sqlite'), migrationsDir }), dir };
}

test('all eight starter roles load, each with a prompt, an allowlist decision and a budget', () => {
  const { db, dir } = openTemp();
  try {
    const registry = createRoleRegistry(db);
    const roles = registry.list();

    assert.equal(roles.length, 8);
    assert.deepEqual(roles.map((role) => role.id).sort(), [
      'browser-operator',
      'coder',
      'data-extractor',
      'planner',
      'qa',
      'researcher',
      'reviewer',
      'summariser',
    ]);

    for (const role of roles) {
      assert.notEqual(role.systemPrompt.trim(), '', role.id);
      assert.ok(role.budget.maxTokens > 0, role.id);
      assert.ok(role.budget.maxWallClockMs > 0, role.id);
      assert.ok(role.maxIterations >= 1, role.id);
      assert.ok(role.isBuiltin, role.id);
    }

    // An empty allowlist is a decision, not an omission: planner and summariser
    // genuinely need no tools, and giving them some "just in case" is the exact
    // habit capability limits exist to prevent.
    const withTools = roles.filter((role) => role.toolAllowlist.length > 0);
    assert.equal(withTools.length, 6);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the reviewer cannot write, and only the coder and QA get a shell', () => {
  const { db, dir } = openTemp();
  try {
    const registry = createRoleRegistry(db);
    const reviewer = registry.get('reviewer');
    assert.ok(reviewer);
    // A reviewer that could edit would quietly become the author of what it is
    // reviewing.
    assert.equal(reviewer.toolAllowlist.includes('filesystem.*'), false);
    assert.equal(reviewer.toolAllowlist.includes('shell.exec'), false);

    const withShell = registry
      .list()
      .filter((role) => role.toolAllowlist.includes('shell.exec'))
      .map((role) => role.id)
      .sort();
    assert.deepEqual(withShell, ['coder', 'qa']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an edited allowlist persists and is visible on the next read, no restart', () => {
  const { db, dir } = openTemp();
  try {
    const registry = createRoleRegistry(db);
    registry.setToolAllowlist('researcher', ['filesystem.readFile']);

    // Read back through the same registry — no restart, no cache to invalidate.
    assert.deepEqual(registry.get('researcher')?.toolAllowlist, ['filesystem.readFile']);

    // And through a second registry over the same database, which is what a
    // restart actually amounts to.
    const reopened = createRoleRegistry(db);
    assert.deepEqual(reopened.get('researcher')?.toolAllowlist, ['filesystem.readFile']);

    // Seeding does not run again and does not overwrite the edit.
    assert.equal(reopened.list().length, 8);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a role with an empty allowlist can invoke nothing', async () => {
  const { db, dir } = openTemp();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-roles-sandbox-'));
  const sandbox = createSandbox(base, 'run-a');
  const tools = createToolRegistry();
  await tools.registerServer('filesystem', await connectInProcess(createFilesystemServer(sandbox)));

  try {
    const registry = createRoleRegistry(db);
    const summariser = registry.get('summariser');
    assert.ok(summariser);
    assert.deepEqual(summariser.toolAllowlist, []);

    // The concrete role fixture, against the real registry — not a hand-made
    // object that happens to have an empty array.
    await assert.rejects(
      () => tools.invoke('filesystem.readFile', { path: 'anything' }, { role: summariser }),
      (err: unknown) => err instanceof ToolAllowlistError,
    );
  } finally {
    await tools.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a role that permits no work, or grants everything, is refused', () => {
  const { db, dir } = openTemp();
  try {
    const registry = createRoleRegistry(db);
    const base = STARTER_ROLES[0];
    assert.ok(base);

    assert.throws(
      () => registry.save({ ...base, id: 'bad-1', maxIterations: 0 }),
      ValidationError,
      'a role with no iteration cap was accepted',
    );
    assert.throws(
      () => registry.save({ ...base, id: 'bad-2', systemPrompt: '   ' }),
      ValidationError,
    );
    // '*' is the entry someone reaches for at 2am; packages/tools does not
    // honour it, and a role that thinks it granted everything while granting
    // nothing is worse than either honest answer.
    assert.throws(
      () => registry.save({ ...base, id: 'bad-3', toolAllowlist: ['*'] }),
      ValidationError,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
