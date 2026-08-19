-- Folders the user has given CHIMERA read access to.
--
-- A grant is explicit, per folder, and readable only: nothing here makes
-- anywhere writable, and the sandbox has no code path that would. Stored as
-- the path the user chose rather than its resolved form, so a revoke matches
-- what they were shown; resolution happens per run, where a folder that has
-- since moved is simply dropped.
CREATE TABLE file_grants (
  path TEXT PRIMARY KEY,
  granted_at TEXT NOT NULL
);
