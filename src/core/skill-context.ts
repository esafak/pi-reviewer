import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { canonicalize, findGitRoot } from "./context.js";
import type { ContextFile } from "./context.js";
import { sshExec, type FsOps } from "./ssh.js";

/**
 * Default skill dirs, scanned unless overridden. Unlike doc-context (CI
 * opt-in), skills are default-on: an empty explicit list disables.
 */
export const DEFAULT_SKILL_DIRS = [".pi/skills", ".claude/skills", ".agents/skills", "skills"];

/** Parses a comma/newline-separated skill-dirs string into a trimmed, non-empty list. */
export function parseSkillDirs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * Resolves the effective skill dirs: an explicit list wins (empty disables),
 * the "none" sentinel disables, otherwise PI_REVIEWER_SKILLS_DIRS when
 * non-blank, otherwise the pi-style default set.
 */
export function resolveSkillDirs(explicit?: string[]): string[] {
  if (explicit !== undefined) return explicit;
  const raw = process.env.PI_REVIEWER_SKILLS_DIRS?.trim();
  if (!raw) return DEFAULT_SKILL_DIRS;
  if (raw.toLowerCase() === "none") return [];
  return parseSkillDirs(raw);
}

export interface LoadSkillContextOptions {
  cwd: string;
  /**
   * Unfiltered changed-file list backing the trust partition. Required: files
   * dropped by filterDiff caps or noise patterns stay attacker-controlled and
   * must never launder a skill into the trusted set.
   */
  trustFiles: string[];
  gitRoot?: string;
  /** Dirs relative to cwd; defaults to DEFAULT_SKILL_DIRS. Empty disables. */
  skillDirs?: string[];
}

export interface LoadSkillContextRemoteOptions {
  remote: string;
  fs: FsOps;
  remoteCwd: string;
  gitRoot?: string;
  /** Unfiltered changed-file list backing the trust partition. Required. */
  trustFiles: string[];
  skillDirs?: string[];
}

export interface SkillContextResult {
  /** formatSkillsForPrompt output for actionable skills ("" when none). */
  formatted: string;
  /** Full bodies of added/modified skill files: review targets, not guidance. */
  untrusted: ContextFile[];
  /** Actionable skills in listed-dir order after first-wins dedupe. */
  skills: Skill[];
  warnings: string[];
}

// Separator-agnostic prefix test so win32 joined paths still match.
function underDir(fileAbs: string, dirAbs: string): boolean {
  const file = fileAbs.replace(/\\/g, "/");
  const dir = dirAbs.replace(/\\/g, "/");
  return file === dir || file.startsWith(`${dir}/`);
}

// A skill owns its file, or its directory when that file is a SKILL.md.
// pi reports loose .md skills with a shared parent baseDir, so deriving the
// root from the file keeps one touched sibling from untrusting the rest.
function skillRoot(skill: Skill): string {
  const normalized = skill.filePath.replace(/\\/g, "/");
  return normalized.endsWith("/SKILL.md") ? normalized.slice(0, -"/SKILL.md".length) : normalized;
}

/** A touched path paired with its absolute form; kept together, never indexed in parallel. */
interface TouchedFile {
  path: string;
  abs: string;
}

interface AssembleSkillContextOptions {
  skills: Skill[];
  warnings: string[];
  skillDirAbsList: string[];
  touched: TouchedFile[];
  readSkillFile: (absPath: string) => Promise<string | null>;
}

// Trust-relevant caps: untrusted bodies are review evidence, not guidance,
// bounded like the other untrusted channels (100k diff, 8k PR body).
const MAX_UNTRUSTED_FILES = 20;
const MAX_UNTRUSTED_BODY_CHARS = 20_000;
const MAX_UNTRUSTED_TOTAL_CHARS = 100_000;

