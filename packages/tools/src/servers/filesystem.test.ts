import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolExecutionError } from '@chimera/errors';
import { connectInProcess } from '../mcpClient.ts';
import { createToolRegistry } from '../toolRegistry.ts';
import { createSandbox, destroySandbox, type Sandbox } from '../sandbox.ts';
import { createFilesystemServer } from './filesystem.ts';

const FULL_ACCESS = { role: { id: 'coder', toolAllowlist: ['fs.*'] } };

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-sandbox-'));
}

async function withRun(
  runId: string,
  body: (registry: ReturnType<typeof createToolRegistry>, sandbox: Sandbox) => Promise<void>,
): Promise<void> {
  const base = tempBase();
  const sandbox = createSandbox(base, runId);
  const registry = createToolRegistry();
  await registry.registerServer('fs', await connectInProcess(createFilesystemServer(sandbox)));
  try {
    await body(registry, sandbox);
  } finally {
    await registry.close();
    destroySandbox(sandbox);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('a file written and read inside the sandbox round-trips', async () => {
  await withRun('run-a', async (registry) => {
    const written = await registry.invoke(
      'fs.writeFile',
      { path: 'notes/todo.txt', content: 'buy milk' },
      FULL_ACCESS,
    );
    assert.equal(written.isError, false);

    const read = await registry.invoke('fs.readFile', { path: 'notes/todo.txt' }, FULL_ACCESS);
    assert.equal(read.text, 'buy milk');

    const listed = await registry.invoke('fs.listDirectory', { path: '.' }, FULL_ACCESS);
    assert.equal(listed.text, 'notes/');
  });
});

test('a relative escape is refused', async () => {
  await withRun('run-a', async (_registry, sandbox) => {
    assert.throws(
      () => sandbox.resolve('../../etc/passwd'),
      (err: unknown) => err instanceof ToolExecutionError && err.code === 'TOOL_EXECUTION_FAILED',
    );
    return Promise.resolve();
  });
});

test('an absolute path outside the sandbox is refused', async () => {
  await withRun('run-a', async (_registry, sandbox) => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    assert.throws(() => sandbox.resolve(outside), ToolExecutionError);
    return Promise.resolve();
  });
});

test('a symlink pointing out of the sandbox is refused', async () => {
  const base = tempBase();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours', 'utf8');

  const sandbox = createSandbox(base, 'run-a');
  const link = path.join(sandbox.root, 'escape');
  try {
    fs.symlinkSync(outside, link, 'dir');
  } catch {
    // Windows without developer mode refuses symlink creation for an
    // unprivileged process. Skipping is honest here: the escape being tested
    // cannot be constructed on this machine at all.
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    return;
  }

  // The link itself is inside the sandbox; what it points at is not. Resolving
  // only the string would let this through — the check resolves the link.
  assert.throws(() => sandbox.resolve('escape/secret.txt'), ToolExecutionError);

  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('a refused path reaches no filesystem operation on the target', async () => {
  // The criterion is "before any filesystem access occurs". The sandbox does
  // call realpath on the *existing ancestor* of the requested path, which is
  // how the symlink case above is caught — but the requested target is never
  // opened, read, written or stat-ed. These are the four that would matter.
  const base = tempBase();
  const sandbox = createSandbox(base, 'run-a');
  const registry = createToolRegistry();
  await registry.registerServer('fs', await connectInProcess(createFilesystemServer(sandbox)));

  const originals = {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    statSync: fs.statSync,
    readdirSync: fs.readdirSync,
  };
  let touched = 0;
  const count =
    <T extends (...args: never[]) => unknown>(original: T) =>
    (...args: Parameters<T>): unknown => {
      touched += 1;
      return original(...args);
    };

  // Object.assign rather than direct assignment: the fs namespace's members are
  // declared read-only, and the point of this test is to observe the real
  // module the server actually calls, not a copy of it.
  Object.assign(fs, {
    readFileSync: count(originals.readFileSync),
    writeFileSync: count(originals.writeFileSync),
    statSync: count(originals.statSync),
    readdirSync: count(originals.readdirSync),
  });

  try {
    const result = await registry.invoke('fs.readFile', { path: '../../etc/passwd' }, FULL_ACCESS);
    assert.equal(result.isError, true);
    assert.match(result.text, /outside the run's workspace/);
    assert.equal(touched, 0, 'a filesystem operation ran for a path that was refused');
  } finally {
    Object.assign(fs, originals);
    await registry.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a traversal in the parent of a write cannot create directories outside the sandbox', async () => {
  const base = tempBase();
  const sandbox = createSandbox(base, 'run-a');
  const registry = createToolRegistry();
  await registry.registerServer('fs', await connectInProcess(createFilesystemServer(sandbox)));

  try {
    const result = await registry.invoke(
      'fs.writeFile',
      { path: '../sibling/planted.txt', content: 'x' },
      FULL_ACCESS,
    );
    assert.equal(result.isError, true);
    assert.equal(
      fs.existsSync(path.join(base, 'sibling')),
      false,
      'a directory was created outside the sandbox',
    );
  } finally {
    await registry.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('two concurrent runs get separate workspaces and cannot read each other', async () => {
  const base = tempBase();
  const sandboxA = createSandbox(base, 'run-a');
  const sandboxB = createSandbox(base, 'run-b');
  const registryA = createToolRegistry();
  const registryB = createToolRegistry();
  await registryA.registerServer('fs', await connectInProcess(createFilesystemServer(sandboxA)));
  await registryB.registerServer('fs', await connectInProcess(createFilesystemServer(sandboxB)));

  try {
    assert.notEqual(sandboxA.root, sandboxB.root);

    // Both runs write a file with the same name, concurrently.
    const [wroteA, wroteB] = await Promise.all([
      registryA.invoke('fs.writeFile', { path: 'shared.txt', content: 'from A' }, FULL_ACCESS),
      registryB.invoke('fs.writeFile', { path: 'shared.txt', content: 'from B' }, FULL_ACCESS),
    ]);
    assert.equal(wroteA.isError, false);
    assert.equal(wroteB.isError, false);

    // Each sees only its own.
    const [readA, readB] = await Promise.all([
      registryA.invoke('fs.readFile', { path: 'shared.txt' }, FULL_ACCESS),
      registryB.invoke('fs.readFile', { path: 'shared.txt' }, FULL_ACCESS),
    ]);
    assert.equal(readA.text, 'from A');
    assert.equal(readB.text, 'from B');

    // And A cannot reach into B by name, even knowing exactly where it is.
    const peek = await registryA.invoke(
      'fs.readFile',
      { path: '../run-b/shared.txt' },
      FULL_ACCESS,
    );
    assert.equal(peek.isError, true);
    assert.match(peek.text, /outside the run's workspace/);
  } finally {
    await Promise.all([registryA.close(), registryB.close()]);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a run id that is itself a traversal is refused', async () => {
  const base = tempBase();
  try {
    assert.throws(() => createSandbox(base, '../escape'), ToolExecutionError);
    assert.throws(() => createSandbox(base, ''), ToolExecutionError);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a file over the read limit is refused rather than pulled into a prompt', async () => {
  await withRun('run-a', async (registry, sandbox) => {
    fs.writeFileSync(path.join(sandbox.root, 'big.txt'), 'x'.repeat(1_000_001), 'utf8');
    const result = await registry.invoke('fs.readFile', { path: 'big.txt' }, FULL_ACCESS);
    assert.equal(result.isError, true);
    assert.match(result.text, /read limit/);
  });
});
