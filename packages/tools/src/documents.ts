import { extname } from 'node:path';

// Reading the files people actually have.
//
// `filesystem.readFile` read UTF-8 and nothing else, which meant an agent asked
// to pull the totals out of a folder of invoices could open a CSV and not a
// spreadsheet, and could not open a PDF at all — which is the format invoices
// come in. The shipped invoice template was a template for people who already
// had their invoices as text.
//
// Every parser here is somebody else's code reading a file from somebody else's
// computer, which is the shape of most document-parser CVEs. They run in a
// child process (`documentWorker.ts`), so a malformed file crashes something
// disposable rather than the app. This module is the parsing itself and knows
// nothing about how it is hosted; `readDocument` is what the child calls.

export type DocumentKind = 'text' | 'spreadsheet' | 'document' | 'slides' | 'pdf' | 'archive';

export interface DocumentText {
  kind: DocumentKind;
  /** The extracted content, already flattened to text the model can read. */
  text: string;
  /** What was skipped or lost, said plainly. Empty when nothing was. */
  note: string;
}

/** Extensions this build can open, by what it will do with them. */
const KIND_BY_EXTENSION: Record<string, DocumentKind> = {
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.csv': 'text',
  '.tsv': 'text',
  '.json': 'text',
  '.yaml': 'text',
  '.yml': 'text',
  '.xml': 'text',
  '.html': 'text',
  '.log': 'text',
  '.xlsx': 'spreadsheet',
  '.xlsm': 'spreadsheet',
  '.docx': 'document',
  '.pptx': 'slides',
  '.pdf': 'pdf',
  '.zip': 'archive',
};

export function kindOf(path: string): DocumentKind | null {
  return KIND_BY_EXTENSION[extname(path).toLowerCase()] ?? null;
}

/** Every extension this build can open, for a message that says so. */
export function readableExtensions(): string[] {
  return Object.keys(KIND_BY_EXTENSION).sort();
}

/**
 * A spreadsheet, as rows.
 *
 * Structure is the whole point. A data extractor asked for "the total on each
 * invoice" needs to know which column the totals are in, and a flattened dump
 * of every cell in reading order takes that away — which is the difference
 * between the extraction working and the model guessing.
 *
 * Rendered as TSV per sheet: compact, unambiguous about column boundaries, and
 * the shape a model has seen a million of.
 */
async function readSpreadsheet(path: string, maxChars: number): Promise<DocumentText> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.readFile(path);

  const parts: string[] = [];
  let truncated = false;
  let used = 0;

  workbook.eachSheet((sheet) => {
    if (truncated) return;
    const lines: string[] = [`# Sheet: ${sheet.name}`];

    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (truncated) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(renderCell(cell.value, cell.text).replace(/[\t\r\n]+/g, ' '));
      });
      const line = cells.join('\t').replace(/\t+$/, '');
      used += line.length + 1;
      if (used > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
    });

    parts.push(lines.join('\n'));
  });

  return {
    kind: 'spreadsheet',
    text: parts.join('\n\n'),
    note: truncated
      ? 'The spreadsheet was longer than the file size limit allows; the rest was not read.'
      : '',
  };
}

/**
 * One cell, as the text an agent should copy.
 *
 * `cell.text` is nearly always right — it is what a person looking at the sheet
 * sees, so a formula renders as its result. Dates are the exception and matter
 * more than the rest put together: `cell.text` gives them as a JavaScript
 * `Date.toString()`, so a cell that reads `2026-06-01` in Excel arrives as
 * "Mon Jun 01 2026 01:00:00 GMT+0100 (British Summer Time)". An extractor told
 * to copy the value and not guess would copy exactly that, and a downstream
 * reader taking the day off the front of it gets the wrong day for every
 * timezone west of UTC.
 *
 * ISO, from the UTC instant, which is the day the spreadsheet meant whatever
 * clock this machine is on.
 */
