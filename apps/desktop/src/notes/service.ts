import { notesRepository, type NoteRecord } from '@chimera/store';
import type { NotebookBackend } from '@chimera/tools';
import { getStore } from '../store/lifecycle.ts';

// The notes board, on the desktop side.
//
// Thin on purpose: the repository holds the rules about what a note is and the
// tool server holds the rules about what an agent may say to it. This is the
// join, plus the one decision neither of them can make — who is writing.

export function listNotes(input?: { includeDone?: boolean }): { notes: NoteRecord[] } {
  return {
    notes: notesRepository.list(getStore(), { includeDone: input?.includeDone !== false }),
  };
}

export function saveNote(input: {
  id?: string;
  kind: 'note' | 'reminder';
  title: string;
  body?: string;
  dueAt?: string | null;
  done?: boolean;
}): { note: NoteRecord | null } {
  const db = getStore();

  if (input.id !== undefined && input.id !== '') {
    return {
      note:
        notesRepository.update(db, input.id, {
          kind: input.kind,
          title: input.title,
          body: input.body ?? '',
          dueAt: input.dueAt ?? null,
          ...(input.done === undefined ? {} : { done: input.done }),
        }) ?? null,
    };
  }

  return {
    note: notesRepository.create(db, {
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      dueAt: input.dueAt ?? null,
      // Written from this channel means written by the person. An agent's
      // notes arrive through the tool server below and say so.
      source: 'user',
    }),
  };
}

export function setNoteDone(input: { id: string; done: boolean }): { note: NoteRecord | null } {
  return { note: notesRepository.update(getStore(), input.id, { done: input.done }) ?? null };
}

export function removeNote(input: { id: string }): { removed: boolean } {
  return notesRepository.remove(getStore(), input.id);
}

/**
 * The board, as an agent sees it.
 *
 * `writer` is who gets the credit: `assistant` for the home screen, the run id
 * for anything in an automation. It is not a decoration — a reminder a person
 * set and one an automation set are different claims on somebody's attention,
 * and the board says which is which.
 */
export function notebookBackend(writer: string): NotebookBackend {
  return {
    list: ({ includeDone }) =>
      notesRepository.list(getStore(), { includeDone }).map((note) => ({
        id: note.id,
        kind: note.kind,
        title: note.title,
        body: note.body,
        dueAt: note.dueAt,
        doneAt: note.doneAt,
        source: note.source,
      })),

    add: ({ kind, title, body, dueAt }) => {
      const created = notesRepository.create(getStore(), {
        kind,
        title,
        body,
        dueAt,
        source: writer,
      });
      return {
        id: created.id,
        kind: created.kind,
        title: created.title,
        body: created.body,
        dueAt: created.dueAt,
        doneAt: created.doneAt,
        source: created.source,
      };
    },

    update: (input) => {
      const changed = notesRepository.update(getStore(), input.id, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
        ...(input.done === undefined ? {} : { done: input.done }),
      });
      return changed === undefined
        ? undefined
        : {
            id: changed.id,
            kind: changed.kind,
            title: changed.title,
            body: changed.body,
            dueAt: changed.dueAt,
            doneAt: changed.doneAt,
            source: changed.source,
          };
    },
  };
}
