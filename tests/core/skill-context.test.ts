import { execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_SKILL_DIRS,
  loadSkillContext,
  parseSkillDirs,
  resolveSkillDirs,
} from "../../src/core/skill-context.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-skills-"));
  createdDirs.push(dir);
  return dir;
}

async function writeSkill(
  dir: string,
  name: string,
  description: string,
  body = `# ${name}\nDo it.\n`,
): Promise<void> {
  const skillDir = path.join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    "utf-8",
  );
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadSkillContext", () => {
  it("returns empty when no skill dirs exist", async () => {
    const root = await createTempDir();

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      gitRoot: root,
    });

    expect(result).toEqual({ formatted: "", untrusted: [], skills: [], warnings: [] });
  });

  it("returns empty when skillDirs is explicitly empty", async () => {
    const root = await createTempDir();
    await writeSkill(root, "deploy", "Deploys things");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      gitRoot: root,
      skillDirs: [],
    });

    expect(result.skills).toEqual([]);
    expect(result.formatted).toBe("");
  });

  it("discovers a SKILL.md skill and formats it for the prompt", async () => {
    const root = await createTempDir();
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.formatted).toContain("deploy");
    expect(result.formatted).toContain("Deploys things");
    expect(result.untrusted).toEqual([]);
  });

  it("moves touched skills to untrusted with full bodies", async () => {
    const root = await createTempDir();
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");
    await writeSkill(path.join(root, "skills"), "review", "Reviews things");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: ["skills/deploy/SKILL.md"],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["review"]);
    expect(result.formatted).not.toContain("deploy");
    expect(result.untrusted).toHaveLength(1);
    expect(result.untrusted[0].path).toBe("skills/deploy/SKILL.md");
    expect(result.untrusted[0].content).toContain("Deploys things");
  });

  it("treats any touched file under a skill root as touching the skill", async () => {
    const root = await createTempDir();
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");
    await writeFile(path.join(root, "skills", "deploy", "helper.sh"), "echo hi\n", "utf-8");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: ["skills/deploy/helper.sh"],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    // helper.sh is not markdown, so it is not itself a review target
    expect(result.untrusted).toEqual([]);
  });

  it("first definition wins on name collisions and warns", async () => {
    const root = await createTempDir();
    await writeSkill(path.join(root, ".pi", "skills"), "deploy", "First");
    await writeSkill(path.join(root, "skills"), "deploy", "Second");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      gitRoot: root,
      skillDirs: [".pi/skills", "skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.formatted).toContain("First");
    expect(result.warnings.some((w) => w.includes('"deploy"'))).toBe(true);
  });

  it("resolves touched paths against cwd for a nested repo with a gitRoot override", async () => {
    const outer = await createTempDir();
    const sub = path.join(outer, "pkg");
    await mkdir(sub, { recursive: true });
    execSync("git init", { cwd: sub, stdio: "ignore" });
    await writeSkill(path.join(sub, "skills"), "deploy", "Deploys things");

    // --dir shape: the diff runs inside the nested repo, so its paths are
    // relative to cwd even though the walk-up boundary is the outer root.
    const result = await loadSkillContext({
      cwd: sub,
      trustFiles: ["skills/deploy/SKILL.md"],
      gitRoot: outer,
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
  });

  it("trusts the unfiltered changed list, not the filtered diff files", async () => {
    const root = await createTempDir();
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");

    // The skill is absent from the filtered diff (e.g. capped out) but present
    // in the raw changed list: it must still count as touched.
    const result = await loadSkillContext({
      cwd: root,
      trustFiles: ["src/kept.ts", "skills/deploy/SKILL.md"],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
    expect(result.untrusted[0].path).toBe("skills/deploy/SKILL.md");
  });

  it("partitions correctly through a symlinked cwd with fully automatic roots", async () => {
    const root = await createTempDir();
    execSync("git init", { cwd: root, stdio: "ignore" });
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");
    const link = `${root}-link`;
    createdDirs.push(link);
    await symlink(root, link);

    // No explicit roots: exercises findGitRoot plus canonicalization end to end.
    const result = await loadSkillContext({
      cwd: link,
      trustFiles: ["skills/deploy/SKILL.md"],
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
  });

  it("scopes loose .md skills to their own file", async () => {
    const root = await createTempDir();
    const dir = path.join(root, "skills");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "alpha.md"),
      "---\nname: alpha\ndescription: Alpha\n---\n\nAlpha\n",
      "utf-8",
    );
    await writeFile(
      path.join(dir, "beta.md"),
      "---\nname: beta\ndescription: Beta\n---\n\nBeta\n",
      "utf-8",
    );

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: ["skills/beta.md"],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.skills.map((s) => s.name).sort()).toEqual(["alpha"]);
    expect(result.untrusted.map((f) => f.path)).toEqual(["skills/beta.md"]);
  });

  it("excludes disable-model-invocation skills from the actionable set", async () => {
    const root = await createTempDir();
    const dir = path.join(root, "skills", "quiet");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\ndescription: Quiet\ndisable-model-invocation: true\n---\n\nQuiet\n",
      "utf-8",
    );

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.formatted).toBe("");
  });

  it("surfaces loader diagnostics as warnings", async () => {
    const root = await createTempDir();
    const dir = path.join(root, "skills", "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "# No frontmatter at all\n", "utf-8");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("caps untrusted bodies by count and length", async () => {
    const root = await createTempDir();
    const dir = path.join(root, "skills");
    await mkdir(dir, { recursive: true });
    // Big file first so truncation is hit before the count cap fills.
    await writeFile(path.join(dir, "big.md"), `# Big\n${"x".repeat(30_000)}\n`, "utf-8");
    const trustFiles = ["skills/big.md"];
    for (let i = 0; i < 25; i++) {
      const name = `f${String(i).padStart(2, "0")}.md`;
      await writeFile(path.join(dir, name), `# ${name}\n`, "utf-8");
      trustFiles.push(`skills/${name}`);
    }

    const result = await loadSkillContext({
      cwd: root,
      trustFiles,
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.untrusted.length).toBeLessThanOrEqual(20);
    expect(result.warnings.some((w) => w.includes("budget"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("truncat"))).toBe(true);
  });

  it("caps the total untrusted body budget", async () => {
    const root = await createTempDir();
    const dir = path.join(root, "skills");
    await mkdir(dir, { recursive: true });
    const trustFiles: string[] = [];
    for (let i = 0; i < 6; i++) {
      const name = `t${i}.md`;
      await writeFile(path.join(dir, name), `# ${i}\n${"y".repeat(19_000)}\n`, "utf-8");
      trustFiles.push(`skills/${name}`);
    }

    const result = await loadSkillContext({
      cwd: root,
      trustFiles,
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.untrusted.length).toBeLessThan(6);
    expect(result.warnings.some((w) => w.includes("budget"))).toBe(true);
  });

  it("warns without the word unreadable when a touched skill was deleted", async () => {
    const root = await createTempDir();

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: ["skills/gone/SKILL.md"],
      gitRoot: root,
      skillDirs: ["skills"],
    });

    expect(result.untrusted).toEqual([]);
    expect(result.warnings.some((w) => w.includes("absent or unreadable at head"))).toBe(true);
  });

  it("scans coincident bases once without already-defined warnings", async () => {
    const root = await createTempDir();
    execSync("git init", { cwd: root, stdio: "ignore" });
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      skillDirs: ["skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.warnings).toEqual([]);
  });

  it("prefers the cwd scope on name clashes across bases", async () => {
    const root = await createTempDir();
    execSync("git init", { cwd: root, stdio: "ignore" });
    await writeSkill(path.join(root, ".pi", "skills"), "deploy", "Root deploy");
    const sub = path.join(root, "packages", "api");
    await mkdir(sub, { recursive: true });
    await writeSkill(path.join(sub, ".pi", "skills"), "deploy", "Local deploy");

    const result = await loadSkillContext({
      cwd: sub,
      trustFiles: [],
      skillDirs: [".pi/skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.formatted).toContain("Local deploy");
    expect(result.formatted).not.toContain("Root deploy");
  });

  it("uses absolute skill dirs as-is", async () => {
    const root = await createTempDir();
    const abs = path.join(root, "custom-skills");
    await writeSkill(abs, "deploy", "Deploys things");

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: [],
      skillDirs: [abs],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.warnings).toEqual([]);
  });

  it("canonicalizes absolute skill dirs through symlinks", async () => {
    const root = await createTempDir();
    execSync("git init", { cwd: root, stdio: "ignore" });
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");
    const link = `${root}-link`;
    createdDirs.push(link);
    await symlink(root, link);

    const result = await loadSkillContext({
      cwd: root,
      trustFiles: ["skills/deploy/SKILL.md"],
      skillDirs: [path.join(link, "skills")],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("already defined"))).toBe(false);
  });

  it("reaches root skills from a subdirectory cwd via the union", async () => {
    const root = await createTempDir();
    execSync("git init", { cwd: root, stdio: "ignore" });
    const sub = path.join(root, "packages", "api");
    await mkdir(sub, { recursive: true });
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");

    // No explicit roots: diffRoot resolves to the git toplevel while cwd is
    // the subdir, so only the union of both bases finds the skill.
    const result = await loadSkillContext({
      cwd: sub,
      trustFiles: ["skills/deploy/SKILL.md"],
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted.map((f) => f.path)).toEqual(["skills/deploy/SKILL.md"]);
  });
});

describe("resolveSkillDirs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the pi-style set when the env is unset or blank", () => {
    delete process.env.PI_REVIEWER_SKILLS_DIRS;
    expect(resolveSkillDirs()).toEqual(DEFAULT_SKILL_DIRS);
    vi.stubEnv("PI_REVIEWER_SKILLS_DIRS", "   ");
    expect(resolveSkillDirs()).toEqual(DEFAULT_SKILL_DIRS);
  });

  it("parses a non-blank env value", () => {
    vi.stubEnv("PI_REVIEWER_SKILLS_DIRS", "docs/skills, other");
    expect(resolveSkillDirs()).toEqual(["docs/skills", "other"]);
  });

  it("treats the none sentinel as disabled", () => {
    vi.stubEnv("PI_REVIEWER_SKILLS_DIRS", "None");
    expect(resolveSkillDirs()).toEqual([]);
  });

  it("lets an explicit list win, including empty to disable", () => {
    vi.stubEnv("PI_REVIEWER_SKILLS_DIRS", "docs/skills");
    expect(resolveSkillDirs([])).toEqual([]);
    expect(resolveSkillDirs(["custom"])).toEqual(["custom"]);
  });

  it("parses comma/newline-separated strings", () => {
    expect(parseSkillDirs("a,b\nc")).toEqual(["a", "b", "c"]);
    expect(parseSkillDirs(undefined)).toEqual([]);
  });
});
