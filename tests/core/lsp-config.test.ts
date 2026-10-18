import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  PI_AGENT_DIR_ENV,
  buildLspServerEntries,
  loadLspOverridesFromBase,
  parseLspOverridesFile,
  resolveLspEntries,
  serializeLspConfig,
  withIsolatedAgentDir,
  writeTrustedLspConfig,
} from "../../src/core/lsp/config.js";
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

describe("buildLspServerEntries", () => {
  it("merges presets with trusted overrides; enabled:false removes", () => {
    const entries = buildLspServerEntries(["ty", "tsc-rs"], {
      ty: { diagnosticsWaitMs: 5000 },
      "tsc-rs": { enabled: false },
    });
    expect(entries.map((entry) => entry.id)).toEqual(["ty"]);
    expect(entries[0]?.diagnosticsWaitMs).toBe(5000);
    expect(entries[0]).not.toHaveProperty("installHint");
  });

  it("fails fast on unknown ids without a full definition", () => {
    expect(() => buildLspServerEntries(["nope"], {})).toThrow('Unknown LSP server "nope"');
    expect(() => buildLspServerEntries(["nope"], { nope: { enabled: true } })).toThrow(
      'Unknown LSP server "nope"',
    );
  });

  it("accepts a full custom definition for an unknown id", () => {
    const entries = buildLspServerEntries(["custom"], {
      custom: { bin: "custom-ls", args: ["--stdio"], include: ["**/*.x"], rootMarkers: [".git"] },
    });
    expect(entries[0]).toMatchObject({ id: "custom", bin: "custom-ls", args: ["--stdio"] });
  });

  it("applies enabled:false to custom entries too", () => {
    const entries = buildLspServerEntries(["custom"], {
      custom: { enabled: false, bin: "custom-ls" },
    });
    expect(entries).toEqual([]);
  });

  it("fails fast on override entries outside the selection", () => {
    expect(() => buildLspServerEntries(["ty"], { gopls: { bin: "gopls" } })).toThrow(
      "does not match any selected server",
    );
  });

  it("serializes to the pi-lsp file shape", () => {
    const text = serializeLspConfig(buildLspServerEntries(["ty"], {}));
    const parsed = JSON.parse(text) as { version: number; servers: { id: string; bin: string }[] };
    expect(parsed.version).toBe(1);
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({ id: "ty", bin: "ty" });
  });
});

describe("resolveLspEntries", () => {
  it("returns no servers for non-comment targets", () => {
    expect(resolveLspEntries("terminal", undefined, {})).toEqual([]);
  });

  it("selects custom ids from trusted overrides", () => {
    const entries = resolveLspEntries("comment", "custom", {
      custom: { bin: "custom-ls", include: ["**/*.x"], rootMarkers: [".git"] },
    });
    expect(entries).toMatchObject([{ id: "custom", bin: "custom-ls" }]);
  });

  it("runs custom config-file servers under the blank default without enumerating presets", () => {
    const entries = resolveLspEntries("comment", undefined, {
      custom: { bin: "custom-ls", include: ["**/*.x"], rootMarkers: [".git"] },
    });
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["ty", "tsc-rs", "custom"]),
    );
  });

  it("skips disabled custom entries under the blank default without failing", () => {
    const entries = resolveLspEntries("comment", "   ", {
      // No bin: enabled:false must bypass custom-definition validation.
      custom: { enabled: false },
    });
    expect(entries.map((entry) => entry.id)).not.toContain("custom");
  });

  it("fails fast on malformed custom entries under the blank default", () => {
    expect(() => resolveLspEntries("comment", undefined, { custom: { enabled: true } })).toThrow(
      'Unknown LSP server "custom"',
    );
  });

  it("still rejects config entries outside an explicit selection", () => {
    expect(() => resolveLspEntries("comment", "ty", { gopls: { bin: "gopls" } })).toThrow(
      "does not match any selected server",
    );
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
      const entries = buildLspServerEntries(["ty"], {});
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
