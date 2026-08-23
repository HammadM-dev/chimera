import { test, expect } from '@playwright/test';
import { freshProfile, goTo, joinSteps, launchApp, removeProfile } from './support/app.ts';

// A real automation, against a real model, reading a real website, checked
// against what that website actually said.
//
// Everything else in this suite proves the machinery: a stub answers what the
// adapter expects, the graph runs, the events arrive. None of it can tell you
// whether the product does the job somebody bought it for — whether three
// agents, handed one another's work, end up with the facts that were on the
// page. That is what this asks, and it asks it of Hacker News because the
// front page changes every hour: nothing here can pass from a fixture.
//
//   CHIMERA_LIVE_KEY=<ollama cloud key> npx playwright test e2e/liveResearch.spec.ts

const KEY = process.env['CHIMERA_LIVE_KEY'] ?? '';
const MODEL = process.env['CHIMERA_LIVE_MODEL'] ?? 'gpt-oss:120b';

test.skip(KEY === '', 'set CHIMERA_LIVE_KEY to run against Ollama Cloud');
test.describe.configure({ timeout: 900_000 });

/** What the site says right now, read directly, so the run has something to be wrong about. */
async function frontPage(): Promise<{ titles: string[]; scores: number[] }> {
  const html = await (await fetch('https://news.ycombinator.com/')).text();
  const titles = [...html.matchAll(/<span class="titleline"><a[^>]*>(.*?)<\/a>/g)]
    .map((match) => (match[1] ?? '').replace(/<[^>]+>/g, '').trim())
    .slice(0, 8);
  const scores = [...html.matchAll(/<span class="score"[^>]*>(\d+) points/g)]
    .map((match) => Number(match[1]))
    .slice(0, 8);
  return { titles, scores };
}

