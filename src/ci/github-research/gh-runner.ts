import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateGhArgs } from "./gh-allowlist.js";
import { truncateUtf8WithMarker } from "../registry/helpers.js";
const exec = promisify(execFile);
export async function probeGhCli(): Promise<boolean> {
  try {
    await exec("gh", ["--version"], {
      env: { PATH: process.env.PATH },
      timeout: 1_000,
      maxBuffer: 1024,
    });
    return true;
  } catch {
    return false;
  }
}
export const MAX_GH_RESULT_BYTES = 7 * 1024,
  MAX_GH_TOTAL_BYTES = 15 * 1024,
  MAX_GH_REQUESTS = 8,
  GH_TIMEOUT_MS = 5000,
  GH_WALL_MS = 15000;
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
    try {
      let stdout: string | Buffer;
      try {
        ({ stdout } = await run("gh", args, {
          env: { GH_TOKEN: token, PATH: process.env.PATH },
          timeout: Math.min(GH_TIMEOUT_MS, remaining),
          // Logs use the code-exec per-stream ceiling before applying the smaller research result budget.
          maxBuffer: args.includes("--log") ? 32 * 1024 + 1 : MAX_GH_RESULT_BYTES + 1,
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
      let value = String(stdout);
      if (args.includes("--log") && Buffer.byteLength(value) > MAX_GH_RESULT_BYTES)
        throw new Error("gh output budget exhausted");
      if (args.includes("--log")) value = truncateUtf8WithMarker(value, 4 * 1024);
      const size = Buffer.byteLength(value);
      if (size > MAX_GH_RESULT_BYTES || bytes + size > MAX_GH_TOTAL_BYTES)
        throw new Error("gh output budget exhausted");
      bytes += size;
      return value;
    } catch (e) {
      throw new Error(safeGhFailure(e));
    }
  };
}
