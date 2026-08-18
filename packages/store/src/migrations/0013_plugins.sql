-- Plugins: MCP servers the user has added.
--
-- The same protocol CHIMERA's own tool servers speak, which is the point — the
-- community already ships servers for email, calendars, issue trackers and
-- databases, and this is how a user reaches them without CHIMERA writing an
-- integration per service.
--
-- The command and its arguments are stored plainly because they are what the
-- user typed. Anything secret goes in `env_json` by *name*, resolved from the
-- vault at connect time: CLAUDE.md's rule is that secrets never land in SQLite,
-- and a plugin's API key is a secret like any other.
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- 'stdio' spawns a process; 'http' talks to something already running.
  kind TEXT NOT NULL CHECK (kind IN ('stdio', 'http')),
  command TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  -- { "SOME_VAR": "vault:plugin:<id>:<name>" } — handles, never values.
  env_json TEXT NOT NULL DEFAULT '{}',
  headers_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- What it advertised the last time it connected, so the agent editor can
  -- offer its tools without starting every plugin to draw a list.
  tools_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
