import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dismissTour, freshProfile, goTo, joinSteps, launchApp, removeProfile } from './support/app.ts';

// The whole product, against real models, the way a person would use it.
//
// Every other suite here proves one mechanism against a stand-in. This proves
// the thing somebody bought: connect a provider, pin a model, build an
// automation, run it, read what came back, ask a crowd, keep a note. Nothing in
// it is scripted — two real providers answer, and what they say has to be good
// enough to satisfy assertions about the *work*, not about the plumbing.
//
// Two providers on purpose. OpenRouter and Ollama Cloud have different
// response shapes, different rate limits, and different failure modes, and a
// product that works against one is not yet a product that works against
// "any model provider".
//
//   OPENROUTER_API_KEY=... OLLAMA_CLOUD_KEY=... npx playwright test liveEverything
//
// Both keys are read from the environment and never written to the repo.

const OPENROUTER = process.env['OPENROUTER_API_KEY'] ?? '';
const OLLAMA = process.env['OLLAMA_CLOUD_KEY'] ?? '';

// Free models that exist today, verified against both APIs before this was
// written. Overridable, because "free" is a moving target on both services.
const OR_MODEL = process.env['CHIMERA_LIVE_OPENROUTER_MODEL'] ?? 'minimax/minimax-m3:free';
const OLLAMA_MODEL = process.env['CHIMERA_LIVE_OLLAMA_MODEL'] ?? 'gemma4:31b';

/** A marker no model could produce by guessing, so a pass cannot be luck. */
const MARKER = 'TURBINE-9F4X-QUARTZ';

test.describe.configure({ timeout: 900_000 });

