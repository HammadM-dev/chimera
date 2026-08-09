#!/usr/bin/env node
// docs/ARCHITECTURE.md §3 states the dependency direction once. This is what
// makes it true, rather than a sentence everyone agrees with and nobody checks.
//
// The rule that matters most: `packages/providers` and `packages/tools` must
// never import `packages/core`. Without it, the Governor calls into providers
// and providers call back into the engine — the exact shape that makes
// CLAUDE.md's "no bypass path" unverifiable by inspection, because the call
// graph has a cycle you can enter from either side.
//
// Grep-based rather than madge or dep-cruiser: docs/ROADMAP.md M1-2 asks for
// this check without adding a dependency for it, and an import statement is
// one of the few things a regex reads reliably.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');

/**
 * Each rule: files under `from` may not import anything matching `forbidden`.
 * Both the workspace specifier (`@chimera/core`) and any relative path that
 * climbs into the package (`../../core/src/...`) count as the same edge.
 */
const RULES = [
  {
    from: 'packages/providers/src',
    forbidden: ['@chimera/core', 'packages/core/src', '../core/', '../../core/'],
    why: 'packages/providers must never import packages/core — docs/ARCHITECTURE.md §3. An adapter that can see a role, a budget, or the Governor can branch on one, which is how "provider differences live in adapters only" stops being true.',
  },
  {
    from: 'packages/tools/src',
    forbidden: ['@chimera/core', 'packages/core/src', '../core/', '../../core/'],
    why: 'packages/tools must never import packages/core — docs/ARCHITECTURE.md §3. Tools are invoked through the Governor-gated call path; a tool that can reach the runtime can be invoked around it.',
  },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);
const IMPORT_PATTERN = /(?:^|\s)(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
const REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_PATTERN = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function specifiersIn(source) {
  const found = new Set();
  for (const pattern of [IMPORT_PATTERN, REQUIRE_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return found;
}

const violations = [];

for (const rule of RULES) {
  const root = path.join(repoRoot, rule.from);
  for (const file of collectSourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersIn(source)) {
      // Normalise a relative specifier against its own file so that
      // "../../core/src/errors.ts" is recognised as packages/core regardless of
      // how many levels it climbed.
      const resolved = specifier.startsWith('.')
        ? path.relative(repoRoot, path.resolve(path.dirname(file), specifier)).replace(/\\/g, '/')
        : specifier;

      const hit = rule.forbidden.some(
        (needle) => resolved === needle || resolved.startsWith(needle) || specifier === needle,
      );
      if (hit) {
        violations.push({
          file: path.relative(repoRoot, file),
          specifier,
          why: rule.why,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Found ${violations.length} package-boundary violation(s):\n`);
  for (const violation of violations) {
    console.error(
      `  - ${violation.file}\n      imports "${violation.specifier}"\n      ${violation.why}\n`,
    );
  }
  process.exit(1);
}

console.log(
  `Package boundaries OK — ${String(RULES.length)} rule(s) checked, no forbidden imports.`,
);
