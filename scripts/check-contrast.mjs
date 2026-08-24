#!/usr/bin/env node
// docs/DESIGN.md section 9: "an automated contrast audit is a required task
// before the M4 GUI milestone is considered done... computes WCAG contrast
// ratio for every text-token/surface-token pairing actually used in a
// component and fails CI if any pairing used for body or meta text falls
// under 4.5:1, or under 3:1 for headings and UI component borders/icons."
//
// It was required and never written, which the same document anticipates:
// "asserting a specific ratio for a palette without running a real check would
// be guessing". Adding a second palette is what finally made the guess
// untenable — a light theme eyeballed against a dark one is two guesses.
//
// Scope note: the pairings below are the ones components actually render, not
// the full cross product, exactly as DESIGN.md asks. Adding a pairing to a
// component means adding it here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const tokensFile = path.join(repoRoot, 'apps', 'ui', 'src', 'design-tokens', 'tokens.css');
const css = readFileSync(tokensFile, 'utf8');

/** The token values inside one selector block. */
function paletteFor(selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block in tokens.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const palette = {};
  for (const [, name, value] of css.slice(open, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    palette[name] = value.trim();
  }
  return palette;
}

const dark = paletteFor(':root {');
const light = { ...dark, ...paletteFor(":root[data-theme='light'] {") };

function channel(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Parses #rgb, #rrggbb and rgba(r, g, b, a). Returns [r, g, b, a]. */
function parse(colour) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(colour.trim());
  if (rgba) {
    const parts = rgba[1].split(',').map((part) => Number(part.trim()));
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  throw new Error(`cannot parse colour: ${colour}`);
}

/** A translucent colour over its background, which is what the eye actually sees. */
function flatten(colour, background) {
  const [r, g, b, a] = parse(colour);
  if (a === 1) return [r, g, b];
  const [br, bg, bb] = parse(background);
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(foreground, background) {
  const a = luminance(flatten(foreground, background));
  const b = luminance(flatten(background, background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// [foreground, background, minimum, what it is]. 4.5 for body and meta text,
// 3 for large text and for the borders and icons that carry UI structure.
const PAIRINGS = [
  ['--text-primary', '--surface-canvas', 4.5, 'body text on the canvas'],
  ['--text-primary', '--surface-panel', 4.5, 'body text in a panel'],
  ['--text-primary', '--surface-raised', 4.5, 'body text on a raised card'],
  ['--text-primary', '--surface-popover', 4.5, 'body text in a popover'],
  ['--text-secondary', '--surface-canvas', 4.5, 'secondary text on the canvas'],
  ['--text-secondary', '--surface-panel', 4.5, 'secondary text in a panel'],
  ['--text-secondary', '--surface-raised', 4.5, 'secondary text on a raised card'],
  ['--text-secondary', '--surface-popover', 4.5, 'secondary text in a popover'],
  // Muted is deliberately quiet — placeholders, disabled captions, timestamps —
  // and is held to the large-text floor rather than the body one.
  ['--text-muted', '--surface-canvas', 3, 'muted text on the canvas'],
  ['--text-muted', '--surface-panel', 3, 'muted text in a panel'],
  ['--text-muted', '--surface-raised', 3, 'muted text on a raised card'],
  ['--accent-primary', '--surface-canvas', 3, 'accent on the canvas'],
  ['--accent-primary', '--surface-panel', 3, 'accent in a panel'],
  ['--semantic-success', '--surface-panel', 3, 'success in a panel'],
  ['--semantic-warning', '--surface-panel', 3, 'warning in a panel'],
  ['--semantic-danger', '--surface-panel', 3, 'danger in a panel'],
  ['--semantic-danger', '--surface-raised', 3, 'danger on a raised card'],
  // WCAG SC 1.4.11 covers "visual information required to identify user
  // interface components" — the edge of a field, not every line in the app.
  // A text input is `--surface-canvas` filled, sitting in a panel, and its
  // border is the only thing saying it can be typed in, so it is checked.
  // The structural hairlines are not, and deliberately: they divide rows and
  // outline panels, they identify no control, and holding them to 3:1 would
  // replace this design's 0.5px hairline with a rule.
  ['--border-control', '--surface-canvas', 3, 'the edge of a text field'],
  ['--border-control', '--surface-panel', 3, 'the edge of a field in a panel'],
];

const failures = [];
const report = [];

for (const [themeName, palette] of [
  ['dark', dark],
  ['light', light],
]) {
  // A token the light set forgot is a component that changes meaning with the
  // theme. Caught here rather than by somebody noticing white-on-white.
  if (themeName === 'light') {
    const own = paletteFor(":root[data-theme='light'] {");
    const colourish = Object.keys(dark).filter((name) =>
      /^--(surface|text|border-(hairline|strong|stronger)|accent|semantic)/.test(name),
    );
    for (const name of colourish) {
      if (!(name in own)) failures.push(`light theme never redefines ${name}`);
    }
  }

  for (const [foreground, background, minimum, what] of PAIRINGS) {
    const value = ratio(palette[foreground], palette[background]);
    const ok = value >= minimum;
    report.push(
      `${ok ? ' ' : '!'} ${themeName.padEnd(5)} ${value.toFixed(2).padStart(5)}:1  (min ${String(minimum)})  ${what}`,
    );
    if (!ok) {
      failures.push(
        `${themeName}: ${what} is ${value.toFixed(2)}:1, under the ${String(minimum)}:1 floor (${foreground} on ${background})`,
      );
    }
  }
}

console.log(report.join('\n'));

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} contrast failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nA failing pairing is fixed by changing the token value in docs/DESIGN.md and following it in tokens.css — never by overriding the colour in a component.',
  );
  process.exit(1);
}

console.log('\nContrast OK — every rendered pairing meets its WCAG AA floor in both themes.');
