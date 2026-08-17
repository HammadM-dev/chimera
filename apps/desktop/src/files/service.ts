import fs from 'node:fs';
import path from 'node:path';

// Attachments for an automation brief. The user picks files or folders; the
// text in them is read here and travels with the brief, so the first agent
// sees content rather than a path it may not be allowed to open.

/** Read cap per file. A brief is context, not a corpus. */
const MAX_FILE_BYTES = 200_000;
/** Files taken from a folder, newest first. A dropped repo must not become 40,000 attachments. */
const MAX_FOLDER_FILES = 25;

const TEXTUAL = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.php',
  '.sh',
  '.sql',
  '.html',
  '.css',
  '.xml',
  '.toml',
  '.ini',
  '.env',
  '.log',
]);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export interface Attachment {
  path: string;
  name: string;
  kind: 'text' | 'image' | 'binary';
  bytes: number;
  /** Text content, capped. Empty for anything not read as text. */
  content: string;
  /** Why the content is empty, when it is. Shown rather than left a mystery. */
  note: string;
}

function describe(filePath: string): Attachment {
  const name = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  let bytes = 0;
  try {
    bytes = fs.statSync(filePath).size;
  } catch {
    return { path: filePath, name, kind: 'binary', bytes: 0, content: '', note: 'unreadable' };
  }

  if (IMAGE.has(extension)) {
    // Vision arrives with the agent runtime's image support; for now an image
    // is attached and named rather than silently dropped, which is the honest
    // half of the feature.
    return { path: filePath, name, kind: 'image', bytes, content: '', note: 'image, not yet read' };
  }
  if (!TEXTUAL.has(extension)) {
    return { path: filePath, name, kind: 'binary', bytes, content: '', note: 'not a text file' };
  }
  if (bytes > MAX_FILE_BYTES) {
    return {
      path: filePath,
      name,
      kind: 'text',
      bytes,
      content: '',
      note: `over the ${String(MAX_FILE_BYTES / 1000)}KB attachment limit`,
    };
  }

  try {
    return {
      path: filePath,
      name,
      kind: 'text',
      bytes,
      content: fs.readFileSync(filePath, 'utf8'),
      note: '',
    };
  } catch (err) {
    return {
      path: filePath,
      name,
      kind: 'binary',
      bytes,
      content: '',
      note: err instanceof Error ? err.message : 'unreadable',
    };
  }
}

function expandFolder(folder: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => path.join(folder, entry.name))
    .slice(0, MAX_FOLDER_FILES);
}

/**
 * Opens the OS picker and reads what comes back.
 *
 * A folder is expanded one level, not walked: dropping a project directory
 * should attach its files, not its `node_modules`. The cap is stated in the
 * result rather than applied silently.
 */
export async function pickAttachments(mode: 'files' | 'folder'): Promise<{
  attachments: Attachment[];
  truncated: boolean;
}> {
  // The OS file dialog is the one part of this flow a test cannot click, so
  // the E2E suite hands the paths in directly. Environment-gated and read only
  // here: with the variable unset — which is every real launch — this is dead
  // code, and with it set the rest of the flow is unchanged, so what the test
  // exercises afterwards is the real reader.
  const scripted = process.env.CHIMERA_E2E_PICK_FILES;
  if (scripted !== undefined && scripted !== '') {
    const picked = scripted.split(path.delimiter).filter((entry) => entry !== '');
    const expanded = mode === 'folder' ? picked.flatMap((folder) => expandFolder(folder)) : picked;
    return {
      attachments: expanded.map(describe),
      truncated: mode === 'folder' && expanded.length >= MAX_FOLDER_FILES,
    };
  }

  // Imported here rather than at module scope. Everything reachable from
  // ipc/handlers.ts must load under plain `node --test`, and a top-level
  // `import { dialog } from 'electron'` broke the IPC registry's own test the
  // moment this file joined the graph — the same trap `store/lifecycle.ts` hit
  // at M1-10, documented there and hit again here.
  const { dialog } = await import('electron');

  const result = await dialog.showOpenDialog({
    properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
  });
  if (result.canceled) return { attachments: [], truncated: false };

  const paths =
    mode === 'folder'
      ? result.filePaths.flatMap((folder) => expandFolder(folder))
      : result.filePaths;

  const truncated = mode === 'folder' && paths.length >= MAX_FOLDER_FILES;
  return { attachments: paths.map(describe), truncated };
}

/**
 * Asks for a folder, and returns the folder.
 *
 * Separate from `pickAttachments`, which reads what it finds: a watched folder
 * is a place, not a payload, and reading a hundred files to learn a path would
 * be both slow and wrong.
 */
export async function pickDirectory(): Promise<{ path: string }> {
  const scripted = process.env.CHIMERA_E2E_PICK_DIRECTORY;
  if (scripted !== undefined && scripted !== '') return { path: scripted };

  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return { path: result.canceled ? '' : (result.filePaths[0] ?? '') };
}
