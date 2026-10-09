import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import { pickEnv } from "./env.js";

import {
  collectCapped,
  isBubblewrapAvailable,
  resolveWorkdir,
  runSandboxed,
  type SandboxRequest,
  type SandboxResult,
} from "./runner.js";

// Every backend upholds the same contract or refuses: no network, writes
// confined to the workspace, scrubbed env, per-stream output caps, and
// workdir containment. A backend that cannot uphold it fail-closes instead
// of downgrading to unsandboxed execution.
export interface SandboxBackend {
  readonly name: string;
  isAvailable(): boolean;
  run(request: SandboxRequest): Promise<SandboxResult>;
  // Precise refusal reason for operators ("bubblewrap not found",
  // "expected Apple Container `container` CLI"); undefined when runnable.
  unavailableReason(): string | undefined;
}

export type { SandboxRequest, SandboxResult };

export class BubblewrapBackend implements SandboxBackend {
  readonly name = "bubblewrap";
  isAvailable(): boolean {
    return isBubblewrapAvailable();
  }
  run(request: SandboxRequest): Promise<SandboxResult> {
    return runSandboxed(request);
  }
  unavailableReason(): string | undefined {
    return this.isAvailable() ? undefined : "bubblewrap not found (requires Linux)";
  }
}

// Lazy availability check mirroring isBubblewrapAvailable: platform, arch,
// then a PATH lookup for the `container` CLI. No caching, no side effects,
// so callers can ask each time they need it.
export function isAppleContainerAvailable(
  opts: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    containerPath?: string;
    exists?: (p: string) => boolean;
  } = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "darwin") return false;
  if ((opts.arch ?? process.arch) !== "arm64") return false;
  const candidate = opts.containerPath ?? process.env.PI_REVIEWER_EXEC_CONTAINER_BIN ?? "container";
  const exists = opts.exists ?? existsSync;
  if (path.isAbsolute(candidate)) return exists(candidate);
  const dirs = (process.env.PATH ?? "/usr/bin:/bin").split(":");
  return dirs.some((dir) => exists(path.join(dir, candidate)));
}

