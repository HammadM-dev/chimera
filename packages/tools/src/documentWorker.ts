import { readDocument } from './documents.ts';

// The child process that does the parsing.
//
// Four libraries here read files that arrived from somebody else, which is the
// shape of most document-parser CVEs: a malformed .docx that walks a parser off
// the end of a buffer, a PDF with a recursive object graph, a zip whose entries
// claim to be a terabyte. None of that should be able to reach the app.
//
// So it runs here instead, as a process with one job and a short life. A crash
// is a non-zero exit the parent reports as a tool error; a hang is a timeout
// the parent kills. Neither is a crash of CHIMERA, and neither leaves a
// half-parsed document in the same heap as somebody's API keys.
//
// Argv rather than stdin for the request, because the request is a path and a
// number. The answer comes back on stdout as one JSON line.

async function main(): Promise<void> {
  const path = process.argv[2] ?? '';
  const maxChars = Number(process.argv[3] ?? '0');

  if (path === '' || !Number.isFinite(maxChars) || maxChars <= 0) {
    process.stdout.write(JSON.stringify({ error: 'a path and a character limit are required' }));
    process.exit(2);
  }

  try {
    const result = await readDocument(path, maxChars);
    process.stdout.write(JSON.stringify(result));
    // Explicit, and not incidental: pdfjs keeps a worker alive, and a child that
    // merely stops having work to do would sit there until the parent's timeout
    // killed it — turning every PDF read into a several-second pause.
    process.exit(0);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
    process.exit(1);
  }
}

void main();
