import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildLspPlan, type LspFileServer } from "../../src/core/lsp/config.js";
import { parseLspServers } from "../../src/core/lsp/inputs.js";
import {
  pickGroupServers,
  probeServerBinaries,
  type LspBinaryProbe,
} from "../../src/core/lsp/probe.js";

function groups(rawServers: string | undefined) {
  const selection = parseLspServers(rawServers);
  if (selection.disabled) throw new Error("expected an enabled selection");
  return buildLspPlan(selection, {}).groups;
}

function probe(id: string, found: boolean, servedFiles: string[] = []): LspBinaryProbe {
  return { id, bin: id, found, servedFiles };
}

function python(picks: ReturnType<typeof pickGroupServers>) {
  return picks.find((pick) => pick.group === "python");
}

describe("pickGroupServers", () => {
  it("serves a language with the first installed candidate, and with none when none is installed", () => {
    const installed = pickGroupServers(groups(undefined), [
      probe("ty", false),
      probe("pyrefly", true),
      probe("pyright", true),
    ]);
    expect(python(installed)?.entry?.id).toBe("pyrefly");

    const missing = pickGroupServers(groups(undefined), [
      probe("ty", false),
      probe("pyrefly", false),
      probe("pyright", false),
    ]);
    expect(python(missing)?.entry).toBeUndefined();
  });

  it("prefers the highest-priority candidate when several are installed", () => {
    const picks = pickGroupServers(groups(undefined), [probe("ty", true), probe("pyrefly", true)]);
    expect(python(picks)?.entry?.id).toBe("ty");
  });

  it("prefers the candidate that serves the language's files", () => {
    const picks = pickGroupServers(groups(undefined), [
      probe("ty", true, ["a.py"]),
      probe("pyrefly", true, ["a.py", "b.py"]),
    ]);
    expect(python(picks)?.entry?.id).toBe("pyrefly");
  });

  it("does not let a candidate matched to no file outrank one that serves files", () => {
    const picks = pickGroupServers(groups(undefined), [
      probe("ty", true, ["a.py"]),
      probe("pyrefly", true, []),
    ]);
    expect(python(picks)?.entry?.id).toBe("ty");
  });
});

describe("probeServerBinaries", () => {
  function entry(overrides: Partial<LspFileServer> = {}): LspFileServer {
    return {
      id: "ty",
      bin: "ty",
      args: [],
      include: [],
      rootMarkers: [],
      languageIdByExtension: {},
      startupTimeoutMs: 1000,
      diagnosticsWaitMs: 1000,
      ...overrides,
    };
  }

  it("serves only the files in the roots where the binary exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-probe-"));
    try {
      const withBin = path.join(dir, "with");
      const withoutBin = path.join(dir, "without");
      await mkdir(path.join(withBin, "node_modules", "bin"), { recursive: true });
      await mkdir(withoutBin, { recursive: true });
      const bin = path.join(withBin, "node_modules", "bin", "ty");
      await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(bin, 0o755);
      const probes = await probeServerBinaries([entry({ bin: "./node_modules/bin/ty" })], {
        cwd: dir,
        roots: [
          { id: "ty", root: withBin, files: ["a.py"] },
          { id: "ty", root: withoutBin, files: ["b.py"] },
        ],
        pathValue: "",
      });
      expect(probes[0]?.found).toBe(true);
      // Only the file in the root that has the binary can be served.
      expect(probes[0]?.servedFiles).toEqual(["a.py"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the candidate that serves the files over one matched to none", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-probe-"));
    try {
      const withBin = path.join(dir, "with");
      const withoutBin = path.join(dir, "without");
      await mkdir(path.join(withBin, "node_modules", "bin"), { recursive: true });
      await mkdir(withoutBin, { recursive: true });
      const bin = path.join(withBin, "node_modules", "bin", "ty");
      await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(bin, 0o755);
      // A globally installed alternative that matches no file of the diff.
      const alternative = path.join(dir, "pyrefly");
      await writeFile(alternative, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(alternative, 0o755);
      const entries = [
        entry({ id: "ty", bin: "./node_modules/bin/ty" }),
        entry({ id: "pyrefly", bin: "pyrefly" }),
      ];
      const probes = await probeServerBinaries(entries, {
        cwd: dir,
        roots: [
          { id: "ty", root: withBin, files: ["a.py"] },
          { id: "ty", root: withoutBin, files: ["b.py"] },
        ],
        pathValue: dir,
      });
      const picks = pickGroupServers(groups(undefined), probes);
      expect(python(picks)?.entry?.id).toBe("ty");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
