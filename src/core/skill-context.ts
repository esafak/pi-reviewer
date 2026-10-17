import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { findGitRoot } from "./context.js";
import type { ContextFile } from "./context.js";

/**
 * Default skill dirs, scanned unless overridden. Unlike doc-context (CI
 * opt-in), skills are default-on: an empty explicit list disables them.
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

export interface LoadSkillContextOptions {
  cwd: string;
  diffFiles: string[];
  gitRoot?: string;
  /** Root diff paths are relative to; defaults to the diff-taken-here rule. */
  diffRoot?: string;
  /** Dirs relative to cwd; defaults to DEFAULT_SKILL_DIRS. Empty disables. */
  skillDirs?: string[];
  /** Override for tests and remote transports; defaults to disk reads. */
  readSkillFile?: (absPath: string) => Promise<string | null>;
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
  const empty: SkillContextResult = { formatted: "", untrusted: [], skills: [], warnings: [] };
  const skillDirs = options.skillDirs ?? DEFAULT_SKILL_DIRS;
  if (skillDirs.length === 0) return empty;

  // git prints paths relative to the repo toplevel even when the diff runs
  // in a subdirectory; an explicit gitRoot override means the diff was taken
  // inside the nested repo at cwd.
  const gitRoot = options.gitRoot ?? findGitRoot(cwd) ?? cwd;
  const diffRoot = options.diffRoot ?? (options.gitRoot ? cwd : gitRoot);
  const readSkillFile =
    options.readSkillFile ??
    (async (absPath: string) => {
      try {
        return await readFile(absPath, "utf-8");
      } catch {
        return null;
      }
    });

  const skillDirAbsList = skillDirs.map((d) => join(cwd, d));
  const skills: Skill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const dir of skillDirAbsList) {
    const { skills: found, diagnostics } = loadSkillsFromDir({ dir, source: `repo:${dir}` });
    for (const diagnostic of diagnostics) {
      warnings.push(`${diagnostic.path ?? dir}: ${diagnostic.message}`);
    }
    for (const skill of found) {
      if (seen.has(skill.name)) {
        warnings.push(`skill "${skill.name}" from ${skill.filePath} ignored: already defined`);
        continue;
      }
      seen.add(skill.name);
      skills.push({ ...skill, filePath: skill.filePath });
    }
  }

  const diffAbsList = diffFiles.map((f) => join(diffRoot, f));
  const isTouchedFile = (diffAbs: string): boolean =>
    /\.md$/i.test(diffAbs) && skillDirAbsList.some((dir) => underDir(diffAbs, dir));
  const isTouchedRoot = (rootAbs: string): boolean =>
    diffAbsList.some((diffAbs) => underDir(diffAbs, rootAbs));

  const actionable = skills.filter((skill) => {
    const root = skillRoot(skill);
    const rootAbs = isAbsolute(root) ? root : join(cwd, root);
    return !isTouchedRoot(rootAbs);
  });

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
