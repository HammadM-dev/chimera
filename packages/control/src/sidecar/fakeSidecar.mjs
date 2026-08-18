#!/usr/bin/env node
// A stand-in for the native-control binary, speaking the same protocol.
//
// Here rather than in a test file because two tests and one manual session all
// want the same thing, and because it is the executable specification of what
// the Rust binary has to do: read a line, do one thing, answer on one line.
//
// Behaviour is scripted through argv so a test can ask for a crash, a silence
// or a refusal without a second stand-in.
const mode = process.argv[2] ?? 'normal';

process.stdout.write(
  `${JSON.stringify({ event: 'ready', data: { capabilities: ['capture', 'injectInput'] } })}\n`,
);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (line.trim() === '') continue;
    const request = JSON.parse(line);

    if (mode === 'silent') continue;
    if (mode === 'crash') {
      process.exit(3);
    }
    if (mode === 'refuse') {
      process.stdout.write(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'SIDECAR_DENIED', message: 'This display cannot be captured.' },
        })}\n`,
      );
      continue;
    }

    // Noise on stdout that is not protocol, so the reader has to survive it.
    if (mode === 'noisy') process.stdout.write('warning: display 0 is scaled\n');

    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, result: { command: request.command, echoed: request.params ?? null } })}\n`,
    );
  }
});
