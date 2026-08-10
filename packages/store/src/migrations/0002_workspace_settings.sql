-- Workspace-scoped policy that must travel with the workspace database rather
-- than with the device. Deliberately not apps/desktop's local-settings.json:
-- that file holds cosmetic per-device preferences, and local-only mode is a
-- security posture a regulated or air-gapped buyer sets once for the workspace
-- and expects to hold wherever that workspace is opened.
--
-- Single-row by construction, same shape as `licence`.
CREATE TABLE workspace_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  local_only_mode INTEGER NOT NULL DEFAULT 0
);

INSERT INTO workspace_settings (id, local_only_mode) VALUES (1, 0);
