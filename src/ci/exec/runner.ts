import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { isSecretEnvName, pickEnv } from "./env.js";
import type { BwrapDiagnosis } from "./diagnose.js";

// Secrets never enter the sandbox. Everything else is denied by default and
// only locale/toolchain variables pass through; the guest HOME is a scratch
// tmpfs so per-run caches work without persisting or touching the real home.
const PASSTHROUGH_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "TERM",
  "CARGO_HOME",
  "RUSTUP_HOME",
] as const;
export const SANDBOX_HOME = "/sandbox-home";

const SYSTEM_RO_BINDS = [
  "/usr",
  "/opt",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc/resolv.conf",
  "/etc/ssl",
  "/etc/ca-certificates",
  // Present on glibc images: lets git/cargo resolve uids instead of failing
  // with "unable to look up current user", and keeps passwd-adjacent
  // symlinks (Debian alternatives) resolving to the bound toolchains.
  "/etc/passwd",
  "/etc/group",
  "/etc/alternatives",
];

const TOOLCHAIN_HOME_BINDS = [
  ".cargo",
  ".rustup",
  ".npm",
  ".cache/go-build",
  ".cache/pip",
  ".local/share/mise",
];

export interface SandboxRequest {
  workspace: string;
  workdir: string;
  command: string;
  timeoutMs: number;
  maxStreamBytes: number;
  extraEnv?: Record<string, string>;
  bwrapPath?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  // Confined-runtime diagnosis travels beside the streams so trusted guidance
  // never shares a block with untrusted command output and never consumes
  // the per-stream byte budget.
  diagnosis?: BwrapDiagnosis;
}

export function resolveWorkdir(workspace: string, workdir: string): string {
  if (!workdir || workdir === ".") return workspace;
  if (path.isAbsolute(workdir)) throw new Error("workdir must be repo-relative");
  const normalized = path.posix.normalize(workdir.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("\0"))
    throw new Error("workdir escapes workspace");
  const resolved = path.resolve(workspace, normalized);
  const relative = path.relative(workspace, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("workdir escapes workspace");
  return resolved;
}

export function isBubblewrapAvailable(
  opts: { platform?: NodeJS.Platform; bwrapPath?: string; exists?: (p: string) => boolean } = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  const candidate = opts.bwrapPath ?? "bwrap";
  const exists = opts.exists ?? existsSync;
  if (path.isAbsolute(candidate)) return exists(candidate);
  const dirs = (process.env.PATH ?? "/usr/bin:/bin").split(":");
  return dirs.some((dir) => exists(path.join(dir, candidate)));
}

function sandboxEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  const env = pickEnv(PASSTHROUGH_ENV);
  env.HOME = SANDBOX_HOME;
  for (const [key, value] of Object.entries(extraEnv)) {
    if (isSecretEnvName(key)) continue;
    env[key] = value;
  }
  return env;
}

export function buildBwrapArgs(request: SandboxRequest): string[] {
  const resolved = resolveWorkdir(request.workspace, request.workdir);
  const home = process.env.HOME ?? "/root";
  const exists = request.exists ?? existsSync;
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    // No network, no proxy, no allowlist: dependencies must be pre-warmed
    // outside (cargo fetch, npm ci) and consumed with --offline flags.
    "--unshare-net",
    "--hostname",
    "sandbox",
  ];
  for (const dir of SYSTEM_RO_BINDS) {
    if (exists(dir)) args.push("--ro-bind", dir, dir);
  }
  // Parent mounts first: bwrap applies ops in argv order, so the scratch-HOME
  // tmpfs must precede the cache binds below it, or it would cover and hide
  // them (same rule that puts the workspace bind before the .git shadow).
  args.push("--tmpfs", "/tmp", "--tmpfs", SANDBOX_HOME);
  for (const rel of TOOLCHAIN_HOME_BINDS) {
    const host = path.join(home, rel);
    if (!exists(host)) continue;
    // Absolute binds keep host toolchains visible however the guest resolves
    // them; the second bind re-roots them under the scratch HOME so
    // $HOME-relative lookups (cargo, pip, mise) keep working.
    args.push("--ro-bind", host, host, "--ro-bind", host, path.join(SANDBOX_HOME, rel));
  }
  // Workspace is writable so incremental builds survive across calls; .git
  // is re-mounted read-only so the reviewed baseline cannot be rewritten.
  args.push("--bind", request.workspace, request.workspace);
  const dotGit = path.join(request.workspace, ".git");
  if (exists(dotGit)) args.push("--ro-bind", dotGit, dotGit);
  args.push("--proc", "/proc", "--dev", "/dev");
  args.push("--setenv", "HOME", SANDBOX_HOME);
  args.push("--chdir", resolved, "--", "bash", "-c", request.command);
  return args;
}

// Byte-accurate truncation shared by the spawn paths: slice on bytes, flag
// whenever the stream exceeded the cap, and never throw on torn multibyte
// tails (acceptable for model-facing output).
export function truncateBytes(bytes: Buffer, cap: number): { text: string; truncated: boolean } {
  if (bytes.length <= cap) return { text: bytes.toString("utf8"), truncated: false };
  return { text: bytes.subarray(0, cap).toString("utf8"), truncated: true };
}

// Retains at most cap bytes across arbitrarily large chunks: a single
// oversized chunk contributes its head instead of being dropped whole.
export function collectCapped(cap: number): {
  push(chunk: Buffer): void;
  result(): { text: string; truncated: boolean };
} {
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  return {
    push(chunk: Buffer) {
      totalBytes += chunk.length;
      const room = cap - retainedBytes;
      if (room > 0) {
        const head = room >= chunk.length ? chunk : chunk.subarray(0, room);
        retained.push(head);
        retainedBytes += head.length;
      }
    },
    result() {
      const truncated = truncateBytes(Buffer.concat(retained), cap);
      return { text: truncated.text, truncated: truncated.truncated || totalBytes > cap };
    },
  };
}

export function runSandboxed(request: SandboxRequest): Promise<SandboxResult> {
  if ((request.platform ?? process.platform) !== "linux")
    return Promise.reject(new Error("code execution unavailable: bubblewrap requires Linux"));
  const bwrap = request.bwrapPath ?? "bwrap";
  if (
    !isBubblewrapAvailable({ platform: request.platform, bwrapPath: bwrap, exists: request.exists })
  )
    return Promise.reject(new Error("code execution unavailable: bubblewrap not found"));
  if (!request.command.trim()) return Promise.reject(new Error("command must be non-empty"));

  let resolved: string;
  try {
    resolved = resolveWorkdir(request.workspace, request.workdir);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!(request.exists ?? existsSync)(resolved))
    return Promise.reject(new Error(`workdir "${request.workdir}" does not exist`));

  const args = buildBwrapArgs(request);
  return new Promise<SandboxResult>((resolve, reject) => {
    const child = spawn(bwrap, args, {
      env: sandboxEnv(request.extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cap = request.maxStreamBytes;
    const stdout = collectCapped(cap);
    const stderr = collectCapped(cap);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        exitCode: 124,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut: true,
      });
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = stdout.result();
      const err = stderr.result();
      resolve({
        exitCode: code ?? 1,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut: false,
      });
    });
  });
}
