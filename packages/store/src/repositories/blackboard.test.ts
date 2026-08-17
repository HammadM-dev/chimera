import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChimeraError } from '@chimera/errors';
import { openDatabase } from '../db.ts';
import * as runs from './runs.ts';
import * as blackboard from './blackboard.ts';

// M5-2. Append-only, attributed, scoped.

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-bb-'));
  const db = openDatabase({ dbPath: path.join(dir, 'w.sqlite'), migrationsDir });
  runs.create(db, { id: 'run-1' });
  return { db, dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('two roles writing the same key both survive, each attributed', () => {
  const { db, close } = open();
  try {
    blackboard.write(db, {
      runId: 'run-1',
      roleId: 'researcher',
      key: 'findings',
      valueJson: '"first"',
      scope: 'shared',
      writeScopes: ['shared'],
    });
    blackboard.write(db, {
      runId: 'run-1',
      roleId: 'qa',
      key: 'findings',
      valueJson: '"second"',
      scope: 'shared',
      writeScopes: ['shared'],
    });

    // Both rows, not one overwritten: a swarm writing the same key at the same
    // time is the normal case, and losing the loser silently is the failure
    // append-only exists to avoid.
    const all = blackboard.history(db, 'run-1', { key: 'findings' });
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((entry) => entry.roleId),
      ['researcher', 'qa'],
    );

    // And the current value is the latest of them.
    assert.equal(blackboard.current(db, 'run-1', 'findings')?.valueJson, '"second"');
  } finally {
    db.close();
    close();
  }
});

test('a role writing outside its scopes is refused', () => {
  const { db, close } = open();
  try {
    assert.throws(
      () =>
        blackboard.write(db, {
          runId: 'run-1',
          roleId: 'reviewer',
          key: 'plan',
          valueJson: '"mine now"',
          scope: 'orchestrator',
          writeScopes: ['reviews'],
        }),
      (err: unknown) => err instanceof ChimeraError && err.code === 'BLACKBOARD_SCOPE_NOT_ALLOWED',
    );

    assert.equal(blackboard.history(db, 'run-1').length, 0);
  } finally {
    db.close();
    close();
  }
});

test('reading is scoped: what you cannot write to, you may still not see', () => {
  const { db, close } = open();
  try {
    blackboard.write(db, {
      runId: 'run-1',
      roleId: 'planner',
      key: 'plan',
      valueJson: '"the plan"',
      scope: 'orchestrator',
      writeScopes: ['orchestrator'],
    });
    blackboard.write(db, {
      runId: 'run-1',
      roleId: 'coder',
      key: 'progress',
      valueJson: '"half"',
      scope: 'workers',
      writeScopes: ['workers'],
    });

    const workerView = blackboard.snapshot(db, 'run-1', ['workers']);
    assert.deepEqual(
      workerView.map((entry) => entry.key),
      ['progress'],
    );

    const everything = blackboard.snapshot(db, 'run-1', ['*']);
    assert.deepEqual(
      everything.map((entry) => entry.key),
      ['plan', 'progress'],
    );
  } finally {
    db.close();
    close();
  }
});

test('the current value is the last write, not the last timestamp', () => {
  const { db, close } = open();
  try {
    // Ten writes inside the same millisecond is ordinary at swarm speeds, and
    // an ISO timestamp cannot separate them. Insertion order can.
    for (let index = 0; index < 10; index += 1) {
      blackboard.write(db, {
        runId: 'run-1',
        roleId: 'worker',
        key: 'count',
        valueJson: String(index),
        scope: 'shared',
        writeScopes: ['*'],
      });
    }

    assert.equal(blackboard.current(db, 'run-1', 'count')?.valueJson, '9');
  } finally {
    db.close();
    close();
  }
});
