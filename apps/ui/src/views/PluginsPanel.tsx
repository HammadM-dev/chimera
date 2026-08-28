import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { HowTo, Step, Steps } from './HowTo.tsx';

// Plugins: tool servers the user adds.
//
// The protocol is MCP, which is what Claude Code's plugins and most of the
// community's tool servers already speak — so "connect my email", "read my
// calendar", "open a ticket" are things somebody installs rather than things
// CHIMERA has to write. What arrives is tools, and tools are governed exactly
// as CHIMERA's own are: granted per agent, checked against the egress list, and
// treated as irreversible until a person has approved the step.

interface Plugin {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  command: string;
  url: string;
  lastError: string;
  tools: { name: string; description: string }[];
}

const BLANK = {
  name: '',
  kind: 'stdio' as 'stdio' | 'http',
  command: '',
  argsText: '',
  url: '',
  secretsText: '',
};

export function PluginsPanel({ refreshToken }: { refreshToken: number }): JSX.Element {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [draft, setDraft] = useState(BLANK);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ plugins: Plugin[] }>('plugin:list', {});
      setPlugins(result.plugins);
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const save = useCallback(async () => {
    if (draft.name.trim() === '') {
      setNote('Give it a name — the tools it brings are prefixed with it.');
      return;
    }

    // `KEY=value` a line at a time. The values go straight to the keychain and
    // never into the workspace file.
    const secrets: Record<string, string> = {};
    for (const line of draft.secretsText.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      secrets[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }

    try {
      await bridge().invoke('plugin:save', {
        name: draft.name.trim(),
        kind: draft.kind,
        command: draft.command.trim(),
        args: draft.argsText.split(/\s+/).filter((part) => part !== ''),
        url: draft.url.trim(),
        enabled: true,
        secrets,
        headers: {},
      });
      setDraft(BLANK);
      setAdding(false);
      setNote('Added. Test it to see what it brings.');
      await load();
    } catch (err) {
      setNote(describeError(err).message);
    }
  }, [draft, load]);

  const test = useCallback(
    async (id: string) => {
      setNote('Testing…');
      try {
        const result = await bridge().invoke<{ ok: boolean; detail: string; tools: number }>(
          'plugin:test',
          { id },
        );
        setNote(
          result.ok
            ? `Connected. ${String(result.tools)} tools available.`
            : `Could not connect: ${result.detail}`,
        );
        await load();
      } catch (err) {
        setNote(describeError(err).message);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await bridge().invoke('plugin:remove', { id });
        await load();
      } catch (err) {
        setNote(describeError(err).message);
      }
    },
    [load],
  );

  return (
    <div data-testid="plugins-panel">
      {plugins.length === 0 && !adding && (
        <p className="agent-card__prompt">
          Nothing plugged in. A plugin is an MCP server — the same kind Claude Code uses — and the
          tools it brings become things your agents can be granted.
        </p>
      )}

      {plugins.map((plugin) => (
        <div key={plugin.id} className="connection-row" data-testid={`plugin-${plugin.id}`}>
          <span>{plugin.name}</span>
          <span className="connection-row__meta">
            {plugin.kind === 'http' ? plugin.url : plugin.command} ·{' '}
            {plugin.tools.length === 0
              ? 'no tools yet'
              : `${String(plugin.tools.length)} tool${plugin.tools.length === 1 ? '' : 's'}: ${plugin.tools
                  .slice(0, 4)
                  .map((tool) => tool.name)
                  .join(', ')}`}
            {plugin.lastError !== '' && ` · ${plugin.lastError}`}
          </span>
          <div className="brief__left">
            <button
              type="button"
              className="button"
              data-testid={`plugin-test-${plugin.id}`}
              onClick={() => void test(plugin.id)}
            >
              Test
            </button>
            <button
              type="button"
              className="button button--destructive"
              data-testid={`plugin-remove-${plugin.id}`}
              onClick={() => void remove(plugin.id)}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {adding ? (
        <div className="connections__body">
          <div className="field">
            <label className="field__label" htmlFor="plugin-name">
              Name
            </label>
            <input
              id="plugin-name"
              className="control"
              data-testid="plugin-name"
              placeholder="gmail"
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="plugin-kind">
              How it runs
            </label>
            <select
              id="plugin-kind"
              className="control"
              data-testid="plugin-kind"
              value={draft.kind}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  kind: event.target.value as 'stdio' | 'http',
                }));
              }}
            >
              <option value="stdio">A command on this machine</option>
              <option value="http">Something already running, over HTTP</option>
            </select>
          </div>

          {draft.kind === 'stdio' ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor="plugin-command">
                  Command
                </label>
                <input
                  id="plugin-command"
                  className="control"
                  data-testid="plugin-command"
                  placeholder="npx"
                  value={draft.command}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, command: event.target.value }));
                  }}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="plugin-args">
                  Arguments
                </label>
                <input
                  id="plugin-args"
                  className="control"
                  data-testid="plugin-args"
                  placeholder="-y @modelcontextprotocol/server-gmail"
                  value={draft.argsText}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, argsText: event.target.value }));
                  }}
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor="plugin-url">
                Address
              </label>
              <input
                id="plugin-url"
                className="control"
                data-testid="plugin-url"
                placeholder="http://localhost:3000/mcp"
                value={draft.url}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, url: event.target.value }));
                }}
              />
            </div>
          )}

          <div className="field">
            <label className="field__label" htmlFor="plugin-secrets">
              Keys it needs
            </label>
            <textarea
              id="plugin-secrets"
              className="canvas__instruction"
              data-testid="plugin-secrets"
              rows={3}
              placeholder={'GMAIL_TOKEN=…\nONE PER LINE'}
              value={draft.secretsText}
              onChange={(event) => {
                setDraft((current) => ({ ...current, secretsText: event.target.value }));
              }}
            />
            <p className="agent-card__prompt">
              One `NAME=value` per line. Values go to your OS keychain, never into the workspace
              file, and the plugin gets them as environment variables — nothing else from your
              environment is passed on.
            </p>
          </div>

          <div className="brief__left">
            <HowTo label="Not sure how? Show me the steps">
              <Steps>
                <Step>
                  A plugin is an <strong>MCP server</strong> — the same kind of tool server Claude
                  Code uses. It is a program on this machine that CHIMERA starts and talks to, and
                  the tools it offers become tools your agents can be granted.
                </Step>
                <Step>
                  Find one. Most are published on npm and run with <code>npx</code> — their README
                  gives the exact command, usually something like{' '}
                  <code>npx -y @some/mcp-server</code>.
                </Step>
                <Step>
                  Put the program in <strong>Command</strong> and everything after it in{' '}
                  <strong>Arguments</strong>, one per line. For the example above, the command is{' '}
                  <code>npx</code> and the arguments are <code>-y</code> and{' '}
                  <code>@some/mcp-server</code>.
                </Step>
                <Step>
                  If it needs a key, put it in <strong>Secrets</strong> as <code>NAME=value</code>,
                  one per line — the name is whatever its README calls the environment variable.
                  Keys go to your OS keychain, never into the workspace file.
                </Step>
                <Step>
                  Add it, then press <strong>Check</strong>. It reports how many tools the server
                  offered, which is how you know it started and answered.
                </Step>
                <Step>
                  Open <strong>Agents</strong>, edit or build an agent, and tick the plugin&apos;s
                  tools under &quot;what it may use&quot;. An agent only gets what you grant it.
                </Step>
              </Steps>
            </HowTo>

            <button
              type="button"
              className="button button--primary"
              data-testid="plugin-save"
              onClick={() => void save()}
            >
              Add plugin
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="button"
          data-testid="plugin-add"
          onClick={() => {
            setAdding(true);
          }}
        >
          Add a plugin
        </button>
      )}

      {note !== '' && <p className="agent-card__prompt">{note}</p>}
    </div>
  );
}
