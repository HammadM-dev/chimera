-- Composio: one account per workspace.
--
-- A workspace is one Composio "user", so the apps somebody connects once are
-- reachable by every automation in that workspace — which is what they mean
-- when they connect their Gmail and expect their automations to use it.
--
-- The key is in the OS keychain; this holds the handle and the user id, and the
-- user id never changes once set: change it and every connected app becomes
-- unreachable with no error that says why.
ALTER TABLE workspace_settings ADD COLUMN composio_json TEXT NOT NULL DEFAULT '{}';
