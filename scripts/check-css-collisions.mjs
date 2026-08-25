#!/usr/bin/env node
// One class name, one stylesheet.
//
// `.mark` was a 30x30 icon tile in onboarding.css. A catalogue chip in
// views.css was given the same name, inherited `width: 30px`, and clipped its
// own text — "Vision" lost its last letters. It looked like a row overflowing
// its panel, so the first two fixes were aimed at the row and neither did
// anything. Nothing in the build said the two files were talking about the same
// selector, which is what made it expensive rather than merely wrong.
//
// Every stylesheet here is loaded into one document, so a class defined in two
// of them is a collision by definition; whichever loses depends on import
// order, which nobody is thinking about while writing CSS. Element and
// pseudo-element selectors are exempt — resets and `:root` blocks legitimately
// repeat across files.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'apps', 'ui', 'src');

/** Every `.css` under the renderer, since they all end up in one document. */
function stylesheets(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.isFile() && entry.name.endsWith('.css') ? [full] : [];
  });
}

/**
 * The class names a stylesheet *defines*.
 *
 * A definition is a bare `.name` with no combinator in front of it. Anything
 * with a descendant, child or sibling combinator — `.catalogue__head .control`,
 * `.intro__choice .mark` — is narrowing somebody else's class inside a context
 * it owns, which is the normal way to adapt a shared control and not a claim on
 * the name. Counting those made the first version of this check fire on every
 * legitimate override in the tree.
 */
function definedClasses(source) {
  // Comments first: a class name inside prose is not a definition.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set();

  for (const block of withoutComments.split('{')) {
    const selector = block.slice(block.lastIndexOf('}') + 1).trim();
    if (selector === '' || selector.startsWith('@')) continue;

    for (const one of selector.split(',')) {
      // A bare `.name` and nothing else. A combinator anywhere means the rule
      // is scoped to a context; an element, id, attribute or pseudo-class
      // qualifier means it is narrowing rather than defining.
      const match = /^\.([A-Za-z0-9_-]+)$/.exec(one.trim());
      if (match?.[1] !== undefined) found.add(match[1]);
    }
  }
  return found;
}

const owners = new Map();
for (const sheet of stylesheets(ROOT)) {
  for (const name of definedClasses(fs.readFileSync(sheet, 'utf8'))) {
    const relative = path.relative(ROOT, sheet);
    const existing = owners.get(name);
    if (existing) existing.add(relative);
    else owners.set(name, new Set([relative]));
  }
}

const clashes = [...owners.entries()]
  .filter(([, files]) => files.size > 1)
  .map(([name, files]) => `  .${name} — defined in ${[...files].sort().join(' and ')}`)
  .sort();

if (clashes.length > 0) {
  process.stderr.write(
    `Class names defined in more than one stylesheet:\n${clashes.join('\n')}\n\n` +
      'These all load into one document, so which rule wins depends on import order.\n' +
      'Give the newer one a scoped name (`.model__mark`, not `.mark`).\n',
  );
  process.exit(1);
}

process.stdout.write(`CSS OK — ${String(owners.size)} class names, none defined twice.\n`);