test('three agents research a live page and hand the facts down the chain', async () => {
  const truth = await frontPage();
  expect(truth.titles.length, 'the source page could not be read').toBeGreaterThan(4);

  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await page.getByTestId('connection-label').fill('Ollama Cloud');
    await page.getByTestId('connection-kind').selectOption('ollama-cloud');
    await page.getByTestId('connection-key').fill(KEY);
    await page.getByTestId('connection-create').click();
    await expect(page.getByTestId('connection-row')).toContainText('models', { timeout: 60_000 });

    await goTo(page, 'build');

    const place = async (id: string, instruction: string) => {
      await page.getByTestId(`palette-${id}`).click();
      await page.getByTestId('node-model').selectOption({ label: `Ollama Cloud · ${MODEL}` });
      await page.getByTestId('node-instruction').fill(instruction);
    };

    // The shape of an actual job: one agent gets the material, one turns it
    // into records, one writes the thing a person reads.
    await place(
      'researcher',
      'Fetch https://news.ycombinator.com/ and report the top 5 stories exactly as listed, each with its title and its points score. Copy the titles and numbers from the page.',
    );
    await place(
      'data-extractor',
      'Turn the stories above into records. One record per story, with the title and the points as a number.',
    );
    await place(
      'summariser',
      'In three sentences, say what the top stories are about and which has the most points. Name it and give its score.',
    );

    await joinSteps(page, 'node-researcher', 'node-data-extractor');
    await joinSteps(page, 'node-data-extractor', 'node-summariser');

    await page.getByTestId('brief-name').fill('Front page briefing');
    await page
      .getByTestId('brief-input')
      .fill('What is on the Hacker News front page right now, and which story is leading?');

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    // Long, because this is three agents on a hosted model doing real work.
    // The note lands first and the result section with it; `.first()` because
    // both are on screen at once and either one means the run is over.
    await expect(
      page.getByTestId('run-note').or(page.getByTestId('run-result')).first(),
    ).toBeVisible({ timeout: 840_000 });

    const note =
      (await page
        .getByTestId('run-note')
        .textContent()
        .catch(() => '')) ?? '';
    expect(note, `the run reported: ${note}`).not.toMatch(
      /could not read|not valid JSON|token budget|no tools/i,
    );

    // What each step ended up as, printed before anything is asserted: when a
    // live run goes wrong the useful information is why, and a bare "expected
    // succeeded, got exhausted" sends you back to run it again to find out.
    for (const id of ['node-researcher', 'node-data-extractor', 'node-summariser']) {
      console.log(`[step] ${(await page.getByTestId(id).textContent()) ?? ''}`);
    }

    const failing = await Promise.all(
      ['node-researcher', 'node-data-extractor', 'node-summariser'].map(async (id) => ({
        id,
        text: (await page.getByTestId(id).textContent()) ?? '',
      })),
    );
    if (failing.some((step) => !step.text.includes('succeeded'))) {
      await goTo(page, 'runs');
      await page
        .getByTestId('trace-events')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      const events = await page
        .getByTestId('trace-events')
        .textContent()
        .catch(() => '');
      console.log(`\n--- trace ---\n${(events ?? '').slice(0, 6000)}`);
      const failures = await page
        .getByTestId('run-failures')
        .textContent()
        .catch(() => '');
      if (failures !== null && failures !== '') console.log(`\n--- failures ---\n${failures}`);
    }

    // Every step got somewhere. A chain where the middle failed and the end
    // wrote something anyway is the failure this whole test exists to catch.
    for (const step of failing) {
      expect(step.text, `${step.id} did not succeed`).toMatch(/succeeded/);
    }

    const output = (await page.getByTestId('run-result').textContent()) ?? '';
    // Printed, because this is the one test whose answer a person wants to
    // read rather than merely see pass. It is opt-in and runs alone.
    console.log(`\n--- what the automation produced ---\n${output}\n--- the page said ---`);
    for (const [index, title] of truth.titles.slice(0, 5).entries()) {
      console.log(`${String(truth.scores[index] ?? '?')} points  ${title}`);
    }
    expect(output.length, 'the run produced nothing').toBeGreaterThan(80);

    // The point of the whole exercise: is what came out what was on the page?
    // Matched on distinctive words rather than whole titles — a summariser is
    // allowed to shorten a headline, and is not allowed to invent one.
    const distinctive = truth.titles
      .flatMap((title) => title.split(/[^A-Za-z0-9]+/))
      .filter((word) => word.length > 5)
      .map((word) => word.toLowerCase());
    const found = distinctive.filter((word) => output.toLowerCase().includes(word));
    expect(
      found.length,
      `nothing from the real front page reached the output.\n\nreal titles:\n${truth.titles.join('\n')}\n\noutput:\n${output}`,
    ).toBeGreaterThan(2);

    // And a real score from the page, not a plausible-looking number.
    const numbers = [...output.matchAll(/\b(\d{2,4})\b/g)].map((match) => Number(match[1]));
    expect(
      numbers.some((value) => truth.scores.includes(value)),
      `no points score in the output matches the page. real: ${truth.scores.join(', ')}\n\noutput:\n${output}`,
    ).toBe(true);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

// The other half of what a person actually builds: a planner at the front, and
// a researcher given a question rather than a link.
//
// Both are things that were reported broken. The planner failed with the
// gateway's JSON error envelope printed on screen, and then succeeded when the
// same automation was run again unchanged. The researcher could only read pages
// somebody had already found for it, which is the research done by hand.

test('a planner leads, and a researcher finds its own sources', async () => {
  const profile = freshProfile();
  const app = await launchApp({ profile });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await page.getByTestId('connection-label').fill('Ollama Cloud');
    await page.getByTestId('connection-kind').selectOption('ollama-cloud');
    await page.getByTestId('connection-key').fill(KEY);
    await page.getByTestId('connection-create').click();
    await expect(page.getByTestId('connection-row')).toContainText('models', { timeout: 60_000 });

    await goTo(page, 'build');

    const place = async (id: string, instruction: string) => {
      await page.getByTestId(`palette-${id}`).click();
      await page.getByTestId('node-model').selectOption({ label: `Ollama Cloud · ${MODEL}` });
      await page.getByTestId('node-instruction').fill(instruction);
    };

    await place('planner', 'Break this into the steps needed to answer it.');
    // No URL. Finding one is the job.
    await place(
      'researcher',
      'Find the current Bank of England base rate and the date it was last changed. Give the figure, the date, and where you got them.',
    );
    await place(
      'summariser',
      'Write two lines for a finance channel: the rate, and when it changed.',
    );

    await joinSteps(page, 'node-planner', 'node-researcher');
    await joinSteps(page, 'node-researcher', 'node-summariser');

    await page.getByTestId('brief-name').fill('Rate check');
    await page
      .getByTestId('brief-input')
      .fill('What is the Bank of England base rate right now, and when did it last change?');

    await expect(page.getByTestId('brief-run')).toBeEnabled();
    await page.getByTestId('brief-run').click();

    await expect(
      page.getByTestId('run-note').or(page.getByTestId('run-result')).first(),
    ).toBeVisible({ timeout: 840_000 });

    for (const id of ['node-planner', 'node-researcher', 'node-summariser']) {
      console.log(`[step] ${(await page.getByTestId(id).textContent()) ?? ''}`);
    }

    const note =
      (await page
        .getByTestId('run-note')
        .textContent()
        .catch(() => '')) ?? '';
    // The two shapes the planner failed in: the gateway's raw error envelope,
    // and a verification it could not satisfy because it has no tools to cite.
    expect(note, `the run reported: ${note}`).not.toMatch(/"type":|"param":|token budget/i);

    const steps = await Promise.all(
      ['node-planner', 'node-researcher', 'node-summariser'].map(async (id) => ({
        id,
        text: (await page.getByTestId(id).textContent()) ?? '',
      })),
    );
    if (steps.some((step) => !step.text.includes('succeeded'))) {
      await goTo(page, 'runs');
      await page
        .getByTestId('trace-events')
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => undefined);
      const events = await page
        .getByTestId('trace-events')
        .textContent()
        .catch(() => '');
      console.log(`\n--- trace ---\n${(events ?? '').slice(0, 6000)}`);
      await goTo(page, 'build');
    }

    for (const step of steps) {
      expect(step.text, `${step.id} did not succeed`).toMatch(/succeeded/);
    }

    const output = (await page.getByTestId('run-result').textContent()) ?? '';
    console.log(`\n--- what the automation produced ---\n${output}`);
    // A rate is a number with a percent sign. An answer without one has not
    // answered the question, whatever else it says.
    expect(output, 'no rate in the output').toMatch(/\d(\.\d+)?\s?%/);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});
