import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { bridge, describeError } from '../chat/useChimera.ts';
import { describeSource, exactDue, readDue } from './noteTime.ts';
import './notes.css';

// Notes and reminders: the one surface in CHIMERA that two kinds of author
// write to.
//
// That is the whole design. Every other notes app has one author, so authorship
// is not a dimension worth showing; here it is the most useful thing on the
// card. A line you wrote is unmarked, because it is yours and that is the
// default. A line an agent left carries a rail and says what left it — an
// assistant that noticed a key expires next month, an automation that was asked
// to follow something up. The alternative is a board where you cannot tell your
// own handwriting from your software's.
//
// Grouped by when rather than by kind, because "what needs doing" is the
// question people bring to a board like this, and "note or reminder" is not.
// Groups render only when they hold something: four headings over four single
// items is filing, not structure.

interface Note {
  id: string;
  kind: 'note' | 'reminder';
  title: string;
  body: string;
  dueAt: string | null;
  doneAt: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** `2026-09-01T09:00` for the datetime input, from an ISO instant. */
function forInput(iso: string | null): string {
  if (iso === null || iso === '') return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function Card({
  note,
  onToggle,
  onEdit,
  onRemove,
}: {
  note: Note;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const due = readDue(note.dueAt);
  const done = note.doneAt !== null;
  const wrote = describeSource(note.source);
  const state = done ? 'done' : due.late ? 'late' : due.today ? 'today' : 'open';

  return (
    <article className="note" data-state={state} data-testid={`note-${note.id}`}>
      <button
        type="button"
        className="note__tick"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Put "${note.title}" back` : `Tick off "${note.title}"`}
        data-testid="note-tick"
        onClick={onToggle}
      >
        {done && (
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path
              d="M3 8.5 6.5 12 13 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      <div className="note__body">
        <p className="note__title">{note.title}</p>
        {note.body !== '' && <p className="note__detail">{note.body}</p>}

        <p className="note__meta">
          {due.label !== '' && (
            <span className="note__due" title={exactDue(note.dueAt)}>
              {due.label}
            </span>
          )}
          {/* Provenance, and the reason this board is not a to-do list. Absent
              for your own lines: marking those would be marking everything. */}
          {wrote !== '' && <span className="note__who">{wrote}</span>}
        </p>
      </div>

      <div className="note__actions">
        <button type="button" className="note__act" data-testid="note-edit" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="note__act act--destructive"
          data-testid="note-remove"
          onClick={onRemove}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

export function NotesView(): JSX.Element {
  const [notes, setNotes] = useState<Note[]>([]);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await bridge().invoke<{ notes: Note[] }>('note:list', {});
      setNotes(result.notes);
    } catch (err) {
      setError(describeError(err).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = useCallback(() => {
    setEditing(null);
    setTitle('');
    setBody('');
    setDueAt('');
  }, []);

  const save = useCallback(async () => {
    const written = title.trim();
    if (written === '') return;
    setError('');
    try {
      await bridge().invoke('note:save', {
        ...(editing === null ? {} : { id: editing }),
        // A date is what makes it a reminder. The button says so, so nobody has
        // to be taught the distinction — they just set a date or they do not.
        kind: dueAt === '' ? 'note' : 'reminder',
        title: written,
        body: body.trim(),
        dueAt: dueAt === '' ? null : new Date(dueAt).toISOString(),
      });
      reset();
      await load();
    } catch (err) {
      setError(describeError(err).message);
    }
  }, [body, dueAt, editing, load, reset, title]);

  const toggle = useCallback(
    async (note: Note) => {
      try {
        await bridge().invoke('note:done', { id: note.id, done: note.doneAt === null });
        await load();
      } catch (err) {
        setError(describeError(err).message);
      }
    },
    [load],
  );

  const remove = useCallback(
    async (note: Note) => {
      try {
        await bridge().invoke('note:remove', { id: note.id });
        if (editing === note.id) reset();
        await load();
      } catch (err) {
        setError(describeError(err).message);
      }
    },
    [editing, load, reset],
  );

  const edit = useCallback((note: Note) => {
    setEditing(note.id);
    setTitle(note.title);
    setBody(note.body);
    setDueAt(forInput(note.dueAt));
  }, []);

  const groups = useMemo(() => {
    const open = notes.filter((note) => note.doneAt === null);
    const late = open.filter((note) => readDue(note.dueAt).late);
    const dated = open.filter((note) => note.dueAt !== null && !readDue(note.dueAt).late);
    const plain = open.filter((note) => note.dueAt === null);
    const done = notes.filter((note) => note.doneAt !== null);

    return [
      { key: 'late', label: 'Overdue', notes: late },
      { key: 'coming', label: 'Coming up', notes: dated },
      { key: 'notes', label: 'Notes', notes: plain },
      ...(showDone ? [{ key: 'done', label: 'Done', notes: done }] : []),
    ].filter((group) => group.notes.length > 0);
  }, [notes, showDone]);

  const outstanding = notes.filter((note) => note.doneAt === null).length;
  const doneCount = notes.length - outstanding;

  return (
    <div className="notes scroll" data-testid="notes-view">
      {/* No heading here: the shell already puts "Notes" above this. Two of
          them is a stutter, and the one that stays is the one that is not
          truncated by the frame. */}
      <header className="notes__head">
        <div className="notes__lede">
          <p className="notes__sub">
            Yours and your agents’. The assistant and your automations can leave notes and reminders
            here too, and you can edit anything on the board whoever wrote it.
          </p>
        </div>
        <span className="notes__count" data-testid="notes-count">
          {outstanding === 0 ? 'nothing outstanding' : `${String(outstanding)} outstanding`}
        </span>
      </header>

      <section className="composer" data-testid="note-composer">
        <input
          className="control composer__title"
          data-testid="note-title"
          placeholder={editing === null ? 'Write a note' : 'Editing'}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void save();
            }
            if (event.key === 'Escape') reset();
          }}
        />

        {(title !== '' || editing !== null) && (
          <>
            <textarea
              className="control composer__body"
              data-testid="note-body"
              rows={2}
              placeholder="Anything more (optional)"
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
              }}
            />

            <div className="composer__row">
              <label className="composer__when">
                Remind me
                <input
                  type="datetime-local"
                  className="control"
                  data-testid="note-due"
                  value={dueAt}
                  onChange={(event) => {
                    setDueAt(event.target.value);
                  }}
                />
              </label>

              {/* The button names what will happen, and it changes as the date
                  does — which is how somebody learns the difference between the
                  two without being told it. */}
              <button
                type="button"
                className="button button--primary"
                data-testid="note-save"
                disabled={title.trim() === ''}
                onClick={() => void save()}
              >
                {editing !== null ? 'Save changes' : dueAt === '' ? 'Add note' : 'Add reminder'}
              </button>

              {editing !== null && (
                <button type="button" className="button button--quiet" onClick={reset}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </section>

      {error !== '' && (
        <p className="connections__error" data-testid="notes-error">
          {error}
        </p>
      )}

      {groups.length === 0 && (
        <div className="notes__empty" data-testid="notes-empty">
          <p>
            Nothing on the board yet. Write something above — or ask the assistant to. It can leave
            notes and reminders here, and so can your automations.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} className="notes__group" data-testid={`notes-group-${group.key}`}>
          <header className="notes__groupHead">
            <span>{group.label}</span>
            <span className="notes__groupCount">{group.notes.length}</span>
          </header>
          {group.notes.map((note) => (
            <Card
              key={note.id}
              note={note}
              onToggle={() => void toggle(note)}
              onEdit={() => {
                edit(note);
              }}
              onRemove={() => void remove(note)}
            />
          ))}
        </section>
      ))}

      {doneCount > 0 && (
        <button
          type="button"
          className="notes__reveal"
          data-testid="notes-show-done"
          onClick={() => {
            setShowDone(!showDone);
          }}
        >
          {showDone ? 'Hide' : 'Show'} {doneCount} done
        </button>
      )}
    </div>
  );
}
