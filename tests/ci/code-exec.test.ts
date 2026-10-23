import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

import { parseCodeExecMaxCalls, resolveCodeExecConfig } from "../../src/ci/code-exec/config.js";
import { isSecretEnvName, pickEnv } from "../../src/ci/code-exec/env.js";
import { isRecord } from "../../src/ci/registry/helpers.js";
import {
  AppleContainerBackend,
  BubblewrapBackend,
  FailClosedBackend,
  isAppleContainerAvailable,
  isMxcAvailable,
  MxcBackend,
  resolveBackend,
} from "../../src/ci/code-exec/backend.js";
import {
  buildBwrapArgs,
  collectCapped,
  isBubblewrapAvailable,
  resolveWorkdir,
  runSandboxed,
  SANDBOX_HOME,
  truncateBytes,
} from "../../src/ci/code-exec/runner.js";
import { createCodeExecTools, codeExecSchema } from "../../src/ci/code-exec/tool.js";
import {
  BWRAP_PROC_ERROR,
  diagnoseBwrapFailure,
  readApparmorProfile,
} from "../../src/ci/code-exec/diagnose.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

type FakeChild = {
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  on: (event: "close", cb: (code: number | null) => void) => FakeChild;
  emit: (event: "close", code: number | null) => void;
};

function fakeChild(): FakeChild {
  const handlers = new Map<"close", ((code: number | null) => void)[]>();
  const child: FakeChild = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    unref: vi.fn(() => child),
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return child;
    },
    emit: (event, ...args) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
  };
  return child;
}

function autoClosingChild(code: number | null = 0): FakeChild {
  const child = fakeChild();
  queueMicrotask(() => child.emit("close", code));
  return child;
}

/** The text of one tool result block. */
function blockText(block: TextContent | ImageContent): string {
  if (block.type !== "text") throw new Error("expected a text block");
  return block.text;
}

describe("code-exec config", () => {
  it("defaults to disabled with 120s timeout and call budgets", () => {
    const config = resolveCodeExecConfig({});
    expect(config.enabled).toBe(false);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.maxCalls).toBe(5);
    expect(config.wallBudgetMs).toBe(360_000);
  });

  it("parses timeout/call budgets with safe bounds", () => {
    const config = resolveCodeExecConfig({
      PI_REVIEWER_CODE_EXEC: "true",
      PI_REVIEWER_CODE_EXEC_TIMEOUT_MS: "999999",
      PI_REVIEWER_CODE_EXEC_MAX_CALLS: "99",
      PI_REVIEWER_CODE_EXEC_WALL_BUDGET_MS: "1",
    });
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.maxCalls).toBe(10);
    expect(config.wallBudgetMs).toBe(30_000);
    expect(parseCodeExecMaxCalls("invalid")).toBe(5);
  });
});

