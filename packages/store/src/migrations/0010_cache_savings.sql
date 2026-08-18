-- What the cache saved, and whether the workspace wants one.
--
-- The saving is on the run because that is where the rest of the money is, and
-- because "this run cost $0.02 and skipped $0.40" is one sentence about one
-- run. The policy is on the settings row beside the tier map: both are
-- workspace-wide answers to "how should runs behave here".
--
-- Exact reuse is safe by construction — the identical prompt to the identical
-- model. Semantic reuse answers a *similar* prompt, which is a claim about
-- meaning rather than about determinism, so it starts off and stays off until
-- somebody turns it on.
ALTER TABLE runs ADD COLUMN saved_by_cache_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE workspace_settings ADD COLUMN cache_policy_json TEXT NOT NULL DEFAULT '{}';
