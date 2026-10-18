import path from "node:path";
import type { LspFileServer } from "./config.js";
import { loadPiLspModule } from "./extension.js";

export interface LspServerRoot {
  id: string;
  root: string;
  files: string[];
}

export interface LspSkippedFile {
  file: string;
  server: string;
  reason: string;
}

export interface LspRootDiagnostic {
  matches: LspServerRoot[];
  skipped: LspSkippedFile[];
  warnings: string[];
}

interface PiLspPaths {
  findProjectRoot(
    filePath: string,
    rootMarkers: string[] | undefined,
    fallbackRoot: string,
  ): string | undefined;
  normalizeRelativePath(inputPath: string): string;
}

interface PiLspGlob {
  isPathIncluded(relativePath: string, include?: string[], exclude?: string[]): boolean;
  matchesAnyGlob(patterns: string[] | undefined, value: string): boolean;
}

/**
 * Resolves, per configured server, which workspace root each changed file
 * belongs to — the same root pi-lsp will open the server with. Implemented
 * with pi-lsp's own `findProjectRoot` and glob matchers (loaded through the
 * same dynamic boundary as the extension), so the diagnostic cannot drift
 * from runtime behavior. Used only for the startup `review.lsp.root` log.
 */
export async function resolveLspRoots(
  cwd: string,
  files: readonly string[],
  entries: readonly LspFileServer[],
): Promise<LspRootDiagnostic> {
  const paths = (await loadPiLspModule("extensions/_shared/paths.ts")) as unknown as PiLspPaths;
  const glob = (await loadPiLspModule("extensions/_shared/glob.ts")) as unknown as PiLspGlob;

  const matches = new Map<string, LspServerRoot>();
  const skipped: LspSkippedFile[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    for (const file of files) {
      const absolute = path.isAbsolute(file) ? file : path.join(cwd, file);
      if (!couldMatchBeforeRoot(absolute, cwd, entry, glob)) continue;
      const root = paths.findProjectRoot(absolute, entry.rootMarkers, cwd);
      if (!root) {
        skipped.push({
          file,
          server: entry.id,
          reason: `root markers not found (${entry.rootMarkers.join(", ") || "none"})`,
        });
        continue;
      }
      const relFile = paths.normalizeRelativePath(path.relative(root, absolute));
      if (relFile.startsWith("..") || path.isAbsolute(relFile)) continue;
      if (!glob.isPathIncluded(relFile, entry.include, entry.exclude)) continue;
      const key = `${entry.id}\0${root}`;
      const existing = matches.get(key);
      if (existing) existing.files.push(file);
      else matches.set(key, { id: entry.id, root, files: [file] });
    }
  }
  return { matches: [...matches.values()], skipped, warnings };
}

/**
 * Mirrors pi-lsp's own pre-root include check: the file or its basename must
 * match before root discovery runs.
 */
function couldMatchBeforeRoot(
  file: string,
  cwd: string,
  entry: { include?: string[]; exclude?: string[] },
  glob: PiLspGlob,
): boolean {
  const relative = path.relative(cwd, file).split(path.sep).join("/") || ".";
  const candidates = [...new Set([relative, path.basename(file)])];
  const included =
    !entry.include ||
    entry.include.length === 0 ||
    candidates.some((candidate) => glob.matchesAnyGlob(entry.include, candidate));
  if (!included) return false;
  return !candidates.some((candidate) => glob.matchesAnyGlob(entry.exclude, candidate));
}
