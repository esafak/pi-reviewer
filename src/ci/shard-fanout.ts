import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearTimeout as clearNodeTimeout, setTimeout as scheduleNodeTimeout } from "node:timers";

// Single-signature aliases: ambient setTimeout overloads differ across
// @types/node versions (a DOM-compatible number-returning overload broke CI
// with TS2322 after the v24->v26 bump), so the barrier never calls an
// overloaded signature directly. These aliases fail loudly here if the
// underlying signatures ever stop satisfying the contract.
const scheduleRealTimeout: (callback: () => void, ms: number) => NodeJS.Timeout =
  scheduleNodeTimeout;
const cancelRealTimeout: (handle: NodeJS.Timeout) => void = clearNodeTimeout;
import { MAX_SHARDS, type SkippedFile } from "../core/diff-filter.js";
import { isShardEnvelope, type ShardEnvelope, type ShardRequest } from "./shard-protocol.js";

// Bound only child fan-out; reviewId:0 posting is atomic and is never interrupted by this deadline. Keep below consumer job timeouts.
export const SHARD_FANOUT_TIMEOUT_MS = 20 * 60 * 1000;
export const SHARD_KILL_GRACE_MS = 10_000; // Allow extension servers to handle SIGTERM before force-killing their process group.
type Spawn = typeof nodeSpawn;
export interface ShardRunResult {
  envelopes: ShardEnvelope[];
  skipped: SkippedFile[];
  runs: number;
  abandoned: number;
}

/** Run one isolated shard; the child process is the owner of all mutable agent state. */

export function shardEntryPoint(): string {
  // fileURLToPath, not .pathname: URL paths percent-encode spaces/unicode,
  // which spawn would treat as literal %20 (ENOENT on such runners).
  return fileURLToPath(new URL("./shard-run.js", import.meta.url));
}

function waitForChild(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* The process group may have exited at the barrier. */
  }
}

/** Spawn isolated shard children and enforce one run-wide barrier. */
export async function runShardChildren(
  requests: readonly ShardRequest[],
  options: {
    spawn?: Spawn;
    /** Environment for children; defaults to process.env (inherit everything). */
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    clock?: {
      now(): number;
      // Named NodeJS.Timeout explicitly; see scheduleRealTimeout below for
      // why the barrier never calls an ambient setTimeout overload directly.
      setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
      clearTimeout(handle: NodeJS.Timeout): void;
    };
    startedAt?: number;
    entryPoint?: string;
    cap?: number;
  } = {},
): Promise<ShardRunResult> {
  const spawnChild = options.spawn ?? nodeSpawn;
  const clock = options.clock;
  const now = clock ? () => clock.now() : (options.now ?? Date.now);
  const schedule = clock
    ? (callback: () => void, ms: number): NodeJS.Timeout => clock.setTimeout(callback, ms)
    : scheduleRealTimeout;
  const cancel = clock
    ? (handle: NodeJS.Timeout): void => {
        clock.clearTimeout(handle);
      }
    : cancelRealTimeout;
  const startedAt = options.startedAt ?? now();
  const envelopes: ShardEnvelope[] = [];
  const skipped: SkippedFile[] = [];
  let runs = 0;
  const active = new Map<number, ShardRequest>();
  const completed = new Set<number>();
  const skippedIndices = new Set<number>();
  let deadlineReached = false;
  let barrierHit = false;
  const markSkipped = (request: ShardRequest, reason: SkippedFile["reason"]): void => {
    if (skippedIndices.has(request.index)) return;
    skippedIndices.add(request.index);
    skipped.push(
      ...request.shard.files.map((file) => ({
        path: file,
        reason,
        cap: options.cap ?? request.shard.diff.length,
      })),
    );
  };
  for (const request of requests.slice(MAX_SHARDS)) markSkipped(request, "shard_limit");
  let abandoned = 0;
  const jobs = requests.slice(0, MAX_SHARDS).map(async (request) => {
    let directory: string | undefined;
    try {
      if (deadlineReached) {
        markSkipped(request, "shard_limit");
        completed.add(request.index);
        return;
      }
      directory = await mkdtemp(path.join(os.tmpdir(), "pi-reviewer-shard-"));
      const inputPath = path.join(directory, "in.json");
      const outputPath = path.join(directory, "out.json");
      await writeFile(inputPath, JSON.stringify(request), { mode: 0o600 });
      if (deadlineReached) {
        markSkipped(request, "shard_limit");
        completed.add(request.index);
        await rm(directory, { recursive: true, force: true });
        return;
      }
      // argv[1] is the parent script under tsx; the loader is in execArgv. Re-running argv[1] starts review again, while dropping execArgv breaks `.js` imports in both tested cases.
      // Awaited so injected stub spawns may be async; the real spawn returns a
      // ChildProcess synchronously and awaiting a non-promise is a no-op.
      const child = await spawnChild(
        process.execPath,
        [...process.execArgv, options.entryPoint ?? shardEntryPoint(), inputPath, outputPath],
        { cwd: request.cwd, detached: true, stdio: "inherit", env: options.env ?? process.env },
      );
      if (!child.pid) {
        markSkipped(request, "shard_failed");
        await rm(directory, { recursive: true, force: true });
        completed.add(request.index);
        return;
      }
      runs++;
      active.set(child.pid, request);
      const exit = await waitForChild(child);
      active.delete(child.pid);
      completed.add(request.index);
      if (skippedIndices.has(request.index)) {
        await rm(directory, { recursive: true, force: true });
        return;
      }
      try {
        const raw: unknown = JSON.parse(await readFile(outputPath, "utf8"));
        if (
          exit !== 0 ||
          !isShardEnvelope(raw) ||
          raw.index !== request.index ||
          raw.status !== "ok"
        )
          throw new Error("invalid child result");
        envelopes.push(raw);
      } catch {
        markSkipped(request, "shard_failed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } catch {
      markSkipped(request, deadlineReached ? "shard_limit" : "shard_failed");
      completed.add(request.index);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });
  let timeout: NodeJS.Timeout | undefined;
  const barrier = new Promise<void>((resolve) => {
    const remaining = Math.max(0, SHARD_FANOUT_TIMEOUT_MS - (now() - startedAt));
    timeout = schedule(() => {
      barrierHit = true;
      resolve();
    }, remaining);
  });
  await Promise.race([Promise.all(jobs).then(() => undefined), barrier]);
  if (timeout) cancel(timeout);
  if (barrierHit) {
    deadlineReached = true;
    for (const [pid, request] of active) {
      abandoned++;
      killGroup(pid, "SIGTERM");
      markSkipped(request, "shard_limit");
    }
    for (const request of requests.slice(0, MAX_SHARDS)) {
      if (
        !completed.has(request.index) &&
        ![...active.values()].some((current) => current.index === request.index)
      ) {
        abandoned++;
        markSkipped(request, "shard_limit");
      }
    }
    await new Promise<void>((resolve) => {
      schedule(resolve, SHARD_KILL_GRACE_MS);
    });
    for (const pid of active.keys()) killGroup(pid, "SIGKILL");
    await Promise.allSettled(jobs);
  }
  return { envelopes: envelopes.sort((a, b) => a.index - b.index), skipped, runs, abandoned };
}

export async function writeShardEnvelope(pathname: string, envelope: ShardEnvelope): Promise<void> {
  const temporary = `${pathname}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, pathname);
}
