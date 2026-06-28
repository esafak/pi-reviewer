import type { ContextFile } from "./context.js";
import { localFs, type FsOps } from "./ssh.js";

/**
 * Default doc dirs for interactive (extension) mode — opt-out: scanned unless
 * overridden. CI is opt-in instead: it passes an explicit `docDirs` (empty =
 * nothing injected), so this default does not apply there.
 */
export const DEFAULT_DOC_DIRS = [".pi/notes", ".claude/notes", ".agents/notes"];

export function extractKeywords(diffFiles: string[]): string[] {
  const keywords = new Set<string>();
  for (const file of diffFiles) {
    const withoutExt = file.replace(/\.[^/.]+$/, "");
    for (const segment of withoutExt.split(/[/\-_.]/)) {
      for (const word of segment.split(/(?=[A-Z])/)) {
        const lower = word.toLowerCase();
        if (lower.length >= 3) keywords.add(lower);
      }
    }
  }
  return [...keywords];
}

export function parseDescription(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const descMatch = match[1].match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : null;
}

export function isRelevant(description: string, filePath: string, keywords: string[]): boolean {
  const haystack = `${description} ${filePath}`.toLowerCase();
  return keywords.some(kw => haystack.includes(kw));
}

async function scanDocFiles(
  cwd: string,
  fs: FsOps,
  docDirs: string[],
  gitRoot?: string,
): Promise<Array<{ path: string; content: string; description: string }>> {
  const results: Array<{ path: string; content: string; description: string }> = [];

  async function scanDir(absDir: string, relDir: string, depth: number): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.list(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        const content = await fs.read(fs.join(absDir, entry));
        if (!content) continue;
        const description = parseDescription(content);
        if (!description) continue;
        results.push({ path: fs.join(relDir, entry), content, description });
      } else if (depth < 1) {
        await scanDir(fs.join(absDir, entry), fs.join(relDir, entry), depth + 1);
      }
    }
  }

  // Walk from cwd up to gitRoot (or just cwd when no gitRoot), root-first
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (!gitRoot || current === gitRoot) break;
    const parent = fs.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    const levelsUp = dirs.length - 1 - i;
    const upParts = Array.from<string>({ length: levelsUp }).fill("..");
    for (const docDir of docDirs) {
      const absDocDir = fs.join(dir, docDir);
      const relDocDir = levelsUp > 0 ? fs.join(...upParts, docDir) : docDir;
      await scanDir(absDocDir, relDocDir, 0);
    }
  }

  return results;
}

export interface LoadDocContextOptions {
  cwd: string;
  diffFiles: string[];
  fs?: FsOps;
  gitRoot?: string;
  docDirs?: string[];
}

/**
 * Scans the configured doc dirs for `.md` files whose `description` frontmatter
 * or path matches a keyword derived from the diff file paths, and returns them
 * as context files for injection into the review system prompt.
 *
 * Pure and framework-free — shared by the pi extension (interactive mode) and
 * the CI runner. Returns `[]` when there are no diff files (no keywords).
 */
export async function loadDocContext(options: LoadDocContextOptions): Promise<ContextFile[]> {
  const { cwd, diffFiles, gitRoot } = options;
  const fs = options.fs ?? localFs();
  const docDirs = options.docDirs ?? DEFAULT_DOC_DIRS;

  const keywords = extractKeywords(diffFiles);
  if (keywords.length === 0) return [];

  const docs = await scanDocFiles(cwd, fs, docDirs, gitRoot);
  return docs
    .filter(doc => isRelevant(doc.description, doc.path, keywords))
    .map(doc => ({ path: doc.path, content: doc.content }));
}
