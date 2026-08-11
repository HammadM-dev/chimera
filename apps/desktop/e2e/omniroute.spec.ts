import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// M1-7 end to end. The stub speaks the OpenAI-shaped `/v1/models` OmniRoute
// exposes; everything above it — the IPC channels, the detection service, the
// adapter, the repository write — is the real thing.

interface Stub {
  baseUrl: string;
  /** Starts listening. Split from creation so a test can begin with the port dead. */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

async function makeStub(modelIds: string[]): Promise<Stub> {
  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, name: id })) }));
      return;
    }
    res.writeHead(404).end();
  });

  // Claim a port, then release it, so the "nothing is listening" case can use a
  // URL that is genuinely dead and later becomes live at the same address.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    start: () => new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
}

test.describe('M1-7 OmniRoute detection and guided setup', () => {
  test('detects a running instance and imports exactly one connection', async () => {
    const stub = await makeStub(['omni/opus', 'omni/haiku', 'omni/local']);
    await stub.start();
    const profile = freshProfile();
    const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
        timeout: 15_000,
      });
      await expect(page.getByTestId('omniroute-found')).toContainText('3 models');

      await page.getByTestId('omniroute-import').click();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
        timeout: 15_000,
      });

      // The row is real: it comes back through connection:list, which reads
      // SQLite through the registry rather than any in-memory state the UI kept.
      const omniroute = await page.evaluate(async () => {
        const chimera = (
          window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).chimera;
        const result = (await chimera.invoke('connection:list', {})) as {
          connections: { id: string; kind: string; label: string }[];
        };
        return result.connections.filter((connection) => connection.kind === 'omniroute');
      });
      expect(omniroute).toHaveLength(1);

      // Importing twice must not leave two identical connections behind:
      // re-running detection is the documented recovery path.
      const afterSecondImport = await page.evaluate(async () => {
        const chimera = (
          window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).chimera;
        await chimera.invoke('omniroute:import', {});
        const result = (await chimera.invoke('connection:list', {})) as {
          connections: { kind: string }[];
        };
        return result.connections.filter((connection) => connection.kind === 'omniroute').length;
      });
      expect(afterSecondImport).toBe(1);
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('an imported connection is usable immediately, with its models, no restart', async () => {
    // The bug this exists for: import reported "211 models" and the chat panel
    // went on showing an empty picker until the app was restarted, because
    // nothing told it to re-read. From the outside that is indistinguishable
    // from an import that did nothing. No reload in this test, deliberately.
    const stub = await makeStub(['gpt-4o-mini', 'claude-haiku-4-5', 'llama-3.3-70b']);
    await stub.start();
    const profile = freshProfile();
    const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
        timeout: 15_000,
      });

      // Before the import there is nothing to chat with.
      await expect(page.getByTestId('connection-select')).toContainText('No connections yet');

      await page.getByTestId('omniroute-import').click();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
        timeout: 15_000,
      });

      // Immediately selectable — no reload, no restart.
      await expect(page.getByTestId('connection-select')).toContainText('OmniRoute', {
        timeout: 10_000,
      });

      // And the imported models are offered, rather than the user having to
      // type an exact id from memory against a gateway serving hundreds.
      const modelControl = page.getByTestId('model-input');
      await expect(modelControl).toHaveJSProperty('tagName', 'SELECT');
      const offered = await modelControl.locator('option').allTextContents();
      expect(offered.sort()).toEqual(['claude-haiku-4-5', 'gpt-4o-mini', 'llama-3.3-70b']);
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('shows install guidance rather than an error when nothing is listening', async () => {
    const stub = await makeStub([]);
    const profile = freshProfile();
    const pageErrors: string[] = [];
    const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

    try {
      const page = await app.firstWindow();
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute(
        'data-phase',
        'not-detected',
        { timeout: 15_000 },
      );
      await expect(page.getByTestId('omniroute-guidance')).toContainText('Install it');
      // Guidance, not a failure: no error surface, no thrown renderer error.
      await expect(page.getByTestId('omniroute-detail')).toHaveCount(0);
      expect(pageErrors, `renderer threw: ${pageErrors.join('; ')}`).toEqual([]);

      // And no connection was invented for an instance that is not there.
      const count = await page.evaluate(async () => {
        const chimera = (
          window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).chimera;
        const result = (await chimera.invoke('connection:list', {})) as {
          connections: { kind: string }[];
        };
        return result.connections.filter((connection) => connection.kind === 'omniroute').length;
      });
      expect(count).toBe(0);
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });

  test('picks up an instance started mid-flow, without restarting the app', async () => {
    const stub = await makeStub(['omni/sonnet', 'omni/haiku']);
    const profile = freshProfile();
    const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: stub.baseUrl } });

    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute(
        'data-phase',
        'not-detected',
        { timeout: 15_000 },
      );

      // The user installs and starts OmniRoute while CHIMERA is open.
      await stub.start();
      await page.getByTestId('omniroute-recheck').click();

      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
        timeout: 15_000,
      });
      await page.getByTestId('omniroute-import').click();
      await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
        timeout: 15_000,
      });
      await expect(page.getByTestId('omniroute-ready')).toContainText('2 models');
    } finally {
      await app.close();
      removeProfile(profile);
      await stub.close();
    }
  });
});