function renderCell(value: unknown, text: string): string {
  if (value instanceof Date) {
    const iso = value.toISOString();
    // Midnight means somebody typed a date; anything else is a timestamp and
    // the time is part of what they wrote down.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  return String(text ?? '');
}

/** A Word document, as text. Formatting is not information here. */
async function readWord(path: string): Promise<DocumentText> {
  const mammoth = await import('mammoth');
  const result = await mammoth.default.extractRawText({ path });
  return {
    kind: 'document',
    text: result.value,
    // Mammoth reports what it could not represent — images, unusual styles.
    note: result.messages.length === 0 ? '' : result.messages.map((m) => m.message).join('; '),
  };
}

/**
 * A PDF, page by page.
 *
 * Pages are labelled because a citation into a contract is worthless without
 * one — "clause 7.2 on page 14" is checkable and "clause 7.2" is not.
 */
async function readPdf(path: string, maxChars: number): Promise<DocumentText> {
  const { readFile } = await import('node:fs/promises');
  // The legacy build: the modern one assumes a browser and reaches for DOM APIs
  // that do not exist in a Node child process.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(await readFile(path));
  // The loading task owns the worker; the document does not. Destroying the
  // document leaves the worker running, which in a child process means the
  // process never exits and the parent waits out its whole timeout.
  const task = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;

  const parts: string[] = [];
  let used = 0;
  let readTo = 0;

  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    const block = `[page ${String(page)}]\n${text}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
    readTo = page;
  }

  await task.destroy();

  return {
    kind: 'pdf',
    text: parts.join('\n\n'),
    note:
      readTo < doc.numPages
        ? `Read ${String(readTo)} of ${String(doc.numPages)} pages; the rest was over the file size limit.`
        : '',
  };
}

/**
 * A PowerPoint, slide by slide.
 *
 * Hand-rolled rather than a fifth dependency: a .pptx is a zip of XML, one file
 * per slide, and the text lives in `<a:t>` elements. That is the whole format
 * as far as reading it goes, and `yauzl` is already here for archives.
 */
async function readSlides(path: string, maxChars: number): Promise<DocumentText> {
  const entries = await readZipEntries(path, /^ppt\/slides\/slide\d+\.xml$/);

  const slides = entries
    .sort((a, b) => slideNumber(a.name) - slideNumber(b.name))
    .map((entry) => {
      const text = [...entry.body.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXml(match[1] ?? ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `[slide ${String(slideNumber(entry.name))}]\n${text}`;
    })
    .filter((block) => block.trim() !== '');

  const joined = slides.join('\n\n');
  return {
    kind: 'slides',
    text: joined.slice(0, maxChars),
    note:
      joined.length > maxChars
        ? 'The deck was longer than the file size limit allows; the rest was not read.'
        : 'Speaker notes and images are not read.',
  };
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? '0');
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * A zip, as a listing.
 *
 * Deliberately not extracted. An agent that unpacks an archive into the
 * workspace is an agent that can be handed a zip bomb, and "what is in this
 * file" is the question actually being asked. Reading a member is
 * `filesystem.readFile` on it after somebody has unpacked it on purpose.
 */
async function readArchive(path: string, maxChars: number): Promise<DocumentText> {
  const entries = await readZipEntries(path, null, { namesOnly: true });
  const lines = entries.map((entry) =>
    entry.size === null ? entry.name : `${entry.name}\t${String(entry.size)} bytes`,
  );
  const text = [`${String(lines.length)} entries:`, ...lines].join('\n');
  return {
    kind: 'archive',
    text: text.slice(0, maxChars),
    note: 'Archive contents are listed, not extracted.',
  };
}

interface ZipEntry {
  name: string;
  size: number | null;
  body: string;
}

/** Opens a zip and reads the members matching `pattern`, or lists them all. */
function readZipEntries(
  path: string,
  pattern: RegExp | null,
  options: { namesOnly?: boolean } = {},
): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    void import('yauzl').then((yauzlModule) => {
      const yauzl = yauzlModule.default;
      yauzl.open(path, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) {
          reject(err ?? new Error('the archive could not be opened'));
          return;
        }

        const found: ZipEntry[] = [];
        zip.readEntry();

        zip.on('entry', (entry) => {
          const name = entry.fileName;
          const matches = pattern === null || pattern.test(name);

          if (!matches || options.namesOnly === true) {
            if (matches) found.push({ name, size: entry.uncompressedSize ?? null, body: '' });
            zip.readEntry();
            return;
          }

          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              zip.readEntry();
              return;
            }
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              found.push({
                name,
                size: entry.uncompressedSize ?? null,
                body: Buffer.concat(chunks).toString('utf8'),
              });
              zip.readEntry();
            });
            stream.on('error', () => {
              zip.readEntry();
            });
          });
        });

        zip.on('end', () => {
          resolve(found);
        });
        zip.on('error', reject);
      });
    }, reject);
  });
}

/**
 * Reads one file as text, whatever it is.
 *
 * Called in a child process. Throws on anything it cannot open, which the
 * parent turns into a tool error the agent can read.
 */
export async function readDocument(path: string, maxChars: number): Promise<DocumentText> {
  const kind = kindOf(path);

  switch (kind) {
    case 'spreadsheet':
      return readSpreadsheet(path, maxChars);
    case 'document':
      return readWord(path);
    case 'pdf':
      return readPdf(path, maxChars);
    case 'slides':
      return readSlides(path, maxChars);
    case 'archive':
      return readArchive(path, maxChars);
    default: {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(path, 'utf8');
      return {
        kind: 'text',
        text: text.slice(0, maxChars),
        note: text.length > maxChars ? 'The file was longer than the limit; the rest was cut.' : '',
      };
    }
  }
}
