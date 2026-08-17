-- What the agents and the user know. F2.7's third tier, made concrete.
--
-- Deliberately not `workspace_facts` widened: that table is a small curated
-- key-value store a person maintains by hand, and this is a growing record
-- written mostly by agents during runs. Merging them would mean a user's own
-- note and an agent's guess sharing a shape, a lifecycle and a delete button —
-- and the whole value of the curated tier is that it is trustworthy because it
-- is small and human.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  -- What kind of thing this is. Fixed vocabulary so the UI can group without
  -- inventing categories from free text, and so an agent cannot fragment the
  -- store by spelling "preference" three ways.
  kind TEXT NOT NULL CHECK (
    kind IN ('fact', 'project', 'goal', 'habit', 'preference', 'decision', 'person', 'tool')
  ),
  -- The thing it is about: a project name, a person, a system. Groups the UI.
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  -- 'user' when a person wrote it, otherwise the role id that did.
  source TEXT NOT NULL,
  -- The run it was learned in, when it was learned in one. Null for a note the
  -- user typed. Lets a user ask "where did this come from" and get an answer.
  run_id TEXT,
  -- How sure the writer was, 0-1. An agent asserting something it inferred is
  -- not the same as one recording what a tool returned, and a memory store
  -- that flattens the two teaches the next agent to trust a guess.
  confidence REAL NOT NULL DEFAULT 0.6 CHECK (confidence >= 0 AND confidence <= 1),
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memories_kind ON memories(kind);
CREATE INDEX idx_memories_subject ON memories(subject);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);