// First-wins dedupe, trust partition, prompt formatting, and untrusted body
// collection in one place so local and remote transports cannot diverge.
async function assembleSkillContext(
  options: AssembleSkillContextOptions,
): Promise<SkillContextResult> {
  const { skillDirAbsList, touched, readSkillFile } = options;
  const skills: Skill[] = [];
  const warnings = [...options.warnings];
  const winners = new Map<string, string>();
  for (const skill of options.skills) {
    const winner = winners.get(skill.name);
    if (winner !== undefined) {
      warnings.push(
        `skill "${skill.name}" from ${skill.filePath} ignored: already defined at ${winner}`,
      );
      continue;
    }
    winners.set(skill.name, skill.filePath);
    skills.push(skill);
  }

  const isTouchedFile = (abs: string): boolean =>
    /\.md$/i.test(abs) && skillDirAbsList.some((dir) => underDir(abs, dir));
  const isTouchedRoot = (rootAbs: string): boolean =>
    touched.some(({ abs }) => underDir(abs, rootAbs));

  // pi's loader only returns absolute filePaths for absolute search dirs, so
  // roots compare directly against the absolute touched list. Disabled skills
  // never reach the model (formatSkillsForPrompt drops them), so they leave
  // the actionable list too; their changed files still join untrusted below.
  const actionable = skills.filter(
    (skill) => !skill.disableModelInvocation && !isTouchedRoot(skillRoot(skill)),
  );

  const untrusted: ContextFile[] = [];
  let skipped = 0;
  let totalChars = 0;
  for (const { path, abs } of touched) {
    if (!isTouchedFile(abs)) continue;
    if (untrusted.length >= MAX_UNTRUSTED_FILES || totalChars >= MAX_UNTRUSTED_TOTAL_CHARS) {
      skipped += 1;
      continue;
    }
    let content = await readSkillFile(abs);
    if (content === null) {
      warnings.push(
        `${path}: touched skill file absent or unreadable at head; the diff carries the change`,
      );
      continue;
    }
    if (content.length > MAX_UNTRUSTED_BODY_CHARS) {
      content = `${content.slice(0, MAX_UNTRUSTED_BODY_CHARS)}\n[...truncated]`;
      warnings.push(`${path}: untrusted body truncated to ${MAX_UNTRUSTED_BODY_CHARS} chars`);
    }
    if (totalChars + content.length > MAX_UNTRUSTED_TOTAL_CHARS && untrusted.length > 0) {
      skipped += 1;
      continue;
    }
    totalChars += content.length;
    untrusted.push({ path, content });
  }
  if (skipped > 0) {
    warnings.push(
      `${skipped} touched skill files skipped by the untrusted budget (${MAX_UNTRUSTED_FILES} files / ${MAX_UNTRUSTED_TOTAL_CHARS} chars)`,
    );
  }

  return {
    formatted: formatSkillsForPrompt(actionable, "read"),
    untrusted,
    skills: actionable,
    warnings,
  };
}

async function readDiskSkillFile(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Discovers worktree skills, splits them by merge-base trust, and formats
 * the actionable set for the prompt. A skill whose root contains a touched
 * path may have been redefined by the PR, so it leaves the actionable set
 * and its touched files join `untrusted` as full-body review targets.
 * Discovery reuses pi's loader so SKILL.md rules stay identical to pi's.
 */
export async function loadSkillContext(
  options: LoadSkillContextOptions,
): Promise<SkillContextResult> {
  const empty: SkillContextResult = { formatted: "", untrusted: [], skills: [], warnings: [] };
  const skillDirs = options.skillDirs ?? DEFAULT_SKILL_DIRS;
  if (skillDirs.length === 0) return empty;

  // Canonicalize once: git reports physical paths while callers may pass an
  // unresolved cwd, and the trust partition compares the two namespaces.
  // Every absolute path below this point is canonical; never compare against
  // uncanonicalized caller input.
  const cwd = canonicalize(options.cwd);
  const gitRoot = options.gitRoot ? canonicalize(options.gitRoot) : (findGitRoot(cwd) ?? cwd);
  // git prints paths relative to the repo toplevel even when the diff runs
  // in a subdirectory; an explicit gitRoot override means the diff was taken
  // inside the nested repo at cwd.
  const diffRoot = options.gitRoot ? cwd : gitRoot;

  const skillDirAbsList = skillDirs.map((d) => join(cwd, d));
  const discovered: Skill[] = [];
  const warnings: string[] = [];
  for (const dir of skillDirAbsList) {
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: `repo:${dir}` });
    for (const diagnostic of diagnostics) {
      warnings.push(`${diagnostic.path ?? dir}: ${diagnostic.message}`);
    }
    discovered.push(...skills);
  }

  return assembleSkillContext({
    skills: discovered,
    warnings,
    skillDirAbsList,
    touched: options.trustFiles.map((path) => ({ path, abs: join(diffRoot, path) })),
    readSkillFile: readDiskSkillFile,
  });
}

// Remote discovery cannot use pi's loader directly (it reads local disk), so
// each skill dir's markdown is mirrored to a temp dir first. Display paths
// are remapped to remote locations before formatting, so the model reads the
// remote files with its own tools.
const MAX_REMOTE_SKILL_DEPTH = 4;
const MAX_REMOTE_SKILL_FILES = 100;
const MAX_REMOTE_SKILL_BYTES = 500_000;

interface FetchBudget {
  files: number;
  bytes: number;
}

