#!/usr/bin/env node
// Checks intra-repo cross-references across the doc set: real markdown links
// ([text](path)) and the backtick-quoted file mentions the docs actually use
// today (e.g. `docs/ROADMAP.md`). No new dependency — fs/regex only, local
// links only, per docs/ROADMAP.md M0-2's acceptance criteria.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');

function findMarkdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findMarkdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const BACKTICK_DOC_REF = /`((?:docs\/)?[A-Za-z0-9_-]+\.md)`/g;

// Deliberately forward-referenced files that don't exist yet — each entry
// needs a reason and the milestone that creates it, so this allowlist can't
// silently grow into a way to ignore real broken links.
const KNOWN_FUTURE_REFS = new Map([
  ['CONTRIBUTING.md', 'CLA requirement, ships M7 — see docs/LICENSING.md'],
]);

function headingSlugs(content) {
  const slugs = new Set();
  for (const line of content.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const slug = m[1]
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    slugs.add(slug);
  }
  return slugs;
}

function resolveRef(ref, fromFile) {
  const [refPath, anchor] = ref.split('#');
  if (!refPath) return { target: fromFile, anchor }; // pure #anchor, same file
  const candidates = [
    path.resolve(path.dirname(fromFile), refPath),
    path.resolve(repoRoot, refPath),
  ];
  const target = candidates.find((c) => existsSync(c));
  return { target: target ?? candidates[0], anchor, tried: candidates };
}

const files = findMarkdownFiles(repoRoot);
const broken = [];
let checked = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const relFile = path.relative(repoRoot, file);
  const refs = [];

  for (const m of content.matchAll(MARKDOWN_LINK)) {
    const url = m[2];
    if (/^(https?:|mailto:)/.test(url)) continue; // external, not this script's job
    refs.push(url);
  }
  for (const m of content.matchAll(BACKTICK_DOC_REF)) {
    refs.push(m[1]);
  }

  for (const ref of refs) {
    checked += 1;
    const bareName = ref.split('#')[0];
    if (KNOWN_FUTURE_REFS.has(bareName)) continue;
    const { target, anchor, tried } = resolveRef(ref, file);
    if (!existsSync(target)) {
      broken.push(
        `${relFile}: reference "${ref}" does not resolve (tried: ${tried?.map((t) => path.relative(repoRoot, t)).join(', ')})`,
      );
      continue;
    }
    if (anchor) {
      const targetContent = target === file ? content : readFileSync(target, 'utf8');
      if (!headingSlugs(targetContent).has(anchor)) {
        broken.push(
          `${relFile}: reference "${ref}" — anchor #${anchor} not found as a heading in ${path.relative(repoRoot, target)}`,
        );
      }
    }
  }
}

if (broken.length > 0) {
  console.error(`Found ${broken.length} broken intra-repo doc reference(s):\n`);
  for (const b of broken) console.error(`  - ${b}`);
  process.exit(1);
}

console.log(
  `Doc links OK — ${checked} intra-repo reference(s) checked across ${files.length} markdown file(s), 0 broken.`,
);
