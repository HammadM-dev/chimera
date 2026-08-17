-- Items a fan-out could not process, kept rather than counted.
--
-- 0001 created a `dead_letter` table ahead of the feature that would use it,
-- with no primary key and no record of *which* item failed. M5-1 is that
-- feature, and it needs both: a report over a thousand items has to be
-- readable in the order the user's own list is in, and a row you cannot
-- address is a row you cannot remove once it is dealt with.
--
-- Recreated rather than altered. SQLite cannot add a primary key to an
-- existing table, and nothing has ever written to this one — the table has
-- been empty in every workspace since it was created, so there is nothing to
-- migrate and no reason to keep the shape.
DROP TABLE IF EXISTS dead_letter;

CREATE TABLE dead_letter (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  -- The fan-out node the item belonged to, not the body step that failed. The
  -- body step is named in `error`; the node is what a user recognises.
  node_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  -- The item itself, not a reference to it: "item 47" means nothing a day
  -- later, and the array it came from is not kept anywhere else.
  item_json TEXT NOT NULL,
  error TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE INDEX idx_dead_letter_run ON dead_letter(run_id, node_id);
