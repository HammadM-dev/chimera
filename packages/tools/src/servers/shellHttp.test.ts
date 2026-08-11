import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connectInProcess } from '../mcpClient.ts';
import { createToolRegistry, type ToolRegistry } from '../toolRegistry.ts';
import { createSandbox, type Sandbox } from '../sandbox.ts';
import { createShellServer } from './shell.ts';
import { createHttpServer, isHostAllowed, type HttpTransport } from './http.ts';

const FULL_ACCESS = { role: { id: 'coder', toolAllowlist: ['shell.*', 'http.*'] } };

function tempBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-tools-'));
}

async function withShell(body: (registry: ToolRegistry, sandbox: Sandbox) => Promise<void>) {
  const base = tempBase();
  const sandbox = createSandbox(base, 'run-a');
  const registry = createToolRegistry();
  await registry.registerServer('shell', await connectInProcess(createShellServer(sandbox)));
  try {
    await body(registry, sandbox);
  } finally {
    await registry.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('a shell command runs with its working directory pinned to the sandbox', async () => {
  await withShell(async (registry, sandbox) => {
    // The process reports its own cwd rather than the test asserting on what
    // was passed to spawn — the claim is about where the command actually ran.
    const result = await registry.invoke(
      'shell.exec',
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
        timeoutMs: 20_000,
      },
      FULL_ACCESS,
    );
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, new RegExp(sandbox.root.replace(/\\/g, '\\\\')));
  });
});

test('a shell command is killed at the timeout the caller supplied', async () => {
  await withShell(async (registry) => {
    const startedAt = Date.now();
    const result = await registry.invoke(
      'shell.exec',
      {
        command: process.execPath,
        // Deliberately long-running: 60s, against a 500ms limit.
        args: ['-e', 'setTimeout(() => undefined, 60000)'],
        timeoutMs: 500,
      },
      FULL_ACCESS,
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(result.isError, true);
    assert.match(result.text, /killed after timeout/);
    // The limit was honoured, not merely reported: a handler that waited for
    // the process and then labelled it timed out would take 60 seconds.
    assert.ok(elapsed < 20_000, `took ${String(elapsed)}ms, so the kill did not happen`);
  });
});

test('the spawned process does not inherit the parent environment', async () => {
  await withShell(async (registry) => {
    process.env.CHIMERA_TEST_CANARY = 'a-secret-from-the-users-shell';
    try {
      const result = await registry.invoke(
        'shell.exec',
        {
          command: process.execPath,
          args: ['-e', 'process.stdout.write(String(process.env.CHIMERA_TEST_CANARY))'],
          timeoutMs: 20_000,
        },
        FULL_ACCESS,
      );
      // Whatever the user exported before launching CHIMERA — API keys, tokens
      // — must not arrive in a process an agent chose the arguments for.
      assert.match(result.text, /undefined/);
      assert.doesNotMatch(result.text, /a-secret-from-the-users-shell/);
    } finally {
      delete process.env.CHIMERA_TEST_CANARY;
    }
  });
});

test('arguments are not re-parsed by a shell', async () => {
  await withShell(async (registry, sandbox) => {
    // If `shell: true` were set, this argument would be read as source text and
    // the second command would run. As a vector element it is just a string.
    const result = await registry.invoke(
      'shell.exec',
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("ok")', ';', 'touch', 'pwned'],
        timeoutMs: 20_000,
      },
      FULL_ACCESS,
    );
    assert.match(result.text, /ok/);
    assert.equal(fs.existsSync(path.join(sandbox.root, 'pwned')), false);
  });
});

test('an HTTP request to a host outside the allowlist makes no outbound call', async () => {
  let outbound = 0;
  const transport: HttpTransport = (url, init) => {
    outbound += 1;
    return fetch(url, init);
  };

  const registry = createToolRegistry();
  await registry.registerServer(
    'http',
    await connectInProcess(createHttpServer({ egressAllowlist: ['api.example.com'], transport })),
  );

  try {
    const result = await registry.invoke(
      'http.request',
      { url: 'https://evil.example.net/steal', method: 'GET' },
      FULL_ACCESS,
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /not in this workflow's egress allowlist/);
    assert.equal(outbound, 0, 'a request left the process for a host outside the allowlist');
  } finally {
    await registry.close();
  }
});

test('an HTTP request to an allowlisted host succeeds against a local server', async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello from the allowlisted host');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const registry = createToolRegistry();
  await registry.registerServer(
    'http',
    await connectInProcess(createHttpServer({ egressAllowlist: ['127.0.0.1'] })),
  );

  try {
    const result = await registry.invoke(
      'http.request',
      { url: `http://127.0.0.1:${String(port)}/`, method: 'GET' },
      FULL_ACCESS,
    );
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /status: 200/);
    assert.match(result.text, /hello from the allowlisted host/);
  } finally {
    await registry.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a redirect out of the allowlist is not followed', async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(302, { location: 'https://evil.example.net/collect' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const registry = createToolRegistry();
  await registry.registerServer(
    'http',
    await connectInProcess(createHttpServer({ egressAllowlist: ['127.0.0.1'] })),
  );

  try {
    const result = await registry.invoke(
      'http.request',
      { url: `http://127.0.0.1:${String(port)}/`, method: 'GET' },
      FULL_ACCESS,
    );
    // The allowlist held for the URL requested; following the redirect would
    // have carried the request to a host it never authorised.
    assert.match(result.text, /status: 302/);
    assert.match(result.text, /was not followed/);
    assert.doesNotMatch(result.text, /collect.*\n.*[Bb]ody/);
  } finally {
    await registry.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('non-http schemes are refused', async () => {
  let outbound = 0;
  const registry = createToolRegistry();
  await registry.registerServer(
    'http',
    await connectInProcess(
      createHttpServer({
        // Deliberately permissive on hosts, so the refusal below can only come
        // from the scheme check.
        egressAllowlist: ['example.com', ''],
        transport: (url, init) => {
          outbound += 1;
          return fetch(url, init);
        },
      }),
    ),
  );

  try {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x']) {
      const result = await registry.invoke('http.request', { url }, FULL_ACCESS);
      assert.equal(result.isError, true, url);
      // Asserted on the scheme message specifically: with a host-based refusal
      // this test would pass without the scheme check existing at all.
      assert.match(result.text, /Only http and https are permitted/, url);
    }
    assert.equal(outbound, 0);
  } finally {
    await registry.close();
  }
});

test('a wildcard entry covers subdomains but not the apex', () => {
  assert.equal(isHostAllowed('api.example.com', ['*.example.com']), true);
  assert.equal(isHostAllowed('deep.api.example.com', ['*.example.com']), true);
  // A wildcard that also matched the apex would silently widen every entry
  // written by someone who meant subdomains.
  assert.equal(isHostAllowed('example.com', ['*.example.com']), false);
  assert.equal(isHostAllowed('notexample.com', ['*.example.com']), false);
  assert.equal(isHostAllowed('example.com.evil.net', ['example.com']), false);
  assert.equal(isHostAllowed('API.EXAMPLE.COM', ['api.example.com']), true);
  // An empty allowlist is no network access, not open access.
  assert.equal(isHostAllowed('api.example.com', []), false);
});
