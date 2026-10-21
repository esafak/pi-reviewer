import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  loadPiLspExtension,
  loadPiLspModule,
  partitionExtensionTools,
} from "../../src/core/lsp/extension.js";
import { findLspBinary, probeServerBinaries } from "../../src/core/lsp/probe.js";
import { withIsolatedAgentDir } from "../../src/core/lsp/config.js";

describe("partitionExtensionTools", () => {
  it("routes lsp_* tools away from MCP failure accounting", () => {
    expect(partitionExtensionTools([])).toEqual({ lsp: [], mcp: [] });
    expect(
      partitionExtensionTools(["mcp", "mcp__deepwiki_ask", "lsp_diagnostics", "lsp_hover", "read"]),
    ).toEqual({
      lsp: ["lsp_diagnostics", "lsp_hover"],
      mcp: ["mcp", "mcp__deepwiki_ask", "read"],
    });
  });
});

describe("probeServerBinaries", () => {
  const missing = {
    id: "ty",
    bin: "definitely-not-a-real-binary",
    args: [],
    include: [],
    rootMarkers: [],
    languageIdByExtension: {},
    startupTimeoutMs: 1,
    diagnosticsWaitMs: 1,
  };

  it("reports missing bare names with install hints", async () => {
    const probes = await probeServerBinaries([missing], {
      cwd: "/repo",
      roots: [],
      pathValue: `/nonexistent-dir${":"}`,
    });
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ id: "ty", found: false });
    expect(probes[0]?.installHint).toContain("ty");
  });

  it("checks absolute bins directly, without consulting PATH", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-reviewer-lsp-probe-"));
    try {
      const bin = path.join(dir, "custom-ls");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      const entry = { ...missing, id: "custom", bin };
      // Absolute path: found without consulting PATH at all.
      expect(
        await probeServerBinaries([entry], { cwd: "/repo", roots: [], pathValue: "" }),
      ).toMatchObject([{ found: true }]);
      expect(
        await probeServerBinaries([{ ...entry, bin: path.join(dir, "absent") }], {
          cwd: "/repo",
          roots: [],
          pathValue: "",
        }),
      ).toMatchObject([{ found: false }]);
      // Slash-containing relative path: resolved by the caller, never PATH-joined.
      expect(findLspBinary("./rel/bin", `/bin${":"}`)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds bare names on the injected PATH", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-reviewer-lsp-probe-"));
    try {
      const bin = path.join(dir, "on-path-ls");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      const entry = { ...missing, id: "custom", bin: "on-path-ls" };
      expect(await probeServerBinaries([entry], { cwd: "/repo", roots: [] })).toMatchObject([
        { found: false },
      ]);
      expect(
        await probeServerBinaries([entry], { cwd: "/repo", roots: [], pathValue: dir }),
      ).toMatchObject([{ found: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves root-relative bins against the matched root, not the process cwd", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-reviewer-lsp-probe-"));
    try {
      const nested = path.join(dir, "sub");
      mkdirSync(nested, { recursive: true });
      const bin = path.join(nested, "nested-ls");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      const entry = { ...missing, id: "custom", bin: path.join("sub", "nested-ls") };
      // The process cwd has no such binary: only the matched root resolves it.
      const roots = [{ id: "custom", root: dir, files: ["sub/a.x"] }];
      expect(
        await probeServerBinaries([entry], { cwd: "/nonexistent-checkout", roots, pathValue: "" }),
      ).toMatchObject([{ found: true }]);
      // Same bin with no matched roots resolves against an unrelated cwd: missing.
      expect(
        await probeServerBinaries([entry], {
          cwd: "/nonexistent-checkout",
          roots: [],
          pathValue: "",
        }),
      ).toMatchObject([{ found: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves templated bins against the nested root, not the doubled path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-reviewer-lsp-probe-"));
    try {
      const nested = path.join(dir, "sub");
      mkdirSync(nested, { recursive: true });
      const bin = path.join(nested, "custom-ls");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      writeFileSync(path.join(nested, "a.x"), "x\n");
      const entry = { ...missing, id: "custom", bin: "{dir}/custom-ls" };
      const roots = [{ id: "custom", root: nested, files: [path.join("sub", "a.x")] }];
      // Without checkout-absolutization the file resolves under sub/sub.
      expect(await probeServerBinaries([entry], { cwd: dir, roots, pathValue: "" })).toMatchObject([
        { found: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadPiLspExtension", () => {
  it("rejects PR-head project config through the real pi-lsp loader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-trust-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-trust-agent-"));
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true });
      await writeFile(
        path.join(dir, ".pi", "lsp.json"),
        JSON.stringify({ version: 1, servers: [{ id: "evil", bin: "/tmp/evil.sh", args: [] }] }),
      );
      await writeFile(
        path.join(agentDir, "lsp.json"),
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: "ty",
              include: ["**/*.py"],
              rootMarkers: ["pyproject.toml"],
              bin: "ty",
              args: ["server"],
            },
          ],
        }),
      );
      await withIsolatedAgentDir(agentDir, async () => {
        const mod = await loadPiLspModule("extensions/_shared/config.ts");
        const loadLspConfig = mod.loadLspConfig as (ctx: unknown) => Promise<{
          items: { id: string }[];
          warnings: string[];
        }>;
        const loaded = await loadLspConfig({ cwd: dir, hasUI: false });
        expect(loaded.items.map((item) => item.id)).toEqual(["ty"]);
        expect(loaded.warnings.join("\n")).toMatch(/rejected|non-interactive/);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});

describe("lsp agent tools", () => {
  async function setupExtension() {
    const tools = new Map<
      string,
      { execute: (...args: unknown[]) => Promise<unknown> } & Record<string, unknown>
    >();
    const extension = await loadPiLspExtension();
    (extension as (pi: unknown) => void)({
      registerMessageRenderer: () => {},
      registerTool: (def: unknown) => {
        const registration = def as { name?: unknown; execute?: unknown };
        if (typeof registration.name === "string" && typeof registration.execute === "function") {
          tools.set(registration.name, {
            ...(registration as Record<string, unknown>),
            execute: registration.execute as (...args: unknown[]) => Promise<unknown>,
          });
        }
      },
      on: () => {},
      sendMessage: () => {},
    });
    return tools;
  }

  it("tells the agent plainly when no server covers the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-nomatch-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-nomatch-agent-"));
    try {
      await writeFile(
        path.join(agentDir, "lsp.json"),
        JSON.stringify({
          version: 1,
          servers: [
            { id: "stub", include: ["**/*.stub"], rootMarkers: [".git"], bin: "stub-ls", args: [] },
          ],
        }),
      );
      await withIsolatedAgentDir(agentDir, async () => {
        const tools = await setupExtension();
        const hover = tools.get("lsp_hover");
        expect(hover).toBeDefined();
        const result = (await hover!.execute(
          "t1",
          { path: path.join(dir, "other.zzz"), line: 0, character: 0 },
          undefined,
          undefined,
          { cwd: dir, hasUI: false },
        )) as { content: { text: string }[] };
        expect(result.content[0]?.text).toMatch(/No matching LSP server/);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("registers usage guidance the agent can act on", async () => {
    const tools = await setupExtension();
    for (const name of ["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_references"]) {
      const tool = tools.get(name) as
        | { promptSnippet?: unknown; promptGuidelines?: unknown }
        | undefined;
      expect(tool, name).toBeDefined();
      expect(typeof tool?.promptSnippet, name).toBe("string");
      expect((tool?.promptSnippet as string).length, name).toBeGreaterThan(0);
      expect(Array.isArray(tool?.promptGuidelines), name).toBe(true);
      expect((tool?.promptGuidelines as unknown[]).length, name).toBeGreaterThan(0);
      for (const guideline of tool?.promptGuidelines as unknown[]) {
        expect(typeof guideline, name).toBe("string");
      }
    }
    for (const name of ["lsp_hover", "lsp_definition", "lsp_references"]) {
      const tool = tools.get(name) as unknown;
      const params = JSON.stringify((tool as { parameters?: unknown }).parameters ?? tool);
      expect(params, name).toContain("Zero-based");
    }
  });
});

describe("lsp agent unavailable binaries", () => {
  it("reports a missing binary as an actionable tool error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-missing-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-missing-agent-"));
    try {
      await writeFile(path.join(dir, "pyproject.toml"), '[project]\nname = "x"\n');
      await writeFile(path.join(dir, "main.py"), "x = 1\n", "utf8");
      await writeFile(
        path.join(agentDir, "lsp.json"),
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: "ty",
              include: ["**/*.py"],
              rootMarkers: ["pyproject.toml"],
              bin: "definitely-not-a-real-binary",
              args: ["server"],
            },
          ],
        }),
      );
      await withIsolatedAgentDir(agentDir, async () => {
        const tools = new Map();
        const extension = await loadPiLspExtension();
        extension({
          registerMessageRenderer: () => {},
          registerTool: (def: { name: string }) => {
            if (def && typeof def.name === "string") tools.set(def.name, def);
          },
          on: () => () => {},
          sendMessage: () => {},
        } as never);
        const hover = tools.get("lsp_hover");
        await expect(
          hover.execute(
            "t1",
            { path: path.join(dir, "main.py"), line: 0, character: 0 },
            undefined,
            undefined,
            { cwd: dir, hasUI: false },
          ),
        ).rejects.toThrow(/binary not found/);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
