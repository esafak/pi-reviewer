import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { localFs, sshExec, sshFs, type FsOps } from "./ssh.js";

const CONFIG_DIRS = [".pi", ".claude", ".agents"];

export interface ContextOptions {
  cwd?: string;
  gitRoot?: string; // override auto-detected git root (e.g. outer monorepo root when --dir is a nested repo)
  diffFiles?: string[]; // repo-relative touched paths; parents contribute conventions
}

export interface ContextFile {
  path: string; // relative to cwd (local) or relative to remoteCwd (SSH)
  content: string;
}

export interface ContextGroup {
  name: string;
  description?: string;
  files: ContextFile[];
}

export interface ContextResult {
  conventions: ContextFile[]; // AGENTS.md / CLAUDE.md, root → cwd order
  reviewRules: ContextFile[]; // REVIEW.md, root → cwd order
}

export const CONTEXT_PROVIDER_EVENT = "pi-reviewer:collect-context-providers";

export type ContextProvider = (opts: {
  cwd: string;
  diffFiles: string[];
  fs: FsOps;
  gitRoot?: string;
}) => Promise<ContextFile[]>;

export interface ContextProviderEvent {
  cwd: string;
  diffFiles: string[];
  register: (name: string, provider: ContextProvider) => void;
}

function findGitRoot(cwd: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// git resolves symlinks (e.g. /var → /private/var on macOS) while the caller
// may pass an unresolved cwd, so string equality on paths fails. Canonicalize
// once so chain termination and visited dedupe compare the same namespace.
function canonicalize(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

async function readContextFile(
  fs: FsOps,
  dir: string,
  filename: string,
): Promise<{ path: string; content: string } | null> {
  for (const candidate of [dir, ...CONFIG_DIRS.map((d) => fs.join(dir, d))]) {
    const entries = await fs.list(candidate);
    const match = entries.find((e) => e.toLowerCase() === filename.toLowerCase());
    if (!match) continue;
    const filePath = fs.join(candidate, match);
    const content = await fs.read(filePath);
    if (content !== null) return { path: filePath, content };
  }
  return null;
}

/**
 * Walks from gitRoot down to cwd, collecting one matching file per directory level.
 * filenames: tried in priority order at each level (first match wins).
 * Returns files in root → cwd order.
 */
export async function walkUpContextFiles(
  fs: FsOps,
  cwd: string,
  filenames: string[],
  gitRoot: string,
): Promise<ContextFile[]> {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = fs.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const result: ContextFile[] = [];
  const visited = new Set<string>();

  for (const dir of dirs) {
    for (const filename of filenames) {
      const file = await readContextFile(fs, dir, filename);
      if (file === null || visited.has(file.path)) continue;
      visited.add(file.path);
      result.push({ path: fs.relative(cwd, file.path), content: file.content });
      break; // one file per directory level
    }
  }

  return result;
}

/** Merges conventions and reviewRules into a single ordered array. */
export function mergeContextFiles(result: ContextResult): ContextFile[] {
  return [...result.conventions, ...result.reviewRules];
}

/**
 * Collects convention files from the parents of touched paths.
 * `resolveBase` is the root diff paths are relative to (the repo toplevel the
 * diff was taken from, not necessarily `cwd`); `cwd` stays the base for
 * returned relative paths. Each diff file contributes its directory chain up
 * to `gitRoot`. Once any file is found for a directory the search ends there,
 * preserving the AGENTS.md-over-CLAUDE.md priority. Touched files append
 * after the base chain in alphabetical directory order. Dirs already covered
 * by the base chain are skipped, and the per-kind dir cap bounds prompt
 * growth and per-directory file probes (one ssh round-trip per probe over
 * sshFs); conventions and rules each get their own cap deliberately.
 */
const MAX_TOUCHED_DIRS = 20;

async function collectTouchedContextFiles(
  fs: FsOps,
  cwd: string,
  diffFiles: string[],
  filenames: string[],
  gitRoot: string,
  resolveBase: string = cwd,
): Promise<ContextFile[]> {
  const baseChain = new Set<string>();
  for (let dir = cwd; ;) {
    baseChain.add(dir);
    if (dir === gitRoot) break;
    const parent = fs.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const dirs = new Set<string>();
  for (const file of diffFiles) {
    const slash = file.lastIndexOf("/");
    if (slash <= 0) continue; // root-level file adds nothing beyond the base chain
    let current = fs.join(resolveBase, file.slice(0, slash));
    while (true) {
      if (!baseChain.has(current)) dirs.add(current);
      if (current === gitRoot) break;
      const parent = fs.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  const result: ContextFile[] = [];
  for (const dir of [...dirs].sort().slice(0, MAX_TOUCHED_DIRS)) {
    for (const filename of filenames) {
      const found = await readContextFile(fs, dir, filename);
      if (found === null) continue;
      result.push({ path: fs.relative(cwd, found.path), content: found.content });
      break; // one file per directory level
    }
  }

  return result;
}

async function appendTouchedFiles(
  fs: FsOps,
  cwd: string,
  gitRoot: string,
  conventions: ContextFile[],
  reviewRules: ContextFile[],
  diffFiles: string[],
  resolveBase: string,
): Promise<void> {
  const [touchedConventions, touchedRules] = await Promise.all([
    collectTouchedContextFiles(
      fs,
      cwd,
      diffFiles,
      ["AGENTS.md", "CLAUDE.md"],
      gitRoot,
      resolveBase,
    ),
    collectTouchedContextFiles(fs, cwd, diffFiles, ["REVIEW.md"], gitRoot, resolveBase),
  ]);
  conventions.push(...touchedConventions);
  reviewRules.push(...touchedRules);
}

export interface MinimalEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export async function collectProviderContext(
  events: MinimalEventBus,
  cwd: string,
  diffFiles: string[],
  fs: FsOps = localFs(),
  gitRoot?: string,
): Promise<ContextGroup[]> {
  const registrations: Array<{ name: string; provider: ContextProvider }> = [];
  events.emit(CONTEXT_PROVIDER_EVENT, {
    cwd,
    diffFiles,
    register: (name: string, provider: ContextProvider) => registrations.push({ name, provider }),
  } satisfies ContextProviderEvent);
  const groups = await Promise.all(
    registrations.map(async ({ name, provider }) => ({
      name,
      files: await provider({ cwd, diffFiles, fs, gitRoot }),
    })),
  );
  const merged = new Map<string, ContextFile[]>();
  for (const { name, files } of groups) {
    const existing = merged.get(name) ?? [];
    const seen = new Set(existing.map((f) => f.path));
    merged.set(name, [...existing, ...files.filter((f) => !seen.has(f.path))]);
  }
  return [...merged.entries()]
    .filter(([, files]) => files.length > 0)
    .map(([name, files]) => ({ name, files }));
}

export async function loadContext(options: ContextOptions = {}): Promise<ContextResult> {
  const cwd = canonicalize(options.cwd ?? process.cwd());
  const gitRoot = options.gitRoot ? canonicalize(options.gitRoot) : (findGitRoot(cwd) ?? cwd);
  const fs = localFs();

  const [conventions, reviewRules] = await Promise.all([
    walkUpContextFiles(fs, cwd, ["AGENTS.md", "CLAUDE.md"], gitRoot),
    walkUpContextFiles(fs, cwd, ["REVIEW.md"], gitRoot),
  ]);

  const diffFiles = options.diffFiles ?? [];
  if (diffFiles.length > 0) {
    // git prints paths relative to the repo toplevel even when invoked from a
    // subdirectory; an explicit gitRoot override means the diff was taken
    // inside the nested repo at cwd, otherwise it is relative to gitRoot.
    await appendTouchedFiles(
      fs,
      cwd,
      gitRoot,
      conventions,
      reviewRules,
      diffFiles,
      options.gitRoot ? cwd : gitRoot,
    );
  }

  return { conventions, reviewRules };
}

export async function loadContextSSH(
  remote: string,
  remoteCwd: string,
  gitRoot?: string,
  diffFiles: string[] = [],
): Promise<ContextResult> {
  const fs = sshFs(remote);
  const resolvedGitRoot =
    gitRoot ??
    (await sshExec(remote, `git -C ${JSON.stringify(remoteCwd)} rev-parse --show-toplevel`)
      .then((out) => out.trim())
      .catch(() => remoteCwd));

  const [conventions, reviewRules] = await Promise.all([
    walkUpContextFiles(fs, remoteCwd, ["AGENTS.md", "CLAUDE.md"], resolvedGitRoot),
    walkUpContextFiles(fs, remoteCwd, ["REVIEW.md"], resolvedGitRoot),
  ]);

  if (diffFiles.length > 0) {
    await appendTouchedFiles(
      fs,
      remoteCwd,
      resolvedGitRoot,
      conventions,
      reviewRules,
      diffFiles,
      gitRoot ? remoteCwd : resolvedGitRoot,
    );
  }

  return { conventions, reviewRules };
}
