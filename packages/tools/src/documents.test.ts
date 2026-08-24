import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDocument, kindOf } from './documents.ts';
import { readAnyDocument, DocumentReadError } from './documentReader.ts';

// Real files of every type, built here rather than committed as fixtures.
//
// A committed .xlsx is a binary blob nobody reviews, and the thing worth
// checking is not "does this parse" but "does what comes out match what went
// in" — which needs the input to be written down in the test, in the test's own
// terms. So the spreadsheet is built by the same library that reads it, and the
// zip and the deck are built as the zips they are.

const dir = mkdtempSync(path.join(tmpdir(), 'chimera-docs-'));
process.on('exit', () => {
  rmSync(dir, { recursive: true, force: true });
});

async function makeSpreadsheet(): Promise<string> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  const sheet = workbook.addWorksheet('Invoices');
  sheet.addRow(['Supplier', 'Invoice', 'Date', 'Total']);
  sheet.addRow(['Acme Ltd', 'INV-901', new Date(Date.UTC(2026, 5, 1)), 1240]);
  sheet.addRow(['Beta Co', 'INV-902', new Date(Date.UTC(2026, 5, 14)), 880.5]);
  const target = path.join(dir, 'invoices.xlsx');
  await workbook.xlsx.writeFile(target);
  return target;
}

/** A .pptx is a zip of XML; the text is in `<a:t>` elements and nothing else. */
function makeDeck(): Promise<string> {
  const target = path.join(dir, 'deck.pptx');
  const slide = (title: string, body: string): string =>
    `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>` +
    `<a:p><a:r><a:t>${title}</a:t></a:r></a:p><a:p><a:r><a:t>${body}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

  return zipInto(target, [
    ['ppt/slides/slide1.xml', slide('Quarterly review', 'Revenue up 14 per cent')],
    ['ppt/slides/slide2.xml', slide('Next steps', 'Hire two engineers')],
    // Not a slide, and must not be read as one.
    ['ppt/notesSlides/notesSlide1.xml', `<a:t>Do not read this out</a:t>`],
  ]);
}

function makeArchive(): Promise<string> {
  return zipInto(path.join(dir, 'bundle.zip'), [
    ['readme.txt', 'hello'],
    ['data/rows.csv', 'a,b\n1,2\n'],
  ]);
}

/** Writes a zip with stored (uncompressed) entries. Enough for yauzl to read. */
function zipInto(target: string, entries: [string, string][]): Promise<string> {
  // Hand-built rather than a writer dependency: stored entries need no
  // compressor, and it keeps the test's inputs inspectable.
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, body] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(body, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(target, Buffer.concat([...chunks, centralBuf, end]));
  return Promise.resolve(target);
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

test('a spreadsheet keeps its rows and columns', async () => {
  const target = await makeSpreadsheet();
  const result = await readDocument(target, 20_000);

  assert.equal(result.kind, 'spreadsheet');
  assert.match(result.text, /# Sheet: Invoices/);
  // Tab-separated, so the extractor can see which column a value is in. This is
  // the whole reason a spreadsheet parser was worth four dependencies.
  assert.match(result.text, /Acme Ltd\tINV-901\t2026-06-01\t1240/);
  assert.match(result.text, /Beta Co\tINV-902\t2026-06-14\t880\.5/);
});

test('a date comes out as the date the sheet says', async () => {
  const target = await makeSpreadsheet();
  const result = await readDocument(target, 20_000);

  // `cell.text` renders a date as `Date.toString()`, so this cell arrived as
  // "Mon Jun 01 2026 01:00:00 GMT+0100 (British Summer Time)". An extractor told
  // to copy the value and not guess would copy exactly that, and anything
  // downstream taking the day off the front gets the wrong day west of UTC.
  assert.equal(result.text.includes('GMT'), false);
  assert.equal(result.text.includes('00:00:00'), false);
  assert.match(result.text, /2026-06-01/);
});

test('a deck comes out slide by slide, and speaker notes do not', async () => {
  const target = await makeDeck();
  const result = await readDocument(target, 20_000);

  assert.equal(result.kind, 'slides');
  assert.match(result.text, /\[slide 1\]\nQuarterly review Revenue up 14 per cent/);
  assert.match(result.text, /\[slide 2\]\nNext steps Hire two engineers/);
  // Notes live in the same zip under a different path and are not slides.
  assert.equal(result.text.includes('Do not read this out'), false);
});

test('an archive is listed, never unpacked', async () => {
  const target = await makeArchive();
  const result = await readDocument(target, 20_000);

  assert.equal(result.kind, 'archive');
  assert.match(result.text, /readme\.txt/);
  assert.match(result.text, /data\/rows\.csv/);
  // The contents are not in the output. An agent that unpacks an archive is an
  // agent that can be handed a zip bomb.
  assert.equal(result.text.includes('hello'), false);
  assert.match(result.note, /listed, not extracted/);
});

test('the limit is a limit', async () => {
  const target = path.join(dir, 'long.txt');
  writeFileSync(target, 'x'.repeat(5_000));
  const result = await readDocument(target, 100);

  assert.equal(result.text.length, 100);
  assert.match(result.note, /longer than the limit/);
});

test('a type this build cannot read is refused before anything is spawned', async () => {
  let spawned = false;
  await assert.rejects(
    () =>
      readAnyDocument(path.join(dir, 'notes.rtf'), {
        maxChars: 100,
        spawn: () => {
          spawned = true;
          return Promise.resolve({ kind: 'text' as const, text: '', note: '' });
        },
      }),
    (err: Error) => {
      assert.ok(err instanceof DocumentReadError);
      // It says what it *can* read, so the agent's next attempt is informed.
      assert.match(err.message, /\.xlsx/);
      return true;
    },
  );
  assert.equal(spawned, false, 'nothing should be spawned for a type we cannot read');
});

test('every readable extension maps to a kind, and nothing else does', () => {
  assert.equal(kindOf('/a/b/report.XLSX'), 'spreadsheet');
  assert.equal(kindOf('/a/b/deck.pptx'), 'slides');
  assert.equal(kindOf('/a/b/contract.pdf'), 'pdf');
  assert.equal(kindOf('/a/b/notes.md'), 'text');
  assert.equal(kindOf('/a/b/photo.png'), null);
  assert.equal(kindOf('/a/b/binary'), null);
});

test('a parser that dies is a tool error, not a crash', async () => {
  // What the child does on a malformed file, without needing a malformed file:
  // the parent must turn a failure into something an agent can read.
  await assert.rejects(
    () =>
      readAnyDocument(path.join(dir, 'invoices.xlsx'), {
        maxChars: 100,
        spawn: () => Promise.reject(new DocumentReadError('the file is damaged')),
      }),
    /the file is damaged/,
  );
});

test('a real read goes through a child process and comes back', async () => {
  // The one test that spawns for real, so the wiring is proven rather than
  // mocked away: the worker path resolves, the child runs, the JSON returns.
  const target = await makeSpreadsheet();
  const result = await readAnyDocument(target, { maxChars: 20_000 });

  assert.equal(result.kind, 'spreadsheet');
  assert.match(result.text, /INV-901/);
});
