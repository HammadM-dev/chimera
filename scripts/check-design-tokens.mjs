#!/usr/bin/env node
// CLAUDE.md: "UI: no inline hex colours, use design tokens; weights 400 and
// 500 only". docs/DESIGN.md section 2.3 asks for this to be structurally
// enforced rather than left to review, and assigns it to "the M0 lint-config
// commit" — but the rule cannot be an ESLint rule, because ESLint does not
// lint CSS and every colour and weight in apps/ui lives in a .css file. So it
// is a grep-based check in the same shape as check-no-raw-sql.mjs.
//
// Scope: everything under apps/ui/src except the token definitions themselves,
// which are the one file allowed to name a literal colour.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const uiSrc = path.join(repoRoot, 'apps', 'ui', 'src');
const tokensFile = path.join(uiSrc, 'design-tokens', 'tokens.css');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

const HEX_COLOUR = /#[0-9a-fA-F]{3,8}\b/;
// Any font-weight whose value is not one of the two tokens or their literals.
const FONT_WEIGHT = /font-weight\s*:\s*(.+?)\s*(?:;|$)/;
const ALLOWED_WEIGHTS = new Set([
  '400',
  '500',
  'var(--font-weight-regular)',
  'var(--font-weight-medium)',
  'normal', // 400 by another name; the browser resolves it to the same value
  'inherit',
]);

function findFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findFiles(full, out);
    } else if (/\.(css|ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const file of findFiles(uiSrc)) {
  const isTokensFile = file === tokensFile;
  const lines = readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, index) => {
    const where = `${path.relative(repoRoot, file)}:${index + 1}`;

    if (!isTokensFile && HEX_COLOUR.test(line)) {
      violations.push(
        `${where}: inline hex colour — use a token from design-tokens/tokens.css\n      ${line.trim()}`,
      );
    }

    const weight = FONT_WEIGHT.exec(line);
    if (weight && !ALLOWED_WEIGHTS.has(weight[1].trim())) {
      violations.push(
        `${where}: font-weight "${weight[1].trim()}" — only 400 and 500 exist in the type system\n      ${line.trim()}`,
      );
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} design-token violation(s) in apps/ui/src (CLAUDE.md, docs/DESIGN.md section 2):\n`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('Design tokens OK — no inline hex colours or off-scale font weights in apps/ui/src.');
