import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freshProfile, goTo, launchApp, removeProfile } from './support/app.ts';

// The assistant on the home screen, and what it can see.
//
// It used to be able to design an automation and nothing else: ask what your
// last run cost, or which of your agents can send email, and it had no way to
// find out. Nothing was missing from the database — it simply had no door.
//
// Two things are checked, and the second is the one that would be easy to lose.
// That it can read the workspace, and that it can still design an automation,
// which is what the home screen was for before any of this.

test.describe.configure({ timeout: 240_000 });

/**
 * A gateway that plays an agent using its tools.
 *
 * Scripted rather than a real model, because the subject is whether the tools
 * exist and return the workspace — not whether a model chooses to call them.
 */
async function startGateway(): Promise<{
  baseUrl: string;
  toolsOffered: () => string[];
  close: () => Promise<void>;
}> {
  let offered: string[] = [];

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/models') === true) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as {
          tools?: { function?: { name?: string } }[];
        };
        const names = (parsed.tools ?? [])
          .map((tool) => tool.function?.name ?? '')
          .filter((name) => name !== '');
        if (names.length > 0) offered = names;
      } catch {
        // Not the request we are inspecting.
      }

      // The planner is a different agent with its own prompt, reached through
      // `workspace.planAutomation`. Without this the design tool called a real
      // planner against this stub, which answered with a tool call rather than
      // a plan, and the design silently failed.
      if (body.includes('You design automations for CHIMERA')) {
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(
          JSON.stringify({
            id: 'pl-1',
            model: 'claude-haiku-4-5',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    name: 'Page watch',
                    summary: 'Watch a page and say when it changes.',
                    steps: [
                      {
                        id: 'read',
                        roleId: 'researcher',
                        instruction: 'Open the page and report what it says now.',
                      },
                      {
                        id: 'compare',
                        roleId: 'reviewer',
                        instruction: 'Say what changed since last time, or that nothing did.',
                      },
                    ],
                    edges: [['read', 'compare']],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 300, completion_tokens: 90 },
          }),
        );
        return;
      }

      const asksForVerdict = body.includes('Has the task been achieved');
      // Whether the agent has already been given what the tool returned.
      const sawAgents = body.includes('"role":"tool"') && body.includes('Researcher');
      // Keyed on the user's own words. Matching "design" anywhere was wrong in a
      // way worth recording: the assistant's *system prompt* says "you read, you
      // explain, and you design", so every request looked like a request to
      // design one — including the question about agents.
      const wantsDesign = body.includes('watches a page');

      const toolCall = (name: string, args: unknown): unknown => ({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: `call-${String(Date.now())}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });

      const message = asksForVerdict
        ? {
            role: 'assistant',
            content: '{"verified": true, "evidence": "answered from the tools"}',
          }
        : body.includes('Page watch')
          ? {
              role: 'assistant',
              content:
                'I designed “Page watch”: a researcher reads the page, a reviewer says what changed.',
            }
          : sawAgents
            ? {
                role: 'assistant',
                content: 'You have a Researcher, and it can search the web and fetch pages.',
              }
            : wantsDesign
              ? toolCall('workspace__planAutomation', {
                  description: 'Watch a page and email me when it changes',
                })
              : toolCall('workspace__agents', {});

      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          id: 'as-1',
          model: 'claude-haiku-4-5',
          choices: [{ index: 0, message, finish_reason: 'stop' }],
          usage: { prompt_tokens: 200, completion_tokens: 40 },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    toolsOffered: () => offered,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the assistant can read this workspace and answer from it', async () => {
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 20_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 20_000,
    });

    await goTo(page, 'home');
    await page.getByTestId('home-input').fill('Which of my agents can search the web?');
    await page.getByTestId('home-ask').click();

    // The question stays on screen as a turn, which is what makes it a
    // conversation rather than a box that swallows what you typed.
    await expect(page.getByTestId('talk-user')).toContainText('Which of my agents', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('talk-assistant').last()).toContainText('Researcher', {
      timeout: 120_000,
    });

    // The whole workspace was on offer, not just a plan tool. These are the
    // doors that did not exist before.
    const tools = gateway.toolsOffered();
    for (const wanted of [
      'workspace__automations',
      'workspace__agents',
      'workspace__runs',
      'workspace__notes',
      'workspace__providers',
      'workspace__planAutomation',
    ]) {
      expect(tools, `the assistant was not offered ${wanted}`).toContain(wanted);
    }

    // And nothing that writes. The assistant reads, explains and designs; an
    // assistant that could edit the workspace while discussing it would need a
    // confirmation on every turn.
    for (const forbidden of ['filesystem__writeFile', 'shell__exec', 'memory__remember']) {
      expect(tools, `the assistant should not have ${forbidden}`).not.toContain(forbidden);
    }
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});

test('asking the assistant to build something still produces an automation', async () => {
  // The thing the home screen could already do, and the thing most easily lost
  // in making it do more.
  const gateway = await startGateway();
  const profile = freshProfile();
  const app = await launchApp({ profile, env: { CHIMERA_OMNIROUTE_BASE_URL: gateway.baseUrl } });

  try {
    const page = await app.firstWindow();

    await goTo(page, 'providers');
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'detected', {
      timeout: 20_000,
    });
    await page.getByTestId('omniroute-import').click();
    await expect(page.getByTestId('omniroute-setup')).toHaveAttribute('data-phase', 'ready', {
      timeout: 20_000,
    });

    await goTo(page, 'home');
    await page
      .getByTestId('home-input')
      .fill('Please design an automation that watches a page and emails me when it changes.');
    await page.getByTestId('home-ask').click();

    // The design comes back as a plan the user can open, not as a paragraph
    // describing one.
    await expect(page.getByTestId('home-plan')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('home-open-plan')).toBeEnabled();
  } finally {
    await app.close();
    removeProfile(profile);
    await gateway.close();
  }
});
