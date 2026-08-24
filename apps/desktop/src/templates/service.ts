import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The automations somebody can start from instead of a blank canvas.
//
// Read from JSON on disk rather than compiled in, because `templates/` is the
// documented home for them and because a template is data: somebody should be
// able to read one, copy it, and write their own without touching TypeScript.
//
// The directory is passed in for the reason `store/lifecycle.ts` records — no
// Electron import here, so this module is exercisable under `node --test`, and
// the tests that check every shipped template is well-formed can actually run.

export interface TemplateStep {
  id?: string;
  kind?: string;
  roleId: string;
  instruction: string;
  settings?: Record<string, unknown>;
}

export interface ShippedTemplate {
  id: string;
  name: string;
  /** Who this is for, in a phrase. Shown in the gallery so people can skip nine of them. */
  audience: string;
  summary: string;
  /** What has to be set up first, if anything. Shown before they pick it, not after it fails. */
  needs: string[];
  steps: TemplateStep[];
  edges?: [string, string][];
  egressAllowlist?: string[];
  egressMode?: 'allowlist' | 'browse' | 'open';
}

let directory = '';

export function setTemplateDirectory(dir: string): void {
  directory = dir;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Every template on disk, in a stable order.
 *
 * A file that will not parse is skipped with a warning rather than taken down
 * the whole gallery with it: one malformed template must not cost somebody the
 * other ten.
 */
export function listTemplates(): { templates: ShippedTemplate[] } {
  if (directory === '') return { templates: [] };

  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return { templates: [] };
  }

  const templates: ShippedTemplate[] = [];
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record['id'] !== 'string' || !Array.isArray(record['steps'])) continue;

      templates.push({
        id: record['id'],
        name: typeof record['name'] === 'string' ? record['name'] : record['id'],
        audience: typeof record['audience'] === 'string' ? record['audience'] : '',
        summary: typeof record['summary'] === 'string' ? record['summary'] : '',
        needs: asStringArray(record['needs']),
        steps: record['steps'] as TemplateStep[],
        ...(Array.isArray(record['edges']) ? { edges: record['edges'] as [string, string][] } : {}),
        ...(Array.isArray(record['egressAllowlist'])
          ? { egressAllowlist: asStringArray(record['egressAllowlist']) }
          : {}),
        ...(record['egressMode'] === 'allowlist' ||
        record['egressMode'] === 'browse' ||
        record['egressMode'] === 'open'
          ? { egressMode: record['egressMode'] }
          : {}),
      });
    } catch {
      console.warn(`[templates] ${file} is not valid JSON; skipping it`);
    }
  }

  return { templates };
}
