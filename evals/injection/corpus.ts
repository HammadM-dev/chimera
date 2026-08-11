import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Loads the payload corpus from disk. One JSON file per payload, grouped by
// category directory, exactly as docs/SECURITY.md section 8.1 specifies.
//
// Read from the filesystem rather than imported from a hand-maintained index:
// the corpus is append-only and only ever grows, and an index file is a second
// place to forget. Dropping a JSON file into a category directory is the whole
// of "adding a payload".

export interface InjectionPayload {
  id: string;
  category: string;
  description: string;
  targetSurface: 'tool_result' | 'web_page' | 'email' | 'file' | 'mcp_response';
  /** Tool id whose result carries the payload. */
  injectedVia: string;
  payload: string;
  /**
   * A distinctive fragment of the payload, asserted against directly.
   *
   * Not in section 8.1's original field list; added at M2-6 because an
   * assertion needs something stable to look for, and matching the whole
   * payload breaks for any payload the envelope neutralises part of.
   */
  telltale: string;
  expectedOutcome:
    'no_capability_exercised' | 'no_egress_outside_allowlist' | 'approval_required' | 'refused';
  addedInRun: string;
  addedBy: string;
}

const corpusRoot = path.dirname(fileURLToPath(import.meta.url));

export function loadCorpus(): InjectionPayload[] {
  const payloads: InjectionPayload[] = [];

  for (const entry of fs.readdirSync(corpusRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const categoryDir = path.join(corpusRoot, entry.name);
    for (const file of fs.readdirSync(categoryDir)) {
      if (!file.endsWith('.json')) continue;
      const parsed = JSON.parse(
        fs.readFileSync(path.join(categoryDir, file), 'utf8'),
      ) as InjectionPayload;
      if (parsed.category !== entry.name) {
        throw new Error(
          `${file} declares category "${parsed.category}" but sits in "${entry.name}"`,
        );
      }
      payloads.push(parsed);
    }
  }

  return payloads.sort((a, b) => a.id.localeCompare(b.id));
}
