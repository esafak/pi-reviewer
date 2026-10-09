export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MIN_EXEC_TIMEOUT_MS = 1_000;
export const MAX_EXEC_TIMEOUT_MS = 120_000;
// Per-stream cap keeps stdout and stderr independently useful; the model
// receives both blocks plus a small header, so each stream gets its own
// budget instead of sharing one combined buffer.
export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024;
export const MIN_MAX_STREAM_BYTES = 1 * 1024;
export const MAX_MAX_STREAM_BYTES = 128 * 1024;
export const MAX_COMMAND_LENGTH = 8_000;

export const DEFAULT_MAX_CALLS = 5;
export const MIN_MAX_CALLS = 1;
export const MAX_MAX_CALLS = 10;
export const DEFAULT_WALL_BUDGET_MS = 360_000;
export const MIN_WALL_BUDGET_MS = 30_000;
export const MAX_WALL_BUDGET_MS = 1_200_000;

export interface ExecConfig {
  enabled: boolean;
  timeoutMs: number;
  maxStreamBytes: number;
  maxCalls: number;
  wallBudgetMs: number;
  // No network in v1: dependencies come from pre-warmed caches
  // (target/, node_modules, ~/.cargo) bound in read-only. The sandbox
  // always passes --unshare-net, so there is no allowlist to enforce.
}

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function parseMaxCalls(raw: string | undefined): number {
  return parseIntInRange(raw, DEFAULT_MAX_CALLS, MIN_MAX_CALLS, MAX_MAX_CALLS);
}

export function resolveExecConfig(env: NodeJS.ProcessEnv = process.env): ExecConfig {
  const enabled = env.PI_REVIEWER_EXEC === "true";
  return {
    enabled,
    timeoutMs: parseIntInRange(
      env.PI_REVIEWER_EXEC_TIMEOUT_MS,
      DEFAULT_EXEC_TIMEOUT_MS,
      MIN_EXEC_TIMEOUT_MS,
      MAX_EXEC_TIMEOUT_MS,
    ),
    maxStreamBytes: parseIntInRange(
      env.PI_REVIEWER_EXEC_MAX_STREAM_BYTES,
      DEFAULT_MAX_STREAM_BYTES,
      MIN_MAX_STREAM_BYTES,
      MAX_MAX_STREAM_BYTES,
    ),
    maxCalls: parseMaxCalls(env.PI_REVIEWER_EXEC_MAX_CALLS),
    wallBudgetMs: parseIntInRange(
      env.PI_REVIEWER_EXEC_WALL_BUDGET_MS,
      DEFAULT_WALL_BUDGET_MS,
      MIN_WALL_BUDGET_MS,
      MAX_WALL_BUDGET_MS,
    ),
  };
}
