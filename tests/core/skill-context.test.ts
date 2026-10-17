import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadSkillContext } from "../../src/core/skill-context.js";

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

    const result = await loadSkillContext({ cwd: root, diffFiles: [], gitRoot: root });

    expect(result).toEqual({ formatted: "", untrusted: [], skills: [], warnings: [] });
  });

  it("returns empty when skillDirs is explicitly empty", async () => {
    const root = await createTempDir();
    await writeSkill(root, "deploy", "Deploys things");

    const result = await loadSkillContext({
      cwd: root,
      diffFiles: [],
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
      diffFiles: [],
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
      diffFiles: ["skills/deploy/SKILL.md"],
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
      diffFiles: ["skills/deploy/helper.sh"],
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
      diffFiles: [],
      gitRoot: root,
      skillDirs: [".pi/skills", "skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.formatted).toContain("First");
    expect(result.warnings.some((w) => w.includes('"deploy"'))).toBe(true);
  });

  it("resolves touched paths against diffRoot when cwd is a subdirectory", async () => {
    const root = await createTempDir();
    const sub = path.join(root, "packages", "api");
    await mkdir(sub, { recursive: true });
    await writeSkill(path.join(root, "skills"), "deploy", "Deploys things");

    const result = await loadSkillContext({
      cwd: sub,
      diffFiles: ["skills/deploy/SKILL.md"],
      gitRoot: root,
      diffRoot: root,
      skillDirs: ["../../skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
  });
});