async function fetchSkillMarkdown(
  fs: FsOps,
  remoteAbs: string,
  localAbs: string,
  depth: number,
  budget: FetchBudget,
): Promise<boolean> {
  if (depth > MAX_REMOTE_SKILL_DEPTH) return false;
  const entries = await fs.list(remoteAbs);
  let capped = false;
  for (const entry of [...entries].sort()) {
    if (entry === ".." || entry.includes("/") || entry.includes("\\")) continue;
    if (budget.files <= 0 || budget.bytes <= 0) {
      capped = true;
      break;
    }
    const remotePath = fs.join(remoteAbs, entry);
    if (entry.toLowerCase().endsWith(".md")) {
      const content = await fs.read(remotePath);
      if (content === null) continue;
      await mkdir(localAbs, { recursive: true });
      await writeFile(join(localAbs, entry), content, "utf-8");
      budget.files -= 1;
      budget.bytes -= content.length;
    } else if (depth < MAX_REMOTE_SKILL_DEPTH && !entry.startsWith(".")) {
      if (await fetchSkillMarkdown(fs, remotePath, join(localAbs, entry), depth + 1, budget)) {
        capped = true;
      }
    }
  }
  return capped;
}

export async function loadSkillContextRemote(
  options: LoadSkillContextRemoteOptions,
): Promise<SkillContextResult> {
  const { remote, fs, trustFiles } = options;
  const skillDirs = options.skillDirs ?? DEFAULT_SKILL_DIRS;
  if (skillDirs.length === 0) {
    return { formatted: "", untrusted: [], skills: [], warnings: [] };
  }

  // The trust partition compares physical paths, so any logical input is
  // resolved here first. One extra round trip per review.
  const warnings: string[] = [];
  let remoteCwd: string;
  try {
    remoteCwd = (await sshExec(remote, `cd ${JSON.stringify(options.remoteCwd)} && pwd -P`)).trim();
  } catch {
    remoteCwd = options.remoteCwd;
    warnings.push("remote cwd could not be canonicalized; skill trust uses logical paths");
  }
  const resolvedGitRoot =
    options.gitRoot ??
    (await sshExec(remote, `git -C ${JSON.stringify(remoteCwd)} rev-parse --show-toplevel`)
      .then((out) => out.trim())
      .catch(() => remoteCwd));
  const diffRoot = options.gitRoot ? remoteCwd : resolvedGitRoot;

  const tmpRoot = await mkdtemp(join(tmpdir(), "pi-reviewer-skills-"));
  try {
    const discovered: Skill[] = [];
    const skillDirAbsList = skillDirs.map((d) => fs.join(remoteCwd, d));
    // One budget across all dirs: the listed set is small and curated.
    const budget: FetchBudget = { files: MAX_REMOTE_SKILL_FILES, bytes: MAX_REMOTE_SKILL_BYTES };
    let capped = false;
    for (const [index, remoteAbs] of skillDirAbsList.entries()) {
      const tmpSub = join(tmpRoot, String(index));
      if (await fetchSkillMarkdown(fs, remoteAbs, tmpSub, 0, budget)) capped = true;
      const { skills, diagnostics } = loadSkillsFromDir({
        dir: tmpSub,
        source: `repo:${remoteAbs}`,
      });
      for (const diagnostic of diagnostics) {
        warnings.push(
          `${relocate(tmpSub, remoteAbs, diagnostic.path) ?? remoteAbs}: ${diagnostic.message}`,
        );
      }
      for (const skill of skills) {
        const filePath = relocate(tmpSub, remoteAbs, skill.filePath);
        const baseDir = relocate(tmpSub, remoteAbs, skill.baseDir);
        if (filePath === null || baseDir === null) {
          warnings.push(`skill "${skill.name}" escaped the fetch mirror, dropped`);
          continue;
        }
        discovered.push({ ...skill, filePath, baseDir });
      }
    }

    if (capped) {
      warnings.push(
        `skill fetch capped at ${MAX_REMOTE_SKILL_FILES} files / ${MAX_REMOTE_SKILL_BYTES} bytes; some skills may be missing`,
      );
    }
    return assembleSkillContext({
      skills: discovered,
      warnings,
      skillDirAbsList,
      touched: trustFiles.map((path) => ({ path, abs: fs.join(diffRoot, path) })),
      readSkillFile: (absPath) => fs.read(absPath),
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

// Moves a temp-mirrored path back into the remote namespace; returns null
// when the path escaped the mirror (defensive: entry names are filtered).
function relocate(tmpSub: string, remoteAbs: string, p: string | undefined): string | null {
  if (p === undefined) return null;
  if (p === tmpSub || p.startsWith(tmpSub + sep)) return remoteAbs + p.slice(tmpSub.length);
  return null;
}
