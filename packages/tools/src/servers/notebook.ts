import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Notes and reminders, as tools.
//
// The board is shared ground: the person writes on it and so do the agents, and
// both read it. That is the whole reason it exists as a section rather than as
// one more thing only the person sees — an assistant that notices a licence
// expires next month should be able to leave that where somebody will find it,
// and an automation asked to follow something up should be able to say so
// somewhere other than a run trace nobody opens.
//
// Deliberately not `memory`. Memory is written for prompts: it is what a later
// run reads to work better. This is written for people. Conflating them means
// either burying somebody's reminder among an agent's working notes, or filling
// a person's board with things an agent wrote to remind *itself*.
//
// Writes here are contained rather than irreversible: a note is a row on a
// board the person is looking at, with an edit and a delete next to it. That is
// the same call `memory.remember` gets, for the same reason.

export interface Note {
  id: string;
  kind: 'note' | 'reminder';
  title: string;
  body: string;
  dueAt: string | null;
  doneAt: string | null;
  source: string;
}

export interface NotebookBackend {
  list: (input: { includeDone: boolean }) => Note[];
  add: (input: {
    kind: 'note' | 'reminder';
    title: string;
    body: string;
    dueAt: string | null;
  }) => Note;
  update: (input: {
    id: string;
    title?: string;
    body?: string;
    dueAt?: string | null;
    done?: boolean;
  }) => Note | undefined;
}

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function failure(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createNotebookServer(backend: NotebookBackend): McpServer {
  const server = new McpServer({ name: 'chimera-notebook', version: '0.0.0' });

  server.registerTool(
    'list',
    {
      description:
        'Reads the notes and reminders on this workspace’s board — the ones the person wrote and the ones agents left. Check here before asking the person something they may already have written down.',
      inputSchema: {
        includeDone: z
          .boolean()
          .optional()
          .describe('Include things already ticked off. Off by default.'),
      },
    },
    ({ includeDone }) => text(backend.list({ includeDone: includeDone === true })),
  );

  server.registerTool(
    'add',
    {
      description:
        'Puts a note or a reminder on the board, where the person will see it. Use this for something they need to know or do later — not for your own working notes, which belong in memory. A reminder needs a date; a note does not.',
      inputSchema: {
        kind: z.enum(['note', 'reminder']).describe('A reminder has a date. A note does not.'),
        title: z.string().describe('One line. This is what they read in the list.'),
        body: z.string().optional().describe('The rest of it, if there is more to say.'),
        dueAt: z
          .string()
          .optional()
          .describe('When it is due, as an ISO 8601 date-time. Reminders only.'),
      },
    },
    ({ kind, title, body, dueAt }) => {
      if (title.trim() === '') return failure('A note needs a title — it is the line they read.');
      if (kind === 'reminder' && (dueAt ?? '') === '') {
        return failure('A reminder needs a date. Give `dueAt`, or add it as a note instead.');
      }
      try {
        return text(
          backend.add({ kind, title, body: body ?? '', dueAt: kind === 'reminder' ? (dueAt ?? null) : null }),
        );
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'update',
    {
      description:
        'Changes something already on the board, or ticks it off. Use the id `list` gave you. Ticking something off is how you record that it is handled — deleting it would take away the evidence that it was.',
      inputSchema: {
        id: z.string().describe('The note’s id, exactly as `list` returned it.'),
        title: z.string().optional(),
        body: z.string().optional(),
        dueAt: z.string().optional().describe('A new date, as ISO 8601.'),
        done: z.boolean().optional().describe('True to tick it off, false to put it back.'),
      },
    },
    ({ id, title, body, dueAt, done }) => {
      const changed = backend.update({
        id,
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        ...(dueAt === undefined ? {} : { dueAt }),
        ...(done === undefined ? {} : { done }),
      });
      return changed === undefined
        ? failure(`There is no note with id "${id}". Use \`list\` to see what is on the board.`)
        : text(changed);
    },
  );

  return server;
}