describe("code-exec runner", () => {
  it("resolves repo-relative workdirs and rejects escapes", () => {
    expect(resolveWorkdir("/ws", ".")).toBe("/ws");
    expect(resolveWorkdir("/ws", "packages/ui")).toBe("/ws/packages/ui");
    expect(() => resolveWorkdir("/ws", "/etc")).toThrow("repo-relative");
    expect(() => resolveWorkdir("/ws", "../outside")).toThrow("escapes");
  });

  it("fails closed off Linux or without bwrap", () => {
    expect(isBubblewrapAvailable({ platform: "darwin", exists: () => true })).toBe(false);
    expect(isBubblewrapAvailable({ platform: "linux", exists: () => false })).toBe(false);
    expect(isBubblewrapAvailable({ platform: "linux", exists: () => true })).toBe(true);
  });

  it("binds the workspace writable with read-only .git and no shared net", () => {
    const args = buildBwrapArgs({
      workspace: "/ws",
      workdir: ".",
      command: "pytest -q",
      timeoutMs: 120_000,
      maxStreamBytes: 1024,
      exists: (p) => p === "/ws/.git" || p === "/usr",
    });
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--bind");
    expect(args).toContain("--ro-bind");
    const gitIndex = args.lastIndexOf("--ro-bind");
    expect(args[gitIndex + 1]).toBe("/ws/.git");
  });

  it("provides passwd/group binds and a scratch HOME with re-rooted caches", () => {
    vi.stubEnv("HOME", "/fake/home");
    try {
      const args = buildBwrapArgs({
        workspace: "/ws",
        workdir: ".",
        command: "pytest -q",
        timeoutMs: 120_000,
        maxStreamBytes: 1024,
        exists: (p) => p === "/fake/home/.cargo" || p === "/etc/passwd" || p === "/etc/group",
      });
      expect(args).toContain("/etc/passwd");
      expect(args).toContain("/etc/group");
      expect(args).toContain(SANDBOX_HOME);
      const setenvIndex = args.indexOf("--setenv");
      expect(args.slice(setenvIndex, setenvIndex + 3)).toEqual(["--setenv", "HOME", SANDBOX_HOME]);
      // Toolchain caches stay visible under both the real path and the
      // scratch HOME so $HOME-relative lookups keep working.
      expect(args).toContain("/fake/home/.cargo");
      expect(args).toContain(`${SANDBOX_HOME}/.cargo`);
      // Parent mounts precede their children: a later tmpfs would cover and
      // hide the earlier cache binds (bwrap applies ops in argv order).
      const firstTmpfs = args.indexOf("--tmpfs");
      expect(firstTmpfs).toBeGreaterThanOrEqual(0);
      expect(firstTmpfs).toBeLessThan(args.indexOf(`${SANDBOX_HOME}/.cargo`));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps a fresh procfs by default and reuses /proc read-only in bind mode", () => {
    const base = {
      workspace: "/ws",
      workdir: ".",
      command: "echo hi",
      timeoutMs: 120_000,
      maxStreamBytes: 1024,
      exists: () => false,
    };
    const procArgs = buildBwrapArgs(base);
    const procIndex = procArgs.indexOf("--proc");
    expect(procIndex).toBeGreaterThanOrEqual(0);
    expect(procArgs[procIndex + 1]).toBe("/proc");
    const bindArgs = buildBwrapArgs(base, "bind");
    expect(bindArgs).not.toContain("--proc");
    const idx = bindArgs.indexOf("/proc");
    expect(bindArgs.slice(idx - 1, idx + 2)).toEqual(["--ro-bind", "/proc", "/proc"]);
  });
});

describe("code-exec tool", () => {
  it("is named code_exec so the model treats it as code execution", () => {
    const [tool] = createCodeExecTools(resolveCodeExecConfig({ PI_REVIEWER_CODE_EXEC: "true" }), {
      cwd: "/ws",
    });
    expect(tool.name).toBe("code_exec");
    expect(tool.description).toMatch(/This is code execution, not a read-only lookup/);
    expect(tool.description).toMatch(/Keep commands portable/);
  });

  it("exposes a flat schema and stays disabled unless opted in", () => {
    expect((codeExecSchema as any).additionalProperties).toBe(false);
    expect(Object.keys((codeExecSchema as any).properties)).toEqual([
      "command",
      "workdir",
      "timeoutMs",
    ]);
    expect(createCodeExecTools(resolveCodeExecConfig({}))).toHaveLength(0);
    expect(
      createCodeExecTools(resolveCodeExecConfig({ PI_REVIEWER_CODE_EXEC: "true" }), { cwd: "/ws" }),
    ).toHaveLength(1);
  });

  it("returns stdout and stderr as separate blocks and details fields", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 1,
      stdout: "3 passed",
      stderr: "FAILED test_x",
      stdoutTruncated: false,
      stderrTruncated: true,
      timedOut: false,
    });
    const [tool] = createCodeExecTools(resolveCodeExecConfig({ PI_REVIEWER_CODE_EXEC: "true" }), {
      cwd: "/ws",
      runner: runner as any,
    });
    const result = await tool.execute("id", { command: "pytest -q" } as any);
    expect(runner).toHaveBeenCalledOnce();
    // Trusted status lines stay in their own block so command output cannot
    // spoof the exit line or the remaining-calls counter.
    expect(result.content).toHaveLength(3);
    expect(blockText(result.content[0])).toContain("exit 1");
    expect(blockText(result.content[0])).toContain("Remaining code_exec calls");
    expect(blockText(result.content[0])).not.toContain("3 passed");
    expect(blockText(result.content[1])).toContain("[stdout");
    expect(blockText(result.content[1])).toContain("3 passed");
    expect(blockText(result.content[2])).toContain("[stderr");
    expect(blockText(result.content[2])).toContain("FAILED test_x");
    expect(result.details).toMatchObject({
      stdout: "3 passed",
      stderr: "FAILED test_x",
      exitCode: 1,
      stderrTruncated: true,
    });
  });

  it("clamps per-call timeouts to the configured default", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    });
    const [tool] = createCodeExecTools(resolveCodeExecConfig({ PI_REVIEWER_CODE_EXEC: "true" }), {
      cwd: "/ws",
      runner: runner as any,
    });
    await tool.execute("id", { command: "echo hi", timeoutMs: 999999 } as any);
    expect(runner.mock.calls[0][0]).toMatchObject({ timeoutMs: 120_000 });
  });

  it("caps the call at the remaining wall-clock budget", async () => {
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    });
    const config = resolveCodeExecConfig({
      PI_REVIEWER_CODE_EXEC: "true",
      PI_REVIEWER_CODE_EXEC_WALL_BUDGET_MS: "30000",
    });
    const [tool] = createCodeExecTools(config, {
      cwd: "/ws",
      state: { calls: 0, wallMs: 20_000 },
      runner: runner as any,
    });
    await tool.execute("id", { command: "echo hi" } as any);
    expect(runner.mock.calls[0][0]).toMatchObject({ timeoutMs: 10_000 });
  });

  it("rejects calls below the per-call floor instead of launching doomed runs", async () => {
    const runner = vi.fn();
    const config = resolveCodeExecConfig({
      PI_REVIEWER_CODE_EXEC: "true",
      PI_REVIEWER_CODE_EXEC_WALL_BUDGET_MS: "30000",
    });
    const [tool] = createCodeExecTools(config, {
      cwd: "/ws",
      state: { calls: 0, wallMs: 29_500 },
      runner: runner as any,
    });
    await expect(tool.execute("id", { command: "echo hi" } as any)).rejects.toThrow(
      "wall-clock budget exhausted",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it("enforces the per-review call budget", async () => {
    const config = resolveCodeExecConfig({
      PI_REVIEWER_CODE_EXEC: "true",
      PI_REVIEWER_CODE_EXEC_MAX_CALLS: "1",
    });
    const state = { calls: 1, wallMs: 0 };
    const [tool] = createCodeExecTools(config, { cwd: "/ws", state });
    await expect(tool.execute("id", { command: "echo hi" } as any)).rejects.toThrow(
      "budget exhausted",
    );
  });

  it("counts failed attempts against the call budget", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("boom"));
    const config = resolveCodeExecConfig({
      PI_REVIEWER_CODE_EXEC: "true",
      PI_REVIEWER_CODE_EXEC_MAX_CALLS: "1",
    });
    const state = { calls: 0, wallMs: 0 };
    const [tool] = createCodeExecTools(config, { cwd: "/ws", state, runner: runner as any });
    await expect(tool.execute("id", { command: "echo hi" } as any)).rejects.toThrow("boom");
    await expect(tool.execute("id", { command: "echo hi" } as any)).rejects.toThrow(
      "budget exhausted",
    );
    expect(runner).toHaveBeenCalledOnce();
  });

  it("enforces the wall-clock budget", async () => {
    const config = resolveCodeExecConfig({
      PI_REVIEWER_CODE_EXEC: "true",
      PI_REVIEWER_CODE_EXEC_WALL_BUDGET_MS: "30000",
    });
    const state = { calls: 0, wallMs: 30_000 };
    const [tool] = createCodeExecTools(config, { cwd: "/ws", state });
    await expect(tool.execute("id", { command: "echo hi" } as any)).rejects.toThrow(
      "wall-clock budget exhausted",
    );
  });

  it("refuses to run when the backend is unavailable instead of downgrading", async () => {
    const [tool] = createCodeExecTools(resolveCodeExecConfig({ PI_REVIEWER_CODE_EXEC: "true" }), {
      cwd: "/ws",
      backend: new FailClosedBackend("test refusal"),
    });
    await expect(tool.execute("id", { command: "echo hi" } as any)).rejects.toThrow(
      "code execution unavailable: test refusal",
    );
  });
});

