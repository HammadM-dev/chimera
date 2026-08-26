import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotebookServer, type Note, type NotebookBackend } from './notebook.ts';
import { connectInProcess } from '../mcpClient.ts';
import { isIrreversible } from '../reversibility.ts';

// The notes board, as tools an agent can use.

function backend(): NotebookBackend & { rows: Note[] } {
  const rows: Note[] = [];
  return {
    rows,
    list: ({ includeDone }) => rows.filter((row) => includeDone || row.doneAt === null),
    add: ({ kind, title, body, dueAt }) => {
      const note: Note = {
        id: `n${String(rows.length)}`,
        kind,
        title,
        body,
        dueAt,
        doneAt: null,
        source: 'assistant',
      };
      rows.push(note);
      return note;
    },
    update: ({ id, title, done }) => {
      const found = rows.find((row) => row.id === id);
      if (!found) return undefined;
      if (title !== undefined) found.title = title;
      if (done !== undefined) found.doneAt = done ? '2026-08-26T00:00:00.000Z' : null;
      return found;
    },
  };
}

async function client(store: NotebookBackend) {
  return connectInProcess(createNotebookServer(store));
}

test('an agent can leave a note where the person will find it', async () => {
  const store = backend();
  const connected = await client(store);
  try {
    const result = await connected.callTool('add', {
      kind: 'note',
      title: 'The Stripe key expires on 3 October',
      body: 'Seen while reading the billing page.',
    });
    assert.equal(result.isError, false);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0]?.title, 'The Stripe key expires on 3 October');
  } finally {
    await connected.close();
  }
});

test('a reminder without a date is refused, with the fix in the message', async () => {
  // Otherwise it silently becomes a note, and the person is not reminded of
  // the thing they were told they would be reminded of.
  const store = backend();
  const connected = await client(store);
  try {
    const result = await connected.callTool('add', { kind: 'reminder', title: 'Chase the invoice' });
    assert.equal(result.isError, true);
    assert.match(result.text, /needs a date/);
    assert.match(result.text, /add it as a note instead/);
    assert.equal(store.rows.length, 0);
  } finally {
    await connected.close();
  }
});

test('a note with no title is refused', async () => {
  const store = backend();
  const connected = await client(store);
  try {
    const result = await connected.callTool('add', { kind: 'note', title: '   ' });
    assert.equal(result.isError, true);
    assert.equal(store.rows.length, 0);
  } finally {
    await connected.close();
  }
});

test('done things are out of the list unless asked for', async () => {
  const store = backend();
  const connected = await client(store);
  try {
    await connected.callTool('add', { kind: 'note', title: 'One' });
    await connected.callTool('add', { kind: 'note', title: 'Two' });
    await connected.callTool('update', { id: 'n0', done: true });

    const open = await connected.callTool('list', {});
    assert.doesNotMatch(open.text, /"One"/);
    assert.match(open.text, /"Two"/);

    const all = await connected.callTool('list', { includeDone: true });
    assert.match(all.text, /"One"/);
  } finally {
    await connected.close();
  }
});

test('updating a note that is not there says so rather than failing silently', async () => {
  const store = backend();
  const connected = await client(store);
  try {
    const result = await connected.callTool('update', { id: 'nope', done: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /no note with id "nope"/);
  } finally {
    await connected.close();
  }
});

test('writing to the board needs no approval, and that is deliberate', () => {
  // A note is a row on a board the person is looking at, with an edit and a
  // delete beside it — the same call `memory.remember` gets. Gating it would
  // mean an assistant that spotted something worth writing down had to
  // interrupt somebody to ask permission to write it down.
  assert.equal(isIrreversible('notebook.add'), false);
  assert.equal(isIrreversible('notebook.update'), false);
  assert.equal(isIrreversible('notebook.list'), false);

  // And a tool on that server that nobody has classified is still refused,
  // rather than inheriting the family's answer.
  assert.equal(isIrreversible('notebook.deleteEverything'), true);
});
