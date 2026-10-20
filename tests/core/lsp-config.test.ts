import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PI_AGENT_DIR_ENV,
  buildLspPlan,
  loadLspOverridesFromBase,
  parseLspOverridesFile,
  resolveLspPlan,
  serializeLspConfig,
  withIsolatedAgentDir,
  writeTrustedLspConfig,
} from "../../src/core/lsp/config.js";
import { parseLspServers } from "../../src/core/lsp/inputs.js";
import { gitEnv } from "../../src/core/git-env.js";

async function makeRepo(files: Record<string, string>): Promise<{ dir: string; sha: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-config-"));
  const g = (command: string) => execSync(command, { cwd: dir, stdio: "ignore", env: gitEnv() });
  g("git init");
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    g(`git add ${name}`);
  }
  g("git -c user.name=t -c user.email=t@t commit -m init");
  const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8", env: gitEnv() }).trim();
  return { dir, sha };
}

function plan(rawServers: string | undefined, overrides = {}) {
  const selection = parseLspServers(rawServers, Object.keys(overrides));
  if (selection.disabled) throw new Error("expected an enabled selection");
  return buildLspPlan(selection, overrides);
}

function groupOf(result: ReturnType<typeof plan>, id: string) {
  const group = result.groups.find((entry) => entry.group.id === id);
  if (!group) throw new Error(`expected group ${id}`);
  return group;
}

describe("parseLspOverridesFile", () => {
  it("accepts an empty object and an absent servers key", () => {
    expect(parseLspOverridesFile("{}", "lsp-config-file")).toEqual({});
    expect(parseLspOverridesFile('{"servers": []}', "lsp-config-file")).toEqual({});
    expect(
      parseLspOverridesFile(
        '{"servers": [{"id": "ty", "diagnosticsWaitMs": 5000}]}',
        "lsp-config-file",
      ),
    ).toEqual({ ty: { diagnosticsWaitMs: 5000 } });
  });

  it("rejects malformed shapes instead of passing them to pi-lsp", () => {
    expect(() => parseLspOverridesFile("{", "lsp-config-file")).toThrow("invalid JSON");
    expect(() => parseLspOverridesFile("[]", "lsp-config-file")).toThrow(
      "top-level value must be an object",
    );
    expect(() => parseLspOverridesFile('{"servers": {}}', "lsp-config-file")).toThrow(
      '"servers" must be an array',
    );
    expect(() => parseLspOverridesFile('{"servers": [{}]}', "lsp-config-file")).toThrow(
      'must be an object with a non-empty "id"',
    );
    expect(() => parseLspOverridesFile('{"servers": [{"id": ""}]}', "lsp-config-file")).toThrow(
      'must be an object with a non-empty "id"',
    );
  });
});