describe("sandbox backends", () => {
  it("resolves bubblewrap on Linux and Apple Container on macOS", () => {
    expect(resolveBackend({ platform: "linux", exists: () => true })).toBeInstanceOf(
      BubblewrapBackend,
    );
    const mac = resolveBackend({ platform: "darwin", arch: "arm64", exists: () => true });
    expect(mac).toBeInstanceOf(AppleContainerBackend);
    expect(mac.name).toBe("apple-container");
    expect(
      isAppleContainerAvailable({ platform: "darwin", arch: "arm64", exists: () => true }),
    ).toBe(true);
    expect(
      isAppleContainerAvailable({ platform: "darwin", arch: "arm64", exists: () => false }),
    ).toBe(false);
    expect(
      isAppleContainerAvailable({ platform: "linux", arch: "arm64", exists: () => true }),
    ).toBe(false);
  });

  it("fail-closes when no runtime is present", () => {
    const none = resolveBackend({ platform: "darwin", arch: "arm64", exists: () => false });
    expect(none).toBeInstanceOf(FailClosedBackend);
    expect(none.isAvailable()).toBe(false);
    expect(none.name).toBe("none");
  });

  it("resolves MXC on Windows with processcontainer support", () => {
    const load = () => ({
      getPlatformSupport: () => ({ isSupported: true, availableMethods: ["processcontainer"] }),
    });
    const backend = resolveBackend({ platform: "win32", mxcLoad: load });
    expect(backend).toBeInstanceOf(MxcBackend);
    expect(backend.name).toBe("mxc");
    expect(
      isMxcAvailable({
        platform: "win32",
        load: () => {
          throw new Error("no sdk");
        },
      }),
    ).toBe(false);
    expect(isMxcAvailable({ platform: "linux", load })).toBe(false);
    expect(
      isMxcAvailable({
        platform: "win32",
        load: () => ({ getPlatformSupport: () => ({ isSupported: false }) }),
      }),
    ).toBe(false);
  });

  it("maps MXC results to split streams with the deny-egress contract", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "ok",
      stderr: "warn",
      exitCode: 0,
      timedOut: false,
    });
    const backend = new MxcBackend(() => ({ getPlatformSupport: () => ({}), run }));
    const workspace = process.cwd();
    const result = await backend.run({
      workspace,
      workdir: ".",
      command: "pytest -q",
      timeoutMs: 60_000,
      maxStreamBytes: 2,
    } as any);
    expect(run).toHaveBeenCalledOnce();
    const request = run.mock.calls[0][0];
    expect(request.network).toEqual({ egress: { default: "deny" } });
    // Scratch lives inside the workspace: no host path is readable or
    // writable through temp files.
    expect(request.filesystem.readwritePaths).toEqual([workspace]);
    expect(request.filesystem.readonlyPaths).toEqual(
      expect.arrayContaining([expect.stringContaining(".git")]),
    );
    expect(request.inheritDefaultEnvironment).toBe(false);
    expect(request.ui).toEqual({ disable: true });
    expect(result).toMatchObject({
      stdout: "ok",
      stderr: "wa",
      stderrTruncated: true,
      exitCode: 0,
      timedOut: false,
    });
  });

  it("points MXC temp env at workspace scratch and cleans it up", async () => {
    // Capture before stubbing: os.tmpdir() honors TEMP, and the stub below
    // would otherwise poison the mkdtemp parent on hosts without TMPDIR.
    const parent = tmpdir();
    vi.stubEnv("TEMP", "/host/temp");
    const workspace = mkdtempSync(path.join(parent, "pi-code-exec-test-"));
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    try {
      const backend = new MxcBackend(() => ({ run }));
      await backend.run({
        workspace,
        workdir: ".",
        command: "pytest -q",
        timeoutMs: 1000,
        maxStreamBytes: 64,
      } as any);
      const request = run.mock.calls[0][0];
      const scratch = path.join(workspace, ".pi-code-exec-tmp");
      expect(request.environment.TMP).toBe(scratch);
      expect(request.environment.TEMP).toBe(scratch);
      expect(request.filesystem.readwritePaths).toEqual([workspace]);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("fail-closed backend never executes", async () => {
    await expect(new FailClosedBackend("nope").run({} as any)).rejects.toThrow(
      "code execution unavailable",
    );
  });

  it("never inherits the host temp dir into MXC policy", async () => {
    vi.stubEnv("TEMP", "/host/temp");
    vi.stubEnv("TMP", "/host/tmp");
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    try {
      const backend = new MxcBackend(() => ({ run }));
      await backend.run({
        workspace: process.cwd(),
        workdir: ".",
        command: "pytest -q",
        timeoutMs: 1000,
        maxStreamBytes: 64,
      } as any);
      const request = run.mock.calls[0][0];
      expect(request.filesystem.readwritePaths).toEqual([process.cwd()]);
      expect(request.environment.TMP).not.toBe("/host/tmp");
      expect(request.environment.TEMP).not.toBe("/host/temp");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects missing workdirs and empty commands before spawning", async () => {
    const backend = new AppleContainerBackend("img");
    vi.spyOn(backend, "isAvailable").mockReturnValue(true);
    await expect(
      backend.run({
        workspace: process.cwd(),
        workdir: "does-not-exist",
        command: "echo hi",
        timeoutMs: 1000,
        maxStreamBytes: 64,
      } as any),
    ).rejects.toThrow("does not exist");
    await expect(
      backend.run({
        workspace: process.cwd(),
        workdir: ".",
        command: "   ",
        timeoutMs: 1000,
        maxStreamBytes: 64,
      } as any),
    ).rejects.toThrow("non-empty");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("env scrub", () => {
  it("blocks secret names anywhere in the variable", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "PI_API_KEY",
      "PROVIDER_API-KEY",
      "NPM_SECRET",
      "DB_PASSWORD",
      "AWS_CREDENTIALS",
      "PRIVATE_KEY",
      "KEY_VAULT_HOST",
      "ENC_KEY",
    ])
      expect(isSecretEnvName(name)).toBe(true);
    for (const name of ["PATH", "MONKEY", "KEYBOARD", "LANG"])
      expect(isSecretEnvName(name)).toBe(false);
  });

  it("picks allowlisted vars and drops secrets sharing the allowlist", () => {
    vi.stubEnv("GITHUB_TOKEN", "secret");
    try {
      const env = pickEnv(["PATH", "GITHUB_TOKEN"]);
      expect(env.PATH).toBeDefined();
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("confined-runtime diagnosis", () => {
  it("strips the enforce suffix and never throws", () => {
    expect(readApparmorProfile(() => "cri-containerd.apparmor.d (enforce)")).toBe(
      "cri-containerd.apparmor.d",
    );
    expect(readApparmorProfile(() => "unconfined")).toBe("unconfined");
    expect(readApparmorProfile(() => "unprivileged_userns (enforce)")).toBe("unprivileged_userns");
    expect(readApparmorProfile(() => "")).toBeUndefined();
    expect(diagnoseBwrapFailure("bwrap: Failed to make / slave", undefined)?.kind).toBe(
      "apparmor-confined",
    );
    expect(
      readApparmorProfile(() => {
        throw new Error("no proc");
      }),
    ).toBeUndefined();
  });

  it("classifies the slave failure by errno and keeps host remedies out", () => {
    const apparmor = diagnoseBwrapFailure(
      "bwrap: Failed to make / slave: Permission denied",
      "cri-containerd.apparmor.d",
    );
    expect(apparmor?.kind).toBe("apparmor-confined");
    expect(apparmor?.hint).toContain("pod-level AppArmor profile");
    for (const banned of [
      "sysctl",
      "apparmor_restrict_unprivileged_userns",
      "bwrap-userns-restrict",
    ])
      expect(apparmor?.hint).not.toContain(banned);
    const seccomp = diagnoseBwrapFailure(
      "bwrap: Failed to make / slave: Operation not permitted",
      "cri-containerd.apparmor.d",
    );
    expect(seccomp?.kind).toBe("seccomp-denied");
    expect(seccomp?.hint).toContain("securityContext.seccompProfile");
    for (const banned of ["sysctl", "bwrap-userns-restrict"])
      expect(seccomp?.hint).not.toContain(banned);
    expect(
      diagnoseBwrapFailure("bwrap: Can't find source path: /x", "cri-containerd.apparmor.d"),
    ).toBeUndefined();
  });

  it("classifies the nested-userns proc failure without host remedies", () => {
    const diagnosis = diagnoseBwrapFailure(
      "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
      "my-container-profile",
    );
    expect(diagnosis?.kind).toBe("proc-mount-denied");
    expect(diagnosis?.profile).toBe("my-container-profile");
    expect(diagnosis?.hint).toContain("CI.md");
    for (const banned of ["sysctl", "bwrap-userns-restrict"])
      expect(diagnosis?.hint).not.toContain(banned);
    expect(BWRAP_PROC_ERROR).toBe("Can't mount proc");
  });

  it("renders the diagnosis in the trusted block and details with streams untouched", async () => {
    const backend = {
      name: "bubblewrap",
      isAvailable: () => true,
      run: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "bwrap: Failed to make / slave: Permission denied",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        diagnosis: {
          kind: "apparmor-confined" as const,
          profile: "cri-containerd.apparmor.d",
          hint: "containerized runner: configure a pod-level AppArmor profile",
        },
      }),
      unavailableReason: () => undefined,
    };
    const [tool] = createCodeExecTools(resolveCodeExecConfig({ PI_REVIEWER_CODE_EXEC: "true" }), {
      cwd: "/ws",
      backend: backend as any,
    });
    const result = await tool.execute("id", { command: "echo hi" } as any);
    expect(result.content).toHaveLength(3);
    expect(blockText(result.content[0])).toContain("pod-level AppArmor profile");
    expect(blockText(result.content[1])).toBe("[stdout]\n(empty)");
    const details = result.details;
    if (!isRecord(details) || !isRecord(details.diagnosis)) {
      throw new Error("expected a diagnosis in the result details");
    }
    expect(details.diagnosis.kind).toBe("apparmor-confined");
  });
});

describe("output caps", () => {
  it("truncateBytes slices on bytes and flags overflow", () => {
    expect(truncateBytes(Buffer.from("hi"), 4)).toEqual({ text: "hi", truncated: false });
    const result = truncateBytes(Buffer.from("hello"), 4);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(4);
  });

  it("collectCapped keeps the head of one oversized chunk", () => {
    const collector = collectCapped(4);
    collector.push(Buffer.from("hello world"));
    expect(collector.result()).toEqual({ text: "hell", truncated: true });
  });

  it("collectCapped accumulates across chunks up to the cap", () => {
    const collector = collectCapped(5);
    collector.push(Buffer.from("ab"));
    collector.push(Buffer.from("cde"));
    collector.push(Buffer.from("fg"));
    expect(collector.result()).toEqual({ text: "abcde", truncated: true });
  });

  it("collectCapped passes small streams through unflagged", () => {
    const collector = collectCapped(64);
    collector.push(Buffer.from("ok"));
    expect(collector.result()).toEqual({ text: "ok", truncated: false });
  });
});

describe("apple container backend", () => {
  const workspace = process.cwd();

  beforeEach(() => {
    spawnMock.mockReset();
  });

  function availableBackend(image = "img"): AppleContainerBackend {
    const backend = new AppleContainerBackend(image);
    vi.spyOn(backend, "isAvailable").mockReturnValue(true);
    return backend;
  }

  it("attaches no network, names the container, and enforces the deadline inside", async () => {
    vi.stubEnv("GITHUB_TOKEN", "secret");
    spawnMock.mockImplementation(() => autoClosingChild(0));
    try {
      const backend = availableBackend();
      await backend.run({
        workspace,
        workdir: ".",
        command: "pytest -q",
        timeoutMs: 61_000,
        maxStreamBytes: 64,
      } as any);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe("container");
    expect(args).toEqual(expect.arrayContaining(["--network", "none", "--no-dns", "--rm"]));
    const nameIndex = args.indexOf("--name");
    expect(args[nameIndex + 1]).toMatch(/^pi-code-exec-/);
    // Inner coreutils timeout is the real deadline (client kill cannot stop
    // the VM-side workload).
    const timeoutIndex = args.indexOf("timeout");
    expect(args.slice(timeoutIndex, timeoutIndex + 6)).toEqual([
      "timeout",
      "-s",
      "KILL",
      "61",
      "bash",
      "-c",
    ]);
    expect(args[args.length - 1]).toBe("pytest -q");
    // Read-only .git shadow for bubblewrap parity.
    const mountIndex = args.indexOf("--mount");
    expect(args[mountIndex + 1]).toContain("readonly");
    expect(args[mountIndex + 1]).toContain(".git");
    // Scrubbed spawn env: no ambient secrets reach the CLI either.
    expect(opts.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("reaps the container when the deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const hanging = fakeChild();
      spawnMock.mockImplementation(() => hanging as never);
      const backend = availableBackend();
      const pending = backend.run({
        workspace,
        workdir: ".",
        command: "sleep 999",
        timeoutMs: 5000,
        maxStreamBytes: 64,
      } as any);
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      expect(hanging.kill).toHaveBeenCalled();
      expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
      const rmCall = spawnMock.mock.calls.find((call) => (call[1] as string[])[0] === "rm");
      expect(rmCall?.[1]).toEqual(["rm", "--force", expect.stringMatching(/^pi-code-exec-/)]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bwrap proc fallback", () => {
  const workspace = process.cwd();

  beforeEach(() => {
    spawnMock.mockReset();
  });

  function baseRequest() {
    return {
      workspace,
      workdir: ".",
      command: "echo hi",
      timeoutMs: 5000,
      maxStreamBytes: 4096,
      platform: "linux" as const,
      exists: () => true,
    } as any;
  }

  // The mocked spawn delivers no stream data by default, so failures carry
  // their stderr explicitly before the close event.
  function childWithStderr(stderrText: string, code: number | null): FakeChild {
    const child = fakeChild();
    const stderrHandlers: Array<(chunk: Buffer) => void> = [];
    (child.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data") stderrHandlers.push(cb);
      },
    );
    queueMicrotask(() => {
      for (const cb of stderrHandlers) cb(Buffer.from(stderrText));
      child.emit("close", code);
    });
    return child;
  }

  it("retries once with a read-only /proc reuse on the proc-mount failure", async () => {
    spawnMock
      .mockImplementationOnce(
        () =>
          childWithStderr(
            "bwrap: Can't mount proc on /newroot/proc: Operation not permitted",
            1,
          ) as never,
      )
      .mockImplementationOnce(() => autoClosingChild(0) as never);
    const result = await runSandboxed(baseRequest());
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const firstArgs = spawnMock.mock.calls[0][1] as string[];
    const secondArgs = spawnMock.mock.calls[1][1] as string[];
    expect(firstArgs).toContain("--proc");
    expect(secondArgs).not.toContain("--proc");
    const idx = secondArgs.indexOf("/proc");
    expect(secondArgs.slice(idx - 1, idx + 2)).toEqual(["--ro-bind", "/proc", "/proc"]);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("does not retry successful or unrelated failures", async () => {
    spawnMock.mockImplementationOnce(() => autoClosingChild(0) as never);
    const ok = await runSandboxed(baseRequest());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ok.exitCode).toBe(0);

    spawnMock.mockReset();
    spawnMock.mockImplementationOnce(
      () => childWithStderr("bwrap: Can't find source path: /x", 1) as never,
    );
    const failed = await runSandboxed(baseRequest());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(failed).toMatchObject({ exitCode: 1, timedOut: false });
    expect(failed.stderr).toContain("Can't find source path");
  });

  it("does not retry unprefixed command output mentioning the signature", async () => {
    spawnMock.mockImplementationOnce(() => childWithStderr("Can't mount proc", 1) as never);
    const result = await runSandboxed(baseRequest());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
  });

  it("does not retry after a timeout", async () => {
    vi.useFakeTimers();
    try {
      const hanging = fakeChild();
      spawnMock.mockImplementation(() => hanging as never);
      const pending = runSandboxed({ ...baseRequest(), timeoutMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
