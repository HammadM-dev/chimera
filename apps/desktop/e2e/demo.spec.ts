import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { Entry } from '@napi-rs/keyring';
import { deleteSecret, type AuthRef } from '@chimera/store';
import { freshProfile, launchApp, removeProfile } from './support/app.ts';

// docs/ROADMAP.md M0-11, the milestone exit criterion: "app launches, stores a
// secret in OS keychain, plays the intro." The intro is covered by
// splash.spec.ts and the hardened window by security.spec.ts; this is the
// store-and-read-back half, driven through the real preload bridge rather than
// by calling packages/store directly, so it exercises the path a feature would
// actually take.

interface ChimeraBridge {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  parseError: (
    err: unknown,
  ) => { code: string; message: string; details: Record<string, unknown> } | null;
}

// Same probe as packages/store/src/vault.test.ts: a real keychain, skipped
// rather than faked where no keyring daemon exists (some CI runners).
function keychainAvailable(): boolean {
  try {
    const probe = new Entry('chimera-e2e-probe', `probe-${String(Date.now())}`);
    probe.setPassword('probe');
    probe.deletePassword();
    return true;
  } catch {
    return false;
  }
}

const skip = keychainAvailable() ? false : 'no OS keychain daemon available in this environment';

test.describe('M0-11 milestone demo', () => {
  test('the app stores a secret in the OS keychain through the preload bridge and reads it back', async () => {
    test.skip(skip !== false, typeof skip === 'string' ? skip : '');

    const profile = freshProfile();
    const app = await launchApp({ profile });
    let handle: string | undefined;

    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const secret = `sk-m0-11-demo-${String(Date.now())}`;

      const stored = await page.evaluate(async (value) => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        return (await chimera.invoke('vault:setSecret', {
          scope: 'connection',
          value,
        })) as { handle: string };
      }, secret);

      handle = stored.handle;

      // A vault handle, not the secret. docs/SECURITY.md section 3.
      expect(handle).toMatch(
        /^vault:connection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(handle).not.toContain(secret);

      // Read back across the same bridge.
      const check = await page.evaluate(async (h) => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        return (await chimera.invoke('vault:hasSecret', { handle: h })) as { exists: boolean };
      }, handle);
      expect(check.exists).toBe(true);

      // ...and it is genuinely in the OS keychain, not just in the app's memory.
      expect(new Entry('chimera', handle).getPassword()).toBe(secret);
    } finally {
      if (handle) deleteSecret(handle as AuthRef);
      await app.close();
      removeProfile(profile);
    }
  });

  test('the app creates its SQLite database with migrations applied and WAL enabled', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const dbPath = path.join(profile, 'chimera.sqlite');
      expect(fs.existsSync(dbPath)).toBe(true);

      // Opened read-only alongside the running app — which is the point of WAL
      // (docs/ARCHITECTURE.md section 5: the run view reads while the engine
      // writes), so this assertion also demonstrates the property it checks.
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(db.pragma('journal_mode', { simple: true })).toBe('wal');

        // Introspected with the table_list pragma rather than a SELECT against
        // sqlite_master, because CLAUDE.md's "all SQLite access through
        // packages/store" has no carve-out for test files and should not grow
        // one — scripts/check-no-raw-sql.mjs caught this exact line when it was
        // written as a query, which is the guard working.
        //
        // Deliberately narrow: this asserts only that the *app* created its
        // database at the right path and ran its migrations on startup. The
        // full twelve-table column-by-column assertion is M0-5's, and lives in
        // packages/store's own tests where the raw SQL belongs.
        const tables = (db.pragma('table_list') as Array<{ name: string; schema: string }>)
          .filter((row) => row.schema === 'main')
          .map((row) => row.name);
        expect(tables).toContain('_migrations');
        expect(tables).toContain('workflows');
        expect(tables).toContain('connections');
      } finally {
        db.close();
      }
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('a secret value never appears in the IPC log line for the channel that carries it', async () => {
    test.skip(skip !== false, typeof skip === 'string' ? skip : '');

    const profile = freshProfile();
    const app = await launchApp({ profile });
    let mainOutput = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      mainOutput += chunk.toString();
    });

    let handle: string | undefined;
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      const canary = `sk-canary-${String(Date.now())}-must-not-reach-a-log-line`;
      const stored = await page.evaluate(async (value) => {
        const chimera = (window as unknown as { chimera: ChimeraBridge }).chimera;
        return (await chimera.invoke('vault:setSecret', {
          scope: 'connection',
          value,
        })) as { handle: string };
      }, canary);
      handle = stored.handle;

      // The dispatcher logs every invoke. vault:setSecret is flagged
      // sensitive, so its payload is redacted — this asserts the flag is
      // actually wired to the redaction, on the one channel where getting it
      // wrong writes a live credential to stdout.
      expect(mainOutput).toContain('vault:setSecret');
      expect(mainOutput).not.toContain(canary);
    } finally {
      if (handle) deleteSecret(handle as AuthRef);
      await app.close();
      removeProfile(profile);
    }
  });
});
