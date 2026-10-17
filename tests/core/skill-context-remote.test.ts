/**
 * Remote skill loading over a fake FsOps transport. No real SSH connection —
 * sshFs is replaced with an in-memory file tree and sshExec is stubbed for
 * git root resolution. This exercises materialize → discover → remap.
 */

vi.mock("../../src/core/ssh.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/core/ssh.js")>();
  return { ...actual, sshExec: vi.fn() };
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { posix } from "node:path";
import { sshExec, type FsOps } from "../../src/core/ssh.js";
import { loadSkillContextRemote } from "../../src/core/skill-context.js";

/** Builds a fake FsOps backed by an in-memory map of absolute posix paths → content. */
function makeFakeSshFs(files: Record<string, string>): FsOps {
  return {
    async read(p) {
      return files[p] ?? null;
    },
    async list(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const children = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        children.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...children].sort();
    },
    join: posix.join,
    dirname: posix.dirname,
    relative: posix.relative,
  };
}

const SKILL_BODY = `---\nname: deploy\ndescription: Deploys things\n---\n\n# Deploy\nRun it.\n`;

beforeEach(() => {
  vi.mocked(sshExec).mockResolvedValue("/remote/root\n");
});

describe("loadSkillContextRemote", () => {
  it("discovers remote skills with remote display paths", async () => {
    const fs = makeFakeSshFs({ "/remote/root/skills/deploy/SKILL.md": SKILL_BODY });

    const result = await loadSkillContextRemote({
      remote: "user@host",
      fs,
      remoteCwd: "/remote/root",
      trustFiles: [],
      skillDirs: ["skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(result.formatted).toContain("Deploys things");
    expect(result.formatted).toContain("/remote/root/skills/deploy/SKILL.md");
    expect(result.formatted).not.toContain("pi-reviewer-skills-");
    expect(result.untrusted).toEqual([]);
  });

  it("moves touched skills to untrusted with bodies read over the transport", async () => {
    const fs = makeFakeSshFs({
      "/remote/root/skills/deploy/SKILL.md": SKILL_BODY,
      "/remote/root/skills/review/SKILL.md": SKILL_BODY.replace("deploy", "review").replace(
        "Deploys things",
        "Reviews things",
      ),
    });

    const result = await loadSkillContextRemote({
      remote: "user@host",
      fs,
      remoteCwd: "/remote/root",
      trustFiles: ["skills/deploy/SKILL.md"],
      skillDirs: ["skills"],
    });

    expect(result.skills.map((s) => s.name)).toEqual(["review"]);
    expect(result.untrusted).toHaveLength(1);
    expect(result.untrusted[0].path).toBe("skills/deploy/SKILL.md");
    expect(result.untrusted[0].content).toContain("Deploys things");
  });

  it("returns empty when no skill dirs exist remotely", async () => {
    const fs = makeFakeSshFs({});

    const result = await loadSkillContextRemote({
      remote: "user@host",
      fs,
      remoteCwd: "/remote/root",
      trustFiles: [],
      skillDirs: ["skills"],
    });

    expect(result).toEqual({ formatted: "", untrusted: [], skills: [], warnings: [] });
  });

  it("resolves touched paths against the repo root from a subdirectory", async () => {
    vi.mocked(sshExec).mockImplementation(async (_remote: string, command: string) => {
      if (command.includes("pwd -P")) return "/remote/root/packages/api\n";
      return "/remote/root\n";
    });
    const fs = makeFakeSshFs({
      "/remote/root/skills/web/SKILL.md": SKILL_BODY,
    });

    const result = await loadSkillContextRemote({
      remote: "user@host",
      fs,
      remoteCwd: "/remote/root/packages/api",
      trustFiles: ["skills/web/SKILL.md"],
      skillDirs: ["../../skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
  });

  it("resolves a logical remote cwd against the physical git root", async () => {
    vi.mocked(sshExec).mockImplementation(async (_remote: string, command: string) => {
      if (command.includes("pwd -P")) return "/physical/root\n";
      if (command.includes("rev-parse")) return "/physical/root\n";
      return "";
    });
    const fs = makeFakeSshFs({
      "/physical/root/skills/deploy/SKILL.md": SKILL_BODY,
    });

    const result = await loadSkillContextRemote({
      remote: "user@host",
      fs,
      remoteCwd: "/logical/root",
      trustFiles: ["skills/deploy/SKILL.md"],
      skillDirs: ["skills"],
    });

    expect(result.skills).toEqual([]);
    expect(result.untrusted).toHaveLength(1);
    expect(result.untrusted[0].path).toBe("skills/deploy/SKILL.md");
  });

  it("caps remote fetching at the file budget and warns", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 150; i++) {
      const name = `s${String(i).padStart(3, "0")}`;
      files[`/remote/root/skills/${name}.md`] =
        `---\nname: ${name}\ndescription: Skill ${name}\n---\n\nBody\n`;
    }
    const fs = makeFakeSshFs(files);

    const result = await loadSkillContextRemote({
      remote: "user@host",
      fs,
      remoteCwd: "/remote/root",
      trustFiles: [],
      skillDirs: ["skills"],
    });

    expect(result.skills).toHaveLength(100);
    expect(result.warnings.some((w) => w.includes("capped"))).toBe(true);
  });
});
