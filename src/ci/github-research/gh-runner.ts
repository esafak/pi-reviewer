import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";
import { validateGhArgs } from "./gh-allowlist.js";
import { truncateUtf8WithMarker } from "../registry/helpers.js";
const exec = promisify(execFile);
export async function probeGhCli(): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await exec("gh", ["--version"], {
        env: { PATH: process.env.PATH },
        timeout: 5_000,
        maxBuffer: 1024,
      });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  // The warn path tells the operator to install gh, which is wrong advice
  // when the binary exists but a cold runner stalls the spawn past the
  // timeout (observed: setup step finds gh, probe does not). Keep the reason
  // at debug so the next occurrence is diagnosable instead of a mystery.
  const reason = lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError);
  log.debug("review.github_research.probe_failed", "gh CLI probe failed", {
    error: (reason ?? "unknown").slice(0, 160),
  });
  return false;
}
export const MAX_GH_RESULT_BYTES = 7 * 1024,
  MAX_GH_TOTAL_BYTES = 15 * 1024,
  MAX_GH_REQUESTS = 8,
  GH_TIMEOUT_MS = 5000,
  GH_WAIT_MS = 15000;
// File downloads are cached for repeated greps; the raw payload never reaches
// the model, so it observes a higher ceiling while the request and wait-time
// budgets still apply. Grep output stays within the per-result budget.
export const MAX_GH_FILE_BYTES = 1024 * 1024;
export function safeGhFailure(error: unknown): string {
  const msg = error instanceof Error ? error.message : "gh command failed";
  return Array.from(msg, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/(?:token|authorization|bearer)\s*[:=]?\s*\S+/gi, "[redacted]")
    .slice(0, 240);
}
export interface GhRunnerOptions {
  /** Dispatched subprocess attempts allowed per runner. */
  maxRequests?: number;
  /** Cumulative subprocess wait time allowed, in milliseconds. */
  waitMs?: number;
  /** Per-subprocess timeout, in milliseconds. */
  timeoutMs?: number;
  /** Monotonic clock, injectable so tests can drive the budget. */
  now?: () => number;
  /** Working directory for every subprocess, pinned so a checkout cannot move. */
  cwd?: string;
}
function assertLimit(name: string, value: number): void {
  // A non-finite or non-positive limit would make the budget checks
  // meaningless, and a NaN timeout would slip past the below-1 check.
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid gh limit: ${name}`);
}
export function createGhRunner(token: string, run = exec, options: GhRunnerOptions = {}) {
  const maxRequests = options.maxRequests ?? MAX_GH_REQUESTS;
  const waitMs = options.waitMs ?? GH_WAIT_MS;
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
  const now = options.now ?? (() => performance.now());
  const cwd = options.cwd;
  assertLimit("maxRequests", maxRequests);
  assertLimit("waitMs", waitMs);
  assertLimit("timeoutMs", timeoutMs);
  // The request count, the elapsed-time accounting, and the aggregate byte
  // budget are shared state, so subprocesses are dispatched one at a time:
  // concurrent callers cannot oversubscribe any of them.
  let attempts = 0;
  let waited = 0;
  let bytes = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const dispatch = async (args: string[]): Promise<string> => {
    const invalid = validateGhArgs(args);
    if (invalid) throw new Error(invalid);
    // Both budget checks run inside the serialized section, before the
    // subprocess is dispatched, so a rejected call spends neither an attempt
    // nor any of the time allowance.
    if (attempts >= maxRequests) throw new Error("gh request budget exhausted");
    const allowance = Math.floor(Math.min(timeoutMs, waitMs - waited));
    // The clock is fractional and the subprocess timeout must be an integer;
    // a timeout of 0 would disable the timeout rather than expire it.
    if (allowance < 1) throw new Error("GitHub research time budget exhausted for this review");
    attempts += 1;
    // Contents downloads feed the grep cache; the model sees only a truncated
    // preview enforced by the client, so raw bytes are exempt from the
    // model-facing aggregate while still bounded per fetch.
    const isContentsFetch =
      args[0] === "api" && typeof args[1] === "string" && args[1].includes("/contents/");
    // A diff and a run log are plain text of unbounded length. They are read
    // with the download ceiling and truncated to the model-facing budget, so
    // the research budget applies to what the model sees rather than to the
    // raw stream.
    const isPlainText = args.includes("--log") || (args[0] === "pr" && args[1] === "diff");
    const started = now();
    try {
      let stdout: string | Buffer;
      try {
        ({ stdout } = await run("gh", args, {
          env: { GH_TOKEN: token, PATH: process.env.PATH },
          timeout: allowance,
          // Every subprocess resolves its repository from the same pinned
          // directory, so a checkout cannot move under a running review.
          ...(cwd ? { cwd } : {}),
          // Logs and diffs use the download ceiling; every other command uses
          // the smaller research result budget.
          maxBuffer:
            isPlainText || isContentsFetch ? MAX_GH_FILE_BYTES + 1 : MAX_GH_RESULT_BYTES + 1,
          encoding: "utf8",
        }));
      } catch (error) {
        // A failed run can exit nonzero after emitting usable stdout; accept only code 1 with non-empty output.
        if (
          args.includes("--exit-status") &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 1 &&
          "stdout" in error &&
          typeof error.stdout === "string" &&
          error.stdout.length > 0
        )
          stdout = error.stdout;
        else throw error;
      }
      const value = String(stdout);
      if (isContentsFetch) {
        if (Buffer.byteLength(value) > MAX_GH_FILE_BYTES)
          throw new Error("gh output budget exhausted");
        return value;
      }
      const truncated = isPlainText ? truncateUtf8WithMarker(value, 4 * 1024) : value;
      const size = Buffer.byteLength(truncated);
      if (size > MAX_GH_RESULT_BYTES || bytes + size > MAX_GH_TOTAL_BYTES)
        throw new Error("gh output budget exhausted");
      bytes += size;
      return truncated;
    } catch (e) {
      // Node's maxBuffer wording leaks transport internals; the budget
      // message tells the model to continue without the result.
      if (e instanceof Error && /maxbuffer/i.test(e.message))
        throw new Error("gh output budget exhausted");
      throw new Error(safeGhFailure(e));
    } finally {
      // A subprocess that throws, times out, or is killed still consumed the
      // allowance it burned. The measurement covers the postprocessing after
      // the subprocess returns, which is a rounding error next to a network
      // round trip.
      waited += now() - started;
    }
  };
  return (args: string[]): Promise<string> => {
    // The queue survives a rejected subprocess: the next call still runs.
    const result = tail.then(
      () => dispatch(args),
      () => dispatch(args),
    );
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