export class AppleContainerBackend implements SandboxBackend {
  readonly name = "apple-container";
  constructor(private readonly image = process.env.PI_REVIEWER_EXEC_IMAGE) {}
  isAvailable(): boolean {
    return isAppleContainerAvailable();
  }
  unavailableReason(): string | undefined {
    if (this.isAvailable()) return undefined;
    return "Apple Container `container` CLI not found (requires macOS arm64)";
  }
  run(request: SandboxRequest): Promise<SandboxResult> {
    if (!this.isAvailable())
      return Promise.reject(new Error(`code execution unavailable: ${this.unavailableReason()}`));
    if (!this.image)
      return Promise.reject(
        new Error(
          "code execution unavailable: set PI_REVIEWER_EXEC_IMAGE to a pre-pulled Linux image with bash, coreutils, and your toolchains",
        ),
      );
    // A named container lets the timeout path reap the workload: killing the
    // CLI client alone leaves the VM-side container running with workspace
    // write access, so expiry also issues `container rm --force`.
    const name = `pi-exec-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    let resolved: string;
    try {
      resolved = resolveWorkdir(request.workspace, request.workdir);
    } catch (error) {
      return Promise.reject(error);
    }
    const exists = request.exists ?? existsSync;
    if (!exists(resolved))
      return Promise.reject(new Error(`workdir "${request.workdir}" does not exist`));
    if (!request.command.trim()) return Promise.reject(new Error("command must be non-empty"));

    const containerBin = process.env.PI_REVIEWER_EXEC_CONTAINER_BIN ?? "container";
    // `--network none` attaches no network (omitting the flag would join the
    // default vmnet network with outbound NAT). The workspace mounts writable;
    // .git is shadow-mounted read-only afterwards for bubblewrap parity.
    // The in-container `timeout` is the real deadline (client kill cannot stop
    // the VM-side workload); the host timer below only reaps the client.
    const secs = Math.max(1, Math.ceil(request.timeoutMs / 1000));
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--network",
      "none",
      "--no-dns",
      "-v",
      `${request.workspace}:${request.workspace}`,
      ...(exists(path.join(request.workspace, ".git"))
        ? [
            "--mount",
            `type=bind,source=${path.join(request.workspace, ".git")},target=${path.join(request.workspace, ".git")},readonly`,
          ]
        : []),
      "-w",
      resolved,
      this.image,
      "timeout",
      "-s",
      "KILL",
      String(secs),
      "bash",
      "-c",
      request.command,
    ];
    const cap = request.maxStreamBytes;
    // Scrubbed like the bubblewrap env: the CLI inherits nothing ambient, so
    // host secrets cannot leak through it either.
    const env = pickEnv(["PATH", "HOME", "TMPDIR", "LANG"]);
    return new Promise<SandboxResult>((resolve, reject) => {
      const child = spawn(containerBin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = collectCapped(cap);
      const stderr = collectCapped(cap);
      let settled = false;
      const finish = (timedOut: boolean, code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = stdout.result();
        const err = stderr.result();
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          timedOut,
        });
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        // Best-effort reap; a failing rm must not mask the timeout result,
        // and the handle must not hold the review process open afterwards.
        try {
          spawn(containerBin, ["rm", "--force", name], { stdio: "ignore" })
            .on("error", () => {})
            .unref();
        } catch {
          /* ignore */
        }
        finish(true, null);
      }, request.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      // Coreutils timeout exits 124, so a container that hit its own
      // deadline reports timedOut even if the host timer lost the race.
      // (A command that naturally exits 124 reads the same way; rare and
      // harmless, since either signal steers the agent narrower.)
      child.on("close", (code) => finish(code === 124, code));
    });
  }
}

// Fail-closed default when no backend is present. Never executes; the tool
// surfaces the refusal so the agent moves on instead of retrying
// unsandboxed.
export class FailClosedBackend implements SandboxBackend {
  readonly name = "none";
  constructor(private readonly reason = "no sandbox backend available on this platform") {}
  isAvailable(): boolean {
    return false;
  }
  run(_request: SandboxRequest): Promise<SandboxResult> {
    return Promise.reject(new Error(`code execution unavailable: ${this.reason}`));
  }
  unavailableReason(): string {
    return this.reason;
  }
}

type MxcModule = {
  getPlatformSupport?: () => {
    isSupported?: boolean;
    availableMethods?: string[];
  };
  run?: (request: Record<string, unknown>) => Promise<{
    stdout?: unknown;
    stderr?: unknown;
    exitCode?: unknown;
    timedOut?: unknown;
  }>;
};

function defaultMxcLoad(): unknown {
  return createRequire(import.meta.url)("@microsoft/mxc-sdk/v1");
}

// Lazy availability check in the same style as the others: platform first
// (so non-Windows hosts never load the SDK), then SDK presence, then the
// native support query. Only `processcontainer` has a V1 create-and-run API,
// so it is required rather than any reported backend.
export function isMxcAvailable(
  opts: { platform?: NodeJS.Platform; load?: () => unknown } = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "win32") return false;
  try {
    const mod = (opts.load ?? defaultMxcLoad)() as MxcModule;
    const support = mod.getPlatformSupport?.();
    if (!support?.isSupported) return false;
    return (support.availableMethods ?? []).includes("processcontainer");
  } catch {
    return false;
  }
}

// Minimal Windows environment: cmd.exe needs SystemRoot, toolchains need
// PATH, temp files need TEMP/TMP. Scrubbed through the shared helper like
// every other backend.
function mxcEnv(): Record<string, string> {
  return pickEnv(["PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "LANG"]);
}

function mxcString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Byte-cap a JS string like the Buffer paths do: encode UTF-8, slice on
// bytes so maxStreamBytes means the same on every backend, and never split
// a surrogate pair (lone surrogates encode to U+FFFD under fatal:false).
function truncateUtf8(value: string, cap: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= cap) return { text: value, truncated: false };
  return { text: bytes.subarray(0, cap).toString("utf8"), truncated: true };
}

export class MxcBackend implements SandboxBackend {
  readonly name = "mxc";
  constructor(private readonly load: () => unknown = defaultMxcLoad) {}
  isAvailable(): boolean {
    return isMxcAvailable({ load: this.load });
  }
  async run(request: SandboxRequest): Promise<SandboxResult> {
    let mod: MxcModule;
    try {
      mod = this.load() as MxcModule;
    } catch {
      throw new Error(
        "code execution unavailable: @microsoft/mxc-sdk is not installed on this Windows host",
      );
    }
    if (typeof mod.run !== "function")
      throw new Error("code execution unavailable: MXC SDK does not expose run()");
    const resolved = resolveWorkdir(request.workspace, request.workdir);
    if (!existsSync(resolved)) throw new Error(`workdir "${request.workdir}" does not exist`);
    if (!request.command.trim()) throw new Error("command must be non-empty");

    // Deny egress by default, workspace writable with read-only .git, UI
    // disabled, default environment inheritance off with an explicit
    // scrubbed environment. The host temp dir joins the workspace as
    // writable so scratch-file-using frameworks behave like under bwrap's
    // tmpfs /tmp. Mirrors the bubblewrap contract.
    const readwritePaths = [request.workspace];
    const tempDir = process.env.TEMP ?? process.env.TMP;
    if (tempDir) readwritePaths.push(tempDir);
    const result = await mod.run({
      command: request.command,
      workingDirectory: resolved,
      filesystem: {
        readwritePaths,
        readonlyPaths: [path.join(request.workspace, ".git")],
      },
      network: { egress: { default: "deny" } },
      ui: { disable: true },
      timeoutMs: request.timeoutMs,
      environment: mxcEnv(),
      inheritDefaultEnvironment: false,
      containment: { type: "processcontainer" },
    });
    const cap = request.maxStreamBytes;
    const stdout = truncateUtf8(mxcString(result.stdout), cap);
    const stderr = truncateUtf8(mxcString(result.stderr), cap);
    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut: result.timedOut === true,
    };
  }
  unavailableReason(): string | undefined {
    return this.isAvailable()
      ? undefined
      : "MXC unavailable (expected @microsoft/mxc-sdk with processcontainer support on Windows)";
  }
}

export function resolveBackend(
  overrides: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    exists?: (p: string) => boolean;
    mxcLoad?: () => unknown;
  } = {},
): SandboxBackend {
  if (isBubblewrapAvailable(overrides)) return new BubblewrapBackend();
  if (isAppleContainerAvailable(overrides)) return new AppleContainerBackend();
  if (isMxcAvailable({ platform: overrides.platform, load: overrides.mxcLoad }))
    return new MxcBackend(overrides.mxcLoad);
  const platform = overrides.platform ?? process.platform;
  const reason =
    platform === "win32"
      ? "MXC SDK unavailable (expected @microsoft/mxc-sdk with processcontainer support)"
      : platform === "darwin"
        ? "no sandbox runtime found (expected Apple Container `container` CLI)"
        : "bubblewrap not found";
  return new FailClosedBackend(reason);
}
