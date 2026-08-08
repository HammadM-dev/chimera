#!/usr/bin/env node
// CLAUDE.md: "All SQLite access through packages/store — no raw queries
// elsewhere." Grep-based, not a real SQL parser — per docs/ROADMAP.md
// M0-5's acceptance criteria, which asks for exactly this. Flags common
// SQL statement keywords and better-sqlite3 call patterns appearing in any
// .ts/.tsx file outside packages/store/src.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const ALLOWED_DIR = path.join(repoRoot, 'packages', 'store', 'src');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'release', '.git', 'coverage']);

const SQL_PATTERNS = [
  /\bSELECT\s+.+\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+\w+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bCREATE\s+TABLE\b/i,
  /\.prepare\s*\(/,
  /\bdb\.exec\s*\(/,
];

function findSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const file of findSourceFiles(repoRoot)) {
  if (file.startsWith(ALLOWED_DIR)) continue;
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const pattern of SQL_PATTERNS) {
      if (pattern.test(line)) {
        violations.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
        break;
      }
    }
  });
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} apparent raw-SQL usage(s) outside packages/store/src — all SQLite access must go through packages/store (CLAUDE.md):\n`,
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('No raw SQL found outside packages/store/src.');
