#!/usr/bin/env node
// docs/ROADMAP.md M0-9: the unsigned build matrix was pulled forward into M0
// deliberately, and code *signing* deliberately was not — Windows signing is
// M7, macOS notarisation is M10, both because they carry cost and lead time
// the build matrix does not.
//
// This check exists so that split survives contact with a future contributor
// (or a future session of mine) helpfully "finishing" the workflow by adding a
// certificate to it. It fails the build if a signing credential, keychain
// import, or notarisation step appears in the packaging config or in any CI
// workflow. When M7 arrives, the fix is to narrow this check deliberately —
// which is a visible commit — not to discover the guard by tripping over it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');

const SCANNED = [
  path.join(repoRoot, '.github', 'workflows'),
  path.join(repoRoot, 'apps', 'desktop', 'electron-builder.yml'),
];

// Credentials and signing invocations, not the mere word "sign" — the configs
// being scanned are allowed to *say in a comment* why they carry no signing.
const SIGNING_PATTERNS = [
  /\bcscLink\b/i,
  /\bCSC_LINK\b/,
  /\bCSC_KEY_PASSWORD\b/,
  /\bWIN_CSC_LINK\b/,
  /\bWIN_CSC_KEY_PASSWORD\b/,
  /\bcertificateFile\b/i,
  /\bcertificatePassword\b/i,
  /\bcertificateSubjectName\b/i,
  /\bcertificateSha1\b/i,
  /\bforceCodeSigning\b/i,
  /\bafterSign\b/i,
  /\bAPPLE_ID\b/,
  /\bAPPLE_APP_SPECIFIC_PASSWORD\b/,
  /\bAPPLE_TEAM_ID\b/,
  /\bAPPLE_API_KEY\b/,
  /\bnotarytool\b/i,
  /\baltool\b/i,
  /\bsecurity\s+(import|create-keychain|unlock-keychain)\b/,
  /\bcodesign\b/i,
  /\bsigntool\b/i,
];

function collectFiles(target, out = []) {
  if (!existsSync(target)) return out;
  const entries = readdirSync(path.dirname(target), { withFileTypes: true });
  const self = entries.find((entry) => path.join(path.dirname(target), entry.name) === target);
  if (self?.isDirectory()) {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) collectFiles(full, out);
      else out.push(full);
    }
  } else {
    out.push(target);
  }
  return out;
}

const violations = [];

for (const target of SCANNED) {
  for (const file of collectFiles(target)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // Comments are how these files explain the M0/M7/M10 split. Scanning
      // them would make the explanation itself a violation.
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) return;
      for (const pattern of SIGNING_PATTERNS) {
        if (pattern.test(line)) {
          violations.push(`${path.relative(repoRoot, file)}:${index + 1}: ${trimmed}`);
          return;
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} code-signing reference(s) in packaging or CI config.\n` +
      'Signing is M7 (Windows) and M10 (macOS), not M0 — see docs/ROADMAP.md M0-9.\n' +
      'If you are implementing M7 or M10, narrow SIGNING_PATTERNS in this script in the same commit:\n',
  );
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('No code-signing configuration in packaging or CI — M0/M7/M10 split intact.');
