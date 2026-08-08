-- Initial schema. Forward-only — see docs/ARCHITECTURE.md section 5 for the
-- migration convention and the full column-by-column rationale per table.
-- A schema mistake is corrected by a new migration, never by editing this
-- file after it has shipped.

CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  latest_version_id TEXT,
  production_version_id TEXT,
  archived_at TEXT
);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  version_number INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  tag TEXT
);

CREATE INDEX idx_workflow_versions_workflow_id ON workflow_versions(workflow_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  trigger_type TEXT NOT NULL,
  input_json TEXT NOT NULL,
  budget_tokens_used INTEGER NOT NULL DEFAULT 0,
  budget_cost_usd_used REAL NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX idx_runs_workflow_id ON runs(workflow_id);
CREATE INDEX idx_runs_status ON runs(status);

CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL
);

CREATE INDEX idx_traces_run_id_seq ON traces(run_id, seq);

CREATE TABLE node_states (
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_used REAL NOT NULL DEFAULT 0,
  checkpoint_json TEXT,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE cache (
  key_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  embedding BLOB,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  workflow_id TEXT REFERENCES workflows(id)
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  auth_ref TEXT NOT NULL,
  capabilities_json TEXT,
  health_state TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE licence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tier TEXT NOT NULL,
  activation_token_ref TEXT,
  activated_at TEXT,
  grace_expires_at TEXT,
  seat_id TEXT
);

CREATE TABLE blackboard_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  role_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  written_at TEXT NOT NULL,
  scope TEXT NOT NULL
);

CREATE INDEX idx_blackboard_entries_run_id ON blackboard_entries(run_id);

CREATE TABLE dead_letter (
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  item_json TEXT NOT NULL,
  error TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE INDEX idx_dead_letter_run_id ON dead_letter(run_id);

-- evals: which eval cases exist for a workflow (mirrors the workflow
-- definition's own evals[] array — see docs/WORKFLOW_SCHEMA.md). eval_runs:
-- the results of actually running them. eval_runs is scoped to a specific
-- workflow_version_id, not just workflow_id, because the production-tagging
-- gate (docs/ARCHITECTURE.md section 5) needs to check "this version's most
-- recent eval results," not "any past run of any version."
CREATE TABLE evals (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  eval_id TEXT NOT NULL,
  PRIMARY KEY (workflow_id, eval_id)
);

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  eval_id TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  pass_fail TEXT NOT NULL,
  assertions_json TEXT NOT NULL,
  provider TEXT NOT NULL
);

CREATE INDEX idx_eval_runs_workflow_version_id ON eval_runs(workflow_version_id);