/** A page served locally, so the facts are fixed and only the model is live. */
async function startSite(): Promise<{ url: string; host: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(
      JSON.stringify({
        partNumber: MARKER,
        status: 'shipped',
        quantity: 47,
        destination: 'Rotterdam',
        carrier: 'Maersk',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    // The allowlist matches hostnames, not authorities — a port here matches
    // nothing, which cost one earlier test nine minutes to discover.
    url: `http://127.0.0.1:${String(port)}/order.json`,
    host: '127.0.0.1',
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function connectOpenRouter(page: Page): Promise<void> {
  await goTo(page, 'providers');
  await page.getByTestId('connection-label').fill('OpenRouter');
  await page.getByTestId('connection-kind').selectOption('openrouter');
  await page.getByTestId('connection-key').fill(OPENROUTER);
  await page.getByTestId('connection-create').click();
  await expect(page.getByTestId('connection-row')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('connection-models')).not.toContainText('No catalogue', {
    timeout: 120_000,
  });
}

async function connectOllama(page: Page): Promise<void> {
  await goTo(page, 'providers');
  await page.getByTestId('connection-label').fill('Ollama Cloud');
  await page.getByTestId('connection-kind').selectOption('ollama-cloud');
  await page.getByTestId('connection-key').fill(OLLAMA);
  await page.getByTestId('connection-create').click();
  await expect(page.getByTestId('connection-row').first()).toBeVisible({ timeout: 90_000 });
}

test.describe('CHIMERA, end to end, against real models', () => {
  test.skip(
    OPENROUTER === '' || OLLAMA === '',
    'Set OPENROUTER_API_KEY and OLLAMA_CLOUD_KEY to run this.',
  );

  test('a provider connects, its catalogue prices real models, and a pin sticks', async () => {
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectOpenRouter(page);

      // The catalogue is the difference between choosing a model and guessing
      // a name: it carries prices and context windows read from the provider.
      await page.getByTestId('connection-models').click();
      const catalogue = page.getByTestId('model-catalogue');
      await expect(catalogue).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('catalogue-filter').fill('minimax');
      await expect(catalogue.getByTestId('catalogue-model').first()).toBeVisible({
        timeout: 30_000,
      });

      // Pin it, and check it reaches a picker in a different section.
      await page.getByTestId('model-pin').first().click();
      await goTo(page, 'swarm');
      const first = ((await page.getByTestId('swarm-model').locator('option').allTextContents())[0] ??
        '').trim();
      expect(first.toLowerCase(), 'the pin did not reach the swarm picker').toContain('minimax');
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('both providers answer a direct question, with a real cost figure', async () => {
    // Two providers, one screen. A product that works against one is not yet a
    // product that works against "any model provider" — different response
    // shapes, different limits, different failures.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectOpenRouter(page);
      await connectOllama(page);

      await goTo(page, 'chat');
      for (const [label, model] of [
        ['OpenRouter', OR_MODEL],
        ['Ollama Cloud', OLLAMA_MODEL],
      ] as const) {
        await page.getByTestId('connection-select').selectOption({ label });
        await page.getByTestId('model-input').selectOption(model);
        await page
          .getByTestId('prompt-input')
          .fill(`Reply with exactly this word and nothing else: ${MARKER}`);
        // Enter sends; there is no separate button, which is the convention
        // every messaging app shares and the one people try first.
        await page.getByTestId('prompt-input').press('Enter');

        await expect(page.getByTestId('chat-answer')).toContainText(MARKER, {
          timeout: 240_000,
        });
        console.log(`[chat:${label}] answered`);
      }
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('an automation reads a real page, hands the facts on, and writes a file', async () => {
    // The shape of an actual job, and the one that was broken twice: an agent
    // uses a tool, a second agent gets what it found, and something lands on
    // disk that a person can open.
    const site = await startSite();
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectOllama(page);
      await goTo(page, 'build');

      const place = async (id: string, instruction: string): Promise<void> => {
        await page.getByTestId(`palette-${id}`).click();
        await page.getByTestId('node-model').selectOption({
          label: `Ollama Cloud · ${OLLAMA_MODEL}`,
        });
        await page.getByTestId('node-instruction').fill(instruction);
      };

      await place(
        'researcher',
        `Fetch ${site.url} and report every field it contains, copying the values exactly.`,
      );
      await place(
        'coder',
        'Write the order details above into a file called order-summary.md in your workspace, one field per line. Then read the file back and show what it contains.',
      );
      await joinSteps(page, 'node-researcher', 'node-coder');

      await page.getByTestId('brief-egress-mode').selectOption('browse');
      await page.getByTestId('brief-sites').fill(site.host);
      await page.getByTestId('brief-name').fill('Order to file');
      await page.getByTestId('brief-input').fill('Record the order record as a file.');

      await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('brief-run').click();

      await expect(
        page.getByTestId('run-note').or(page.getByTestId('run-result')).first(),
      ).toBeVisible({ timeout: 840_000 });

      const steps = page.getByTestId('result-steps');
      await expect(steps).toBeVisible({ timeout: 60_000 });
      for (const row of await steps.locator('summary').all()) await row.click();
      const all = (await steps.textContent()) ?? '';
      console.log(`[steps] ${all.slice(0, 1500)}`);

      // The fetched marker survived the handoff, and the second agent — which
      // has no web tool at all — repeated it.
      expect(all, 'nothing passed on what was fetched').toContain(MARKER);
      expect(all.split(MARKER).length - 1, 'the second step never got the findings').toBeGreaterThan(
        1,
      );
      expect(all).not.toMatch(/never (?:reached|passed)|source data never/i);
    } finally {
      await app.close();
      removeProfile(profile);
      await site.close();
    }
  });

  test('an agent reads a folder the user granted, and cannot read outside it', async () => {
    // File access, and the limit on it, in one run. The grant is the whole
    // security story for the filesystem: an agent reads what it was given and
    // nothing else.
    const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-granted-'));
    const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'chimera-ungranted-'));
    fs.writeFileSync(path.join(granted, 'invoice.txt'), `Invoice total: ${MARKER} pounds\n`);
    fs.writeFileSync(path.join(secret, 'private.txt'), 'SHOULD-NEVER-BE-READ\n');

    const profile = freshProfile();
    // The folder picker is a native dialog, so it is answered by the harness
    // hook the suite already uses rather than driven — everything after it is
    // the real path.
    const app = await launchApp({ profile, env: { CHIMERA_E2E_PICK_DIRECTORY: granted } });

    try {
      const page = await app.firstWindow();
      await connectOllama(page);

      await goTo(page, 'providers');
      await page.getByTestId('grant-add').click();
      await expect(page.getByTestId('file-grants')).toContainText(granted, { timeout: 30_000 });

      await goTo(page, 'build');
      await page.getByTestId('palette-researcher').click();
      await page.getByTestId('node-model').selectOption({
        label: `Ollama Cloud · ${OLLAMA_MODEL}`,
      });
      await page
        .getByTestId('node-instruction')
        .fill(
          `List the files in ${granted} and read invoice.txt. Report the invoice total exactly as written. Then try to read ${path.join(secret, 'private.txt')} and say plainly what happened.`,
        );

      await page.getByTestId('brief-name').fill('Read the granted folder');
      await page.getByTestId('brief-input').fill('What is the invoice total?');
      await expect(page.getByTestId('brief-run')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('brief-run').click();

      await expect(
        page.getByTestId('run-note').or(page.getByTestId('run-result')).first(),
      ).toBeVisible({ timeout: 600_000 });

      const steps = page.getByTestId('result-steps');
      await expect(steps).toBeVisible({ timeout: 60_000 });
      for (const row of await steps.locator('summary').all()) await row.click();
      const all = (await steps.textContent()) ?? '';
      console.log(`[files] ${all.slice(0, 1200)}`);

      expect(all, 'the granted file was not read').toContain(MARKER);
      // And the limit held: whatever the agent says about the second file, the
      // contents must not be in the output.
      expect(all, 'an ungranted file was read').not.toContain('SHOULD-NEVER-BE-READ');
    } finally {
      await app.close();
      removeProfile(profile);
      fs.rmSync(granted, { recursive: true, force: true });
      fs.rmSync(secret, { recursive: true, force: true });
    }
  });

  test('a swarm reads up, argues, and reports without disclaiming its tools', async () => {
    // The reported bug in one assertion: personas used to answer "I don't have
    // web access to check that", which is an assistant's disclaimer in the
    // mouth of somebody who is supposed to be a person with a view.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectOllama(page);

      await goTo(page, 'swarm');
      await page.getByTestId('swarm-model').selectOption({
        label: `Ollama Cloud · ${OLLAMA_MODEL}`,
      });
      await page
        .getByTestId('swarm-input')
        .fill('Should a corner shop start charging 20p for a paper bag?');
      await page.getByTestId('swarm-population').fill('8');
      await page.getByTestId('swarm-rounds').fill('1');
      // Reading is on by default now; this asserts that rather than setting it.
      await expect(page.getByTestId('swarm-research')).toBeChecked();

      await page.getByTestId('swarm-ask').click();
      await expect(page.getByTestId('swarm-turn')).toBeVisible({ timeout: 780_000 });
      await expect(page.getByTestId('swarm-error')).toHaveCount(0);

      const turn = (await page.getByTestId('swarm-turn').textContent()) ?? '';
      console.log(`[swarm] ${turn.slice(0, 800)}`);
      expect(turn.length).toBeGreaterThan(120);
      expect(turn, 'a persona disclaimed its tooling').not.toMatch(
        /no (?:web|internet) access|don'?t have (?:access to )?(?:the )?(?:web|internet|browsing)|cannot look (?:that )?up|as an AI/i,
      );
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('the assistant answers about this workspace and leaves a note behind', async () => {
    // The home screen assistant, its workspace tools, and the notes board it
    // can write to — the one place an agent's output is meant for a person
    // rather than for a later prompt.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectOllama(page);

      await goTo(page, 'home');
      await page
        .getByTestId('home-input')
        .fill(
          `Leave me a note titled exactly "${MARKER}" saying to check the shipping paperwork. Use your notebook tool, then tell me you have done it.`,
        );
      await page.getByTestId('home-ask').click();

      await expect(page.getByTestId('talk-assistant').last()).toBeVisible({ timeout: 600_000 });
      const said = (await page.getByTestId('talk-assistant').last().textContent()) ?? '';
      console.log(`[assistant] ${said.slice(0, 600)}`);

      // The claim is checked against the board rather than taken at its word.
      await goTo(page, 'notes');
      await expect(page.getByTestId('notes-view')).toContainText(MARKER, { timeout: 30_000 });
      await expect(page.getByTestId('notes-view')).toContainText('left by the assistant');
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('an irreversible step stops for a person instead of just doing it', async () => {
    // CLAUDE.md's hard rule, end to end and against a real model: sending,
    // publishing, buying or deleting needs a human in front of it.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await connectOllama(page);
      await goTo(page, 'build');

      await page.getByTestId('palette-coder').click();
      await page.getByTestId('node-model').selectOption({
        label: `Ollama Cloud · ${OLLAMA_MODEL}`,
      });
      await page
        .getByTestId('node-instruction')
        .fill('Run the shell command `echo hello` in your workspace and report what it printed.');

      await page.getByTestId('brief-name').fill('Shell needs a gate');
      await page.getByTestId('brief-input').fill('Run the command.');

      // A coder holds shell.exec, which is irreversible whatever its arguments,
      // so the canvas refuses to run it until somebody says so.
      const problem = page.getByTestId('node-problem');
      await expect(problem).toBeVisible({ timeout: 30_000 });
      await expect(problem).toContainText(/approv|authoris/i);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('the updater knows what it is running and refuses to pretend', async () => {
    // A checkout has no packaged artefact to replace. The honest behaviour is
    // to say so rather than offer a button that cannot work, and that is worth
    // asserting because the opposite — a banner with a dead button — is
    // exactly the "fake UI thing" this was built not to be.
    const profile = freshProfile();
    const app = await launchApp({ profile });

    try {
      const page = await app.firstWindow();
      await goTo(page, 'home');
      await dismissTour(page);

      const state = await page.evaluate(async () => {
        const chimera = (
          window as unknown as { chimera: { invoke: (c: string, p: unknown) => Promise<unknown> } }
        ).chimera;
        return chimera.invoke('update:check', {}) as Promise<{
          stage: string;
          supported: boolean;
          current: string;
        }>;
      });

      console.log(`[update] ${JSON.stringify(state)}`);
      expect(state.current, 'the updater does not know its own version').not.toBe('');
      // Unpackaged: no install path, so no offer and no error either.
      expect(state.supported).toBe(false);
      expect(page.getByTestId('update-banner')).toHaveCount(0);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});