describe("buildLspPlan", () => {
  it("gives every language its candidates in preference order, with the language's own matching rules", () => {
    const result = plan(undefined);
    expect(groupOf(result, "python").candidates.map((entry) => entry.id)).toEqual([
      "ty",
      "pyrefly",
      "pyright",
    ]);
    expect(groupOf(result, "typescript").candidates.map((entry) => entry.id)).toEqual([
      "tsrs",
      "tsc-rs",
      "typescript-language-server",
    ]);
    expect(groupOf(result, "go").candidates.map((entry) => entry.id)).toEqual(["gopls"]);

    const candidates = groupOf(result, "python").candidates;
    expect(candidates[0]?.bin).toBe("ty");
    expect(candidates[0]?.args).toEqual(["server"]);
    expect(candidates[2]?.bin).toBe("pyright-langserver");
    expect(candidates[2]?.args).toEqual(["--stdio"]);
    // The matching rules belong to the language, not to the candidate.
    expect(candidates[0]?.include).toEqual(["**/*.py", "**/*.pyi"]);
    expect(candidates[2]?.include).toEqual(["**/*.py", "**/*.pyi"]);
    expect(candidates[2]?.rootMarkers).toEqual(candidates[0]?.rootMarkers);
    expect(candidates[2]?.languageIdByExtension).toEqual({ ".py": "python", ".pyi": "python" });
  });

  it("pins a language to the named candidates and leaves the others alone", () => {
    const result = plan("pyright");
    expect(groupOf(result, "python").candidates.map((entry) => entry.id)).toEqual(["pyright"]);
    expect(groupOf(result, "typescript").candidates.map((entry) => entry.id)).toEqual([
      "tsrs",
      "tsc-rs",
      "typescript-language-server",
    ]);
  });

  it("merges trusted overrides per candidate", () => {
    const result = plan(undefined, { ty: { diagnosticsWaitMs: 5000 } });
    const [ty] = groupOf(result, "python").candidates;
    expect(ty?.diagnosticsWaitMs).toBe(5000);
  });

  it("drops a candidate with enabled:false so the language falls back", () => {
    const result = plan(undefined, { ty: { enabled: false } });
    expect(groupOf(result, "python").candidates.map((entry) => entry.id)).toEqual([
      "pyrefly",
      "pyright",
    ]);
  });

  it("switches a whole language off through its group id", () => {
    const result = plan(undefined, { python: { enabled: false } });
    expect(result.groups.map((group) => group.group.id)).not.toContain("python");
    expect(result.groups.map((group) => group.group.id)).toContain("typescript");
  });

  it("never reclassifies a built-in candidate as a custom server", () => {
    const result = plan(undefined, {
      python: { enabled: false },
      ty: { bin: "custom-ty", diagnosticsWaitMs: 5000 },
    });
    expect(result.custom).toEqual([]);
    expect(result.groups.map((group) => group.group.id)).not.toContain("python");
  });

  it("rejects a pin that contradicts a disabled language or candidate", () => {
    expect(() => plan("pyright", { python: { enabled: false } })).toThrow(
      "lsp-config-file switches python off",
    );
    expect(() => plan("ty", { ty: { enabled: false } })).toThrow("lsp-config-file disables ty");
  });

  it("keeps the remaining pinned candidate when one of them is disabled", () => {
    const result = plan("ty,pyright", { ty: { enabled: false } });
    expect(groupOf(result, "python").candidates.map((entry) => entry.id)).toEqual(["pyright"]);
  });

  it("rejects group entries that carry per-server fields", () => {
    expect(() => plan(undefined, { python: { bin: "pyrefly" } })).toThrow(
      'LSP config entry "python" may only set "enabled"',
    );
  });

  it("keeps custom servers out of every group, running as defined", () => {
    const result = plan("pyright", {
      custom: { bin: "custom-ls", args: ["--stdio"], include: ["**/*.x"], rootMarkers: [".git"] },
    });
    expect(result.custom).toMatchObject([{ id: "custom", bin: "custom-ls", args: ["--stdio"] }]);
    // A disabled custom entry is dropped; one without a definition fails.
    expect(plan(undefined, { custom: { enabled: false } }).custom).toEqual([]);
    expect(() => plan(undefined, { custom: { enabled: true } })).toThrow(
      'Unknown LSP server "custom"',
    );
  });

  it("serializes to the pi-lsp file shape", () => {
    const text = serializeLspConfig(groupOf(plan("ty"), "python").candidates);
    const parsed = JSON.parse(text) as { version: number; servers: { id: string; bin: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({ id: "ty", bin: "ty" });
  });
});

describe("resolveLspPlan", () => {
  it("returns no servers for non-comment targets", () => {
    expect(resolveLspPlan("terminal", undefined, {})).toEqual({
      disabled: true,
      groups: [],
      custom: [],
    });
  });

  it("runs every language and the config-file servers under the blank default", () => {
    const plan = resolveLspPlan("comment", undefined, {
      custom: { bin: "custom-ls", include: ["**/*.x"], rootMarkers: [".git"] },
    });
    expect(plan.groups.map((group) => group.group.id)).toEqual(
      expect.arrayContaining(["python", "typescript", "go"]),
    );
    expect(plan.custom.map((entry) => entry.id)).toEqual(["custom"]);
  });

  it("disables everything on 'none'", () => {
    expect(resolveLspPlan("comment", "none", {}).disabled).toBe(true);
  });
});

describe("loadLspOverridesFromBase", () => {
  it("reads the file from the default-branch revision, not the checkout", async () => {
    const { dir, sha } = await makeRepo({
      ".pi/lsp.json": JSON.stringify({ servers: [{ id: "ty", diagnosticsWaitMs: 5000 }] }),
    });
    try {
      // Diverge the checkout: the loader must still read the committed revision.
      await writeFile(path.join(dir, ".pi", "lsp.json"), JSON.stringify({ servers: {} }), "utf8");
      const overrides = loadLspOverridesFromBase(dir, sha, ".pi/lsp.json");
      expect(overrides).toEqual({ ty: { diagnosticsWaitMs: 5000 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty overrides when no file is configured", async () => {
    const { dir, sha } = await makeRepo({ "a.ts": "1\n" });
    try {
      expect(loadLspOverridesFromBase(dir, sha, undefined)).toEqual({});
      expect(loadLspOverridesFromBase(dir, sha, "  ")).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing files, bad SHAs, and non-normalized paths", async () => {
    const { dir, sha } = await makeRepo({ "a.ts": "1\n" });
    try {
      expect(() => loadLspOverridesFromBase(dir, sha, ".pi/missing.json")).toThrow(
        "trusted default branch revision",
      );
      expect(() => loadLspOverridesFromBase(dir, "deadbeef", ".pi/lsp.json")).toThrow(
        "invalid default branch SHA",
      );
      expect(() => loadLspOverridesFromBase(dir, sha, "../evil.json")).toThrow(
        "normalized repository-relative path",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("trusted config bridge", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes lsp.json into the isolated dir and restores PI_AGENT_DIR", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-bridge-"));
    try {
      const entries = groupOf(plan("ty"), "python").candidates;
      const previous = process.env[PI_AGENT_DIR_ENV];
      await withIsolatedAgentDir(dir, async () => {
        expect(process.env[PI_AGENT_DIR_ENV]).toBe(dir);
        const filePath = await writeTrustedLspConfig(dir, entries);
        const raw = await readFile(filePath, "utf8");
        expect(JSON.parse(raw).servers[0]).toMatchObject({ id: "ty", bin: "ty" });
        expect(raw).not.toContain("installHint");
        throw new Error("boom");
      }).catch((error: unknown) => {
        expect((error as Error).message).toBe("boom");
      });
      expect(process.env[PI_AGENT_DIR_ENV]).toBe(previous);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores absence when PI_AGENT_DIR was unset", async () => {
    vi.stubEnv(PI_AGENT_DIR_ENV, undefined as unknown as string);
    delete process.env[PI_AGENT_DIR_ENV];
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-bridge-"));
    try {
      await withIsolatedAgentDir(dir, async () => {
        expect(process.env[PI_AGENT_DIR_ENV]).toBe(dir);
      });
      expect(PI_AGENT_DIR_ENV in process.env).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
