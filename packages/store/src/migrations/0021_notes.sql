-- Notes and reminders, shared between the person and the agents.
--
-- Deliberately not `workspace_facts` or `memories`, which look similar and are
-- not. Those are things an agent recorded *about* the work so that a later run
-- reads better; this is a board a person keeps and can hand to an agent, and
-- an agent can write to and the person reads. The difference that matters is
-- who it is for: memory is read by prompts, this is read by people.
--
-- One table for both kinds. A reminder is a note with a time on it, and
-- splitting them would mean two lists, two queries, and a decision every time
-- somebody adds something they might want to be reminded of later.
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  -- 'note' or 'reminder'. A reminder has a due date; a note does not.
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- ISO 8601, or null for a note. Local time as written by the person.
  due_at TEXT,
  -- ISO 8601 when it was ticked off, null while outstanding.
  done_at TEXT,
  -- Who wrote it: 'user', 'assistant', or the id of the run that did.
  -- Travels with the note into the UI, because a reminder a person set and one
  -- an automation set are not the same claim on their attention.
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The two orders anything reads this in: what is due next, and what is newest.
CREATE INDEX notes_due ON notes (done_at, due_at);
CREATE INDEX notes_recent ON notes (created_at DESC);
