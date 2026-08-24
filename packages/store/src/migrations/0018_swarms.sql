-- Swarm runs, and the conversation each one becomes.
--
-- A swarm is not a run of an automation and does not belong in `runs`: it has
-- no steps, no node states and no graph, and it keeps going after it finishes —
-- the person asks it another question and the same population answers again.
-- What it is, is a conversation with a simulated crowd, so it is stored as one.
--
-- `name` is written by a model from the first question and can be renamed by
-- the user, the same way a chat thread is named. `seed` makes a run repeatable:
-- the same seed rebuilds the same population, which is what lets somebody run
-- it twice and get the same answer.
CREATE TABLE IF NOT EXISTS swarms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  question    TEXT NOT NULL,
  seed        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- 'manual' when a person started it, or the run id when an automation did.
  -- That is how a swarm node on a canvas links to the section it created.
  source      TEXT NOT NULL DEFAULT 'manual',
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS swarms_by_updated ON swarms (updated_at DESC);

-- One row per question asked of the population, and what came back.
--
-- `result_json` holds the whole simulation: the personas, every round, what was
-- said, and the distribution. It is a document rather than a set of columns
-- because nothing queries inside it — a swarm is read whole or not at all — and
-- because the shape will change as the simulation does.
CREATE TABLE IF NOT EXISTS swarm_turns (
  id          TEXT PRIMARY KEY,
  swarm_id    TEXT NOT NULL REFERENCES swarms(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  asked       TEXT NOT NULL,
  answer      TEXT NOT NULL,
  result_json TEXT NOT NULL,
  cost_usd    REAL NOT NULL DEFAULT 0,
  tokens      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS swarm_turns_by_swarm ON swarm_turns (swarm_id, seq);
