import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveBackend, type SandboxBackend } from "../../src/ci/exec/backend.js";

// Live contract suite: runs real sandboxes through whichever backend fits
// the host (bubblewrap on Linux CI, Apple Container on macOS with an image,
// MXC on Windows), skipping when no backend is present. Unit tests pin arg
// shapes with mocks; this file proves the sandbox actually holds.
function liveBackend(): SandboxBackend | undefined {
  const backend = resolveBackend();
  if (backend.name === "none") return undefined;
  // The Apple backend needs an explicit pre-pulled image; without one the
  // run would fail on configuration, not on the contract under test.
  if (backend.name === "apple-container" && !process.env.PI_REVIEWER_EXEC_IMAGE) return undefined;
  return backend;
}

const backend = liveBackend();

describe.runIf(!!backend)("live sandbox backend", () => {
  let workspace = "";
  const name = backend?.name ?? "none";

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "pi-exec-live-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("runs commands and splits stdout/stderr with exit codes", { timeout: 30_000 }, async () => {
    const result = await (backend as SandboxBackend).run({
      workspace,
      workdir: ".",
      command:
        name === "mxc" ? "echo out & echo err 1>&2 & exit 3" : "echo out; echo err >&2; exit 3",
      timeoutMs: 20_000,
      maxStreamBytes: 4096,
    } as never);
    expect(result.exitCode, `sandbox stderr: ${result.stderr}`).toBe(3);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
    expect(result.timedOut).toBe(false);
  });

  it("resolves repo-relative workdirs", { timeout: 30_000 }, async () => {
    mkdirSync(path.join(workspace, "sub"));
    const result = await (backend as SandboxBackend).run({
      workspace,
      workdir: "sub",
      command: name === "mxc" ? "cd" : "pwd",
      timeoutMs: 20_000,
      maxStreamBytes: 4096,
    } as never);
    expect(result.exitCode, `sandbox stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("sub");
  });

  it.runIf(name === "bubblewrap" || name === "apple-container")(
    "enforces the deadline",
    { timeout: 30_000 },
    async () => {
      const result = await (backend as SandboxBackend).run({
        workspace,
        workdir: ".",
        command: "sleep 60",
        timeoutMs: 3000,
        maxStreamBytes: 4096,
      } as never);
      expect(result.timedOut, `sandbox stderr: ${result.stderr}`).toBe(true);
    },
  );

  it.runIf(name === "bubblewrap")(
    "keeps .git read-only and the network detached",
    { timeout: 30_000 },
    async () => {
      mkdirSync(path.join(workspace, ".git"));
      const gitWrite = await (backend as SandboxBackend).run({
        workspace,
        workdir: ".",
        command: "touch .git/probe && echo writable",
        timeoutMs: 20_000,
        maxStreamBytes: 4096,
      } as never);
      expect(gitWrite.exitCode, `sandbox stderr: ${gitWrite.stderr}`).not.toBe(0);
      expect(gitWrite.stdout).not.toContain("writable");
      // Egress canary: must be a real, routable literal IP. Literal so a
      // DNS failure cannot mask egress; routable so fail-open actually
      // connects and the test fails. Do NOT swap in an RFC 5737
      // documentation IP — those are guaranteed unrouted and would make
      // this check pass even with full egress.
      const dial = await (backend as SandboxBackend).run({
        workspace,
        workdir: ".",
        command: "echo > /dev/tcp/93.184.216.34/80 && echo reachable",
        timeoutMs: 8000,
        maxStreamBytes: 4096,
      } as never);
      expect(dial.exitCode).not.toBe(0);
      expect(dial.stdout).not.toContain("reachable");
    },
  );
});

// On CI Linux runners bubblewrap must exist (test.yml installs it), so a
// missing backend there is a broken environment, not a skip.
it.runIf(process.platform === "linux" && process.env.CI === "true")(
  "resolves a live backend on CI Linux",
  () => {
    expect(resolveBackend().name).toBe("bubblewrap");
  },
);
