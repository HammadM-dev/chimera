-- Who spent it, and on what.
--
-- `node_states` has carried tokens and cost since 0001, but not the two facts a
-- person actually asks about a bill: which agent, and which model. Deriving
-- them at read time means re-parsing every run's definition and every trace
-- event, which is the difference between a cost view that opens instantly and
-- one nobody waits for.
--
-- Nullable: rows written before this migration have no answer, and inventing
-- one would be worse than an honest "unattributed" line in the dashboard.
ALTER TABLE node_states ADD COLUMN role_id TEXT;
ALTER TABLE node_states ADD COLUMN model TEXT;
