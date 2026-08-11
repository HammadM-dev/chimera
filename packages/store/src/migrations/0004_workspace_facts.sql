-- Curated, user-editable facts that outlive any single run (F2.7's second
-- memory tier). Workspace-scoped like `roles`: a fact learned by one run is
-- available to every later run in the same workspace.
--
-- Deliberately not the `cache` table: that is derived data with an eviction
-- policy, and this is knowledge a person may have typed in by hand. Evicting a
-- user's own note to make room for a cached embedding would be indefensible.
CREATE TABLE workspace_facts (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  -- Where it came from: 'user' for a person, or the run id that wrote it.
  -- Kept so the UI can show what an agent asserted separately from what the
  -- user stated, which are not equally trustworthy.
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
