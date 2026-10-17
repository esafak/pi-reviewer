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
  GH_WALL_MS = 15000;
// File downloads are cached for repeated greps; the raw payload never reaches
// the model, so it observes a higher ceiling while request and wall-clock
// budgets still apply. Grep output stays within the per-result budget.
export const MAX_GH_FILE_BYTES = 1024 * 1024;
export function safeGhFailure(error: unknown): string {
  const msg = error instanceof Error ? error.message : "gh command failed";
  return Array.from(msg, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .replace(/(?:token|authorization|bearer)\s*[:=]?\s*\S+/gi, "[redacted]")
    .slice(0, 240);
}
export function createGhRunner(token: string, run = exec) {
  const started = Date.now();
  let calls = 0,
    bytes = 0;
  return async (args: string[]) => {
    const invalid = validateGhArgs(args);
    if (invalid) throw new Error(invalid);
    if (calls++ >= MAX_GH_REQUESTS) throw new Error("gh request budget exhausted");
    const remaining = GH_WALL_MS - (Date.now() - started);
    if (remaining <= 0) throw new Error("gh wall-time budget exhausted");
    // Contents downloads feed the grep cache; the model sees only a truncated
    // preview enforced by the client, so raw bytes are exempt from the
    // model-facing aggregate while still bounded per fetch.
    const isContentsFetch =
      args[0] === "api" && typeof args[1] === "string" && args[1].includes("/contents/");
    try {
      let stdout: string | Buffer;
      try {
        ({ stdout } = await run("gh", args, {
          env: { GH_TOKEN: token, PATH: process.env.PATH },
          timeout: Math.min(GH_TIMEOUT_MS, remaining),
          // Logs use the code-exec per-stream ceiling before applying the smaller research result budget.
          maxBuffer: args.includes("--log")
            ? 32 * 1024 + 1
            : isContentsFetch
              ? MAX_GH_FILE_BYTES + 1
              : MAX_GH_RESULT_BYTES + 1,
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
      let truncated = value;
      if (args.includes("--log") && Buffer.byteLength(truncated) > MAX_GH_RESULT_BYTES)
        throw new Error("gh output budget exhausted");
      if (args.includes("--log")) truncated = truncateUtf8WithMarker(truncated, 4 * 1024);
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
    }
  };
}
