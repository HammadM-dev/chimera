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

test('every starter role loads, each with a prompt, an allowlist decision and a budget', () => {
  const { db, dir } = openTemp();
  try {
    const registry = createRoleRegistry(db);
    const roles = registry.list();

    // Counted from the list below rather than written out again: two
    // statements of the same number is one that goes stale, and the assertion
    // that matters is which roles exist, not how many.
    assert.deepEqual(roles.map((role) => role.id).sort(), [
      // The home screen's own assistant. It reads this workspace and writes
      // nothing, which is why it is a role like any other rather than a
      // privileged path around the Governor.
      'app-operator',
      'assistant',
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

    // Every role can reach memory now, and the two that used to have nothing
    // get `memory.recall` only — reading what is known is not a capability that
    // needs guarding the way a shell is. What each role may do beyond that is
    // still the narrowest set that works.
    assert.equal(
      roles.every((role) => role.toolAllowlist.length > 0),
      true,
    );
    const canWriteMemory = roles.filter((role) => role.toolAllowlist.includes('memory.*'));
    assert.deepEqual(
      canWriteMemory.map((role) => role.id).sort(),
      ['coder', 'data-extractor', 'qa', 'researcher'],
      'only roles that do the work should be able to write memory',
    );
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
    const seeded = registry.list().length;
    registry.setToolAllowlist('researcher', ['filesystem.readFile']);

    // Read back through the same registry — no restart, no cache to invalidate.
    assert.deepEqual(registry.get('researcher')?.toolAllowlist, ['filesystem.readFile']);

    // And through a second registry over the same database, which is what a
    // restart actually amounts to.
    const reopened = createRoleRegistry(db);
    assert.deepEqual(reopened.get('researcher')?.toolAllowlist, ['filesystem.readFile']);

    // Seeding does not run again and does not overwrite the edit. Compared
    // against what the first registry seeded rather than a written-out number,
    // which was a second copy of the role count that went stale the first time
    // a role was added.
    assert.equal(reopened.list().length, seeded);
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

    // Saved through the real registry rather than hand-made, so this is a role
    // the runtime would actually load. No starter role has an empty allowlist
    // any more — every one can at least recall memory — so the case is made
    // explicitly rather than borrowed from whichever role happened to have none.
    const base = registry.get('summariser');
    assert.ok(base);
    const mute = registry.save({ ...base, id: 'mute', name: 'Mute', toolAllowlist: [] });
    assert.deepEqual(mute.toolAllowlist, []);

    await assert.rejects(
      () => tools.invoke('filesystem.readFile', { path: 'anything' }, { role: mute }),
      (err: unknown) => err instanceof ToolAllowlistError,
    );
    await assert.rejects(
      () => tools.invoke('memory.recall', { query: 'anything' }, { role: mute }),
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
