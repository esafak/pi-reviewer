import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { findGitRoot } from "./context.js";
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
 * otherwise PI_REVIEWER_SKILLS_DIRS when non-blank, otherwise the pi-style
 * default set.
 */
export function resolveSkillDirs(explicit?: string[]): string[] {
  if (explicit !== undefined) return explicit;
  const raw = process.env.PI_REVIEWER_SKILLS_DIRS?.trim();
  return raw ? parseSkillDirs(raw) : DEFAULT_SKILL_DIRS;
}

export interface LoadSkillContextOptions {
  cwd: string;
  diffFiles: string[];
  gitRoot?: string;
  /** Root diff paths are relative to; defaults to the diff-taken-here rule. */
  diffRoot?: string;
  /** Dirs relative to cwd; defaults to DEFAULT_SKILL_DIRS. Empty disables. */
  skillDirs?: string[];
  /** Override for tests; defaults to disk reads. */
  readSkillFile?: (absPath: string) => Promise<string | null>;
}

export interface LoadSkillContextRemoteOptions {
  remote: string;
  fs: FsOps;
  remoteCwd: string;
  gitRoot?: string;
  diffFiles: string[];
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

// A skill's trust granularity is its root, which pi's loader reports as
// baseDir (the SKILL.md directory, or the loose file's own directory).
function skillRoot(skill: Skill): string {
  if (skill.baseDir) return skill.baseDir.replace(/\\/g, "/");
  const normalized = skill.filePath.replace(/\\/g, "/");
  return normalized.endsWith("/SKILL.md") ? normalized.slice(0, -"/SKILL.md".length) : normalized;
}

interface AssembleSkillContextOptions {
  skills: Skill[];
  warnings: string[];
  skillDirAbsList: string[];
  diffAbsList: string[];
  diffFiles: string[];
  readSkillFile: (absPath: string) => Promise<string | null>;
}

// First-wins dedupe, trust partition, prompt formatting, and untrusted body
// collection in one place so local and remote transports cannot diverge.
async function assembleSkillContext(
  options: AssembleSkillContextOptions,
): Promise<SkillContextResult> {
  const { skillDirAbsList, diffAbsList, diffFiles, readSkillFile } = options;
  const skills: Skill[] = [];
  const warnings = [...options.warnings];
  const seen = new Set<string>();
  for (const skill of options.skills) {
    if (seen.has(skill.name)) {
      warnings.push(`skill "${skill.name}" from ${skill.filePath} ignored: already defined`);
      continue;
    }
    seen.add(skill.name);
    skills.push(skill);
  }

  const isTouchedFile = (diffAbs: string): boolean =>
    /\.md$/i.test(diffAbs) && skillDirAbsList.some((dir) => underDir(diffAbs, dir));
  const isTouchedRoot = (rootAbs: string): boolean =>
    diffAbsList.some((diffAbs) => underDir(diffAbs, rootAbs));

  // pi's loader only returns absolute filePaths for absolute search dirs, so
  // roots compare directly against the absolute diff list.
  const actionable = skills.filter((skill) => !isTouchedRoot(skillRoot(skill)));

  const untrusted: ContextFile[] = [];
  for (const [index, file] of diffFiles.entries()) {
    if (!isTouchedFile(diffAbsList[index])) continue;
    const content = await readSkillFile(diffAbsList[index]);
    if (content === null) {
      warnings.push(`${file}: touched skill file is unreadable, skipped`);
      continue;
    }
    untrusted.push({ path: file, content });
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
  const { cwd, diffFiles } = options;
  const skillDirs = options.skillDirs ?? DEFAULT_SKILL_DIRS;
  if (skillDirs.length === 0) {
    return { formatted: "", untrusted: [], skills: [], warnings: [] };
  }

  // git prints paths relative to the repo toplevel even when the diff runs
  // in a subdirectory; an explicit gitRoot override means the diff was taken
  // inside the nested repo at cwd.
  const gitRoot = options.gitRoot ?? findGitRoot(cwd) ?? cwd;
  const diffRoot = options.diffRoot ?? (options.gitRoot ? cwd : gitRoot);

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
    diffAbsList: diffFiles.map((f) => join(diffRoot, f)),
    diffFiles,
    readSkillFile: options.readSkillFile ?? readDiskSkillFile,
  });
}

// Remote discovery cannot use pi's loader directly (it reads local disk),
// so each skill dir's markdown is mirrored to a temp dir first. Display paths
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
): Promise<void> {
  if (depth > MAX_REMOTE_SKILL_DEPTH || budget.files <= 0 || budget.bytes <= 0) return;
  const entries = await fs.list(remoteAbs);
  for (const entry of [...entries].sort()) {
    if (budget.files <= 0 || budget.bytes <= 0) break;
    const remotePath = fs.join(remoteAbs, entry);
    if (entry.toLowerCase().endsWith(".md")) {
      const content = await fs.read(remotePath);
      if (content === null) continue;
      await mkdir(localAbs, { recursive: true });
      await writeFile(join(localAbs, entry), content, "utf-8");
      budget.files -= 1;
      budget.bytes -= content.length;
    } else if (depth < MAX_REMOTE_SKILL_DEPTH && !entry.startsWith(".")) {
      await fetchSkillMarkdown(fs, remotePath, join(localAbs, entry), depth + 1, budget);
    }
  }
}

export async function loadSkillContextRemote(
  options: LoadSkillContextRemoteOptions,
): Promise<SkillContextResult> {
  const { remote, fs, remoteCwd, diffFiles } = options;
  const skillDirs = options.skillDirs ?? DEFAULT_SKILL_DIRS;
  if (skillDirs.length === 0) {
    return { formatted: "", untrusted: [], skills: [], warnings: [] };
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
    const warnings: string[] = [];
    const skillDirAbsList = skillDirs.map((d) => fs.join(remoteCwd, d));
    for (const [index, remoteAbs] of skillDirAbsList.entries()) {
      const tmpSub = join(tmpRoot, String(index));
      await fetchSkillMarkdown(fs, remoteAbs, tmpSub, 0, {
        files: MAX_REMOTE_SKILL_FILES,
        bytes: MAX_REMOTE_SKILL_BYTES,
      });
      const { skills, diagnostics } = loadSkillsFromDir({
        dir: tmpSub,
        source: `repo:${remoteAbs}`,
      });
      for (const diagnostic of diagnostics) {
        const relocated =
          typeof diagnostic.path === "string" && diagnostic.path.startsWith(tmpSub + sep)
            ? remoteAbs + diagnostic.path.slice(tmpSub.length)
            : remoteAbs;
        warnings.push(`${relocated}: ${diagnostic.message}`);
      }
      for (const skill of skills) {
        const relocate = (p: string): string =>
          p === tmpSub || p.startsWith(tmpSub + sep) ? remoteAbs + p.slice(tmpSub.length) : p;
        discovered.push({
          ...skill,
          filePath: relocate(skill.filePath),
          baseDir: relocate(skill.baseDir),
        });
      }
    }

    return assembleSkillContext({
      skills: discovered,
      warnings,
      skillDirAbsList,
      diffAbsList: diffFiles.map((f) => fs.join(diffRoot, f)),
      diffFiles,
      readSkillFile: (absPath) => fs.read(absPath),
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
