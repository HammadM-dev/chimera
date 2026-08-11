-- Roles are workspace-level configuration, not per-workflow: the same
-- `researcher` is used by every workflow in a workspace, and a user who tightens
-- its allowlist expects that to hold everywhere at once. Hence a table here
-- rather than a blob inside each workflow version.
--
-- The JSON columns hold shapes owned by packages/core (allowlist, model
-- binding, budget, output contract). packages/store deliberately does not know
-- what is inside them — same discipline as connections.capabilities_json — so
-- that the role vocabulary can change without a migration every time.
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tool_allowlist_json TEXT NOT NULL,
  model_binding_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  output_contract_json TEXT NOT NULL,
  max_iterations INTEGER NOT NULL,
  -- A starter role shipped by CHIMERA. Kept so a future version can add a new
  -- starter role, or repair one the user has not touched, without overwriting
  -- an edit the user made.
  is_builtin INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
