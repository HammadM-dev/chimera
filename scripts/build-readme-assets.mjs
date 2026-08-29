#!/usr/bin/env node
// Turns the frames the recorder captured into the README's animations.
//
//   CHIMERA_RECORD=1 npx playwright test e2e/assets.spec.ts   # from apps/desktop
//   node scripts/build-readme-assets.mjs
//
// Two passes per animation, which is the whole trick to a GIF that does not
// look like a GIF: the first builds a palette from the actual frames, the
// second dithers against it. One shared 256-colour palette across a dark UI
// with subtle gradients is the difference between clean type and mud.
//
// ffmpeg is not vendored and not a dependency — it is a tool you have or you
// do not, and this says which when you do not.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const assets = path.join(repoRoot, 'docs', 'assets');
const recordings = path.join(assets, 'frames');

const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';

// Width in pixels and the rate the GIF plays at. 860 matches the width the
// README asks for, so no browser resamples it.
//
// `from` and `to` trim the recording. A run recorded from launch includes the
// setup nobody wants to watch — connecting a provider, dismissing a guide —
// and a demonstration that opens on a settings form is a demonstration nobody
// finishes.
// `speed` compresses real time. A person assembling an automation pauses to
// read, and those pauses are right in the application and dead air in a
// demonstration — but cutting them out entirely produces a jump-cut reel that
// reads as a mockup. Playing it faster keeps the motion continuous and honest.
const ANIMATIONS = [
  { name: 'build', fps: 10, width: 860, from: 34, to: 93, speed: 3 },
  { name: 'swarm', fps: 10, width: 860, from: 38, to: 67, speed: 2 },
];

if (spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error(
    'ffmpeg is needed to build the README animations and was not found.\n' +
      'Install it, or set FFMPEG to a static build:\n' +
      '  FFMPEG=/path/to/ffmpeg node scripts/build-readme-assets.mjs',
  );
  process.exit(1);
}

mkdirSync(assets, { recursive: true });
let built = 0;

for (const { name, fps, width, from, to, speed } of ANIMATIONS) {
  const input = path.join(recordings, `${name}.webm`);
  if (!existsSync(input)) {
    console.log(`${name} — nothing recorded, skipped`);
    continue;
  }

  const palette = path.join(recordings, `${name}-palette.png`);
  const out = path.join(assets, `${name}.gif`);

  const trim = ['-ss', String(from), '-to', String(to)];
  // setpts before fps, so the frame rate is sampled from the sped-up stream
  // rather than the original.
  const filters =
    `setpts=PTS/${String(speed)},fps=${String(fps)},` +
    `scale=${String(width)}:-1:flags=lanczos`;

  const pass = (args) => {
    const run = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
    if (run.status !== 0) {
      console.error(`ffmpeg failed while building ${name}.`);
      process.exit(1);
    }
  };

  pass([...trim, '-i', input, '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
  pass([
    ...trim,
    '-i',
    input,
    '-i',
    palette,
    '-lavfi',
    `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    out,
  ]);

  const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
  const seconds = ((to - from) / speed).toFixed(1);
  console.log(`${name}.gif — ${seconds}s at ${String(fps)}fps, ${mb}MB`);
  // GitHub serves README images through a proxy that gives up on very large
  // files, and a reader on a phone pays for every one of those megabytes.
  if (Number(mb) > 10) console.log(`  warning: ${mb}MB is large for a README. Trim the frames.`);
  built += 1;
}

console.log(built === 0 ? 'Nothing built — record some frames first.' : `Built ${String(built)}.`);
