import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import { readConfig } from "./config.js";

export const NOISE_PATTERNS: RegExp[] = [
  /^pi-review\.md$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb$/,
  /^\.yarn\//,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^out\//,
  /^coverage\//,
  /^node_modules\//,
  /\.min\.(js|css)$/,
  /\.generated\.(ts|js)$/,
];

export const DEFAULT_MAX_CHARS = 100_000;

/**
 * Upper bound for the model-derived diff cap. Explicit user values bypass
 * this clamp; it exists only to bound surprise cost on huge-context models.
 * The 100k floor below is backward compatibility with the previous fixed
 * cap, not a context-safety guarantee: small models can still overflow when
 * the surrounding prompt is large, so lower it explicitly for them.
 */
export const MAX_DERIVED_DIFF_CHARS = 500_000;

/** Rough chars-per-token estimate for diff text. */
const CHARS_PER_TOKEN = 4;
/** Headroom for tool schemas, tool results, and agent scratch space. */
const TOOL_HEADROOM_CHARS = 40_000;
/** Output reserve when the catalog entry reports no maxTokens. */
const DEFAULT_OUTPUT_RESERVE_CHARS = 32_000;

export const MAX_DIFF_CHARS_ENV_VAR = "PI_REVIEWER_MAX_DIFF_CHARS";

export interface FilterResult {
  diff: string;
  warning?: string;
  skippedFiles?: string[];
}

function isNoise(filePath: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(filePath));
}

function parseFilePath(header: string): string | null {
  const match = header.match(/^diff --git a\/.+ b\/(.+)$/);
  return match?.[1] ?? null;
}

export interface StrippedDiff {
  kept: string[];
  excluded: string[];
}

/**
 * Splits a raw diff into noise and candidate sections. Candidates are the
 * stable set context selection may describe: every file the final size
 * filter could keep, so context always covers the reviewed files. Size
 * filtering is deliberately skip-and-continue rather than a strict prefix,
 * so the final selection is not monotonic in the cap — never derive context
 * from an intermediate capped pass.
 */
export function stripNoiseFiles(raw: string): StrippedDiff {
  const sections = raw.split(/(?=^diff --git )/m).filter((s) => s.trim());

  const kept: string[] = [];
  const excluded: string[] = [];

  for (const section of sections) {
    const firstLine = section.split("\n")[0];
    const filePath = parseFilePath(firstLine);
    if (filePath && isNoise(filePath)) {
      excluded.push(filePath);
    } else {
      kept.push(section);
    }
  }

  return { kept, excluded };
}

export function filterDiff(raw: string, maxChars = DEFAULT_MAX_CHARS): FilterResult {
  const { kept, excluded } = stripNoiseFiles(raw);

  const warnings: string[] = [];

  const noise = noiseClause(excluded);
  if (noise !== undefined) {
    warnings.push(noise);
  }

  const included: string[] = [];
  const skippedFiles: string[] = [];
  let totalChars = 0;

  for (const section of kept) {
    if (totalChars + section.length > maxChars) {
      const firstLine = section.split("\n")[0];
      const filePath = parseFilePath(firstLine);
      skippedFiles.push(filePath ?? firstLine);
    } else {
      included.push(section);
      totalChars += section.length;
    }
  }

  if (skippedFiles.length > 0) {
    warnings.push(
      `${skippedFiles.length} file${skippedFiles.length > 1 ? "s" : ""} skipped — diff exceeded ${maxChars.toLocaleString()} chars (${skippedFiles.join(", ")})`,
    );
  }

  return {
    diff: included.join(""),
    warning: warnings.length > 0 ? `⚠ ${warnings.join(" — ")}` : undefined,
    skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
  };
}

/**
 * Sharded-review planning (Phase 1: pure functions, no agent calls).
 *
 * `filterDiff` above stays untouched for the two legacy call sites
 * (terminal/file and `summaryOnly`). The posted (comment-target) path uses
 * `planReview` below instead: fit -> single pass, overflow -> shard 1 holds
 * the exact legacy-kept set with the remainder packed into shards 2..5 in
 * diff order, unreviewable -> coded hard error.
 */

/**
 * Fixed shard ceiling for V1: at most 5 concurrent shard agents bound wall
 * time to ~1 shard latency and tokens to ~5x single-pass. No action input,
 * no env var; revisit on evidence. Also caps parallel fan-out width.
 */
export const MAX_SHARDS = 5;

/** Why a file was skipped on the sharded path (posted notice union keys). */
export type SkippedReason = "shard_failed" | "shard_limit" | "oversize";

/** One skipped file with its own cap (attempted shard's cap; for `oversize` the file's own section size). */
export interface SkippedFile {
  path: string;
  reason: SkippedReason;
  cap: number;
}

/** One shard: raw `diff --git` sections (headers included for `parseDiffPositions`) in diff order. */
export interface DiffShard {
  diff: string;
  files: string[];
}

/**
 * Decision point for posted (comment-target) reviews. `warning`/`skipped`
 * exist on all variants so the noise-exclusion warning survives either path;
 * `single.skipped` is always empty. `unreviewable` means zero reviewable
 * sections and maps to a coded hard error, never message-text matching.
 */
export type ReviewShardPlan =
  | { kind: "single"; diff: string; warning?: string; skipped: SkippedFile[] }
  | { kind: "sharded"; shards: DiffShard[]; warning?: string; skipped: SkippedFile[] }
  | { kind: "unreviewable"; warning?: string; skipped: SkippedFile[] };

function noiseClause(excluded: string[]): string | undefined {
  if (excluded.length === 0) return undefined;
  return `${excluded.length} noise file${excluded.length > 1 ? "s" : ""} excluded (${excluded.join(", ")})`;
}

function noiseWarning(excluded: string[]): string | undefined {
  const clause = noiseClause(excluded);
  return clause === undefined ? undefined : `⚠ ${clause}`;
}

function sectionPath(section: string): string {
  const firstLine = section.split("\n")[0];
  return parseFilePath(firstLine) ?? firstLine;
}

/**
 * Greedy pack of reviewable sections in diff order; never splits a file.
 * Shard 1 is the legacy-kept set (the exact `filterDiff` skip-and-continue
 * selection under `fitCap`, in diff order): because it totals at most
 * `fitCap <= shardCap` (by the `shardCap >= fitCap` invariant), it always
 * fits in one shard, so the sharded path reviews a superset of the legacy
 * path by construction. Remaining sections pack in diff order into shards
 * 2..MAX_SHARDS. Sections larger than the shard cap are skipped `oversize`
 * (cap = own section size; these exceed `fitCap` too, so the legacy path
 * also skips them). Once `MAX_SHARDS` shards are full, the diff-order tail
 * is skipped `shard_limit` (cap = attempted shard cap).
 */
export function planReview(
  kept: string[],
  excluded: string[],
  fitCap: number,
  shardCap: number,
): ReviewShardPlan {
  const warning = noiseWarning(excluded);
  if (kept.length === 0) {
    return { kind: "single", diff: "", warning, skipped: [] };
  }
  const full = kept.join("");
  if (full.length <= fitCap) {
    return { kind: "single", diff: full, warning, skipped: [] };
  }
  // Legacy-kept set first: the filterDiff skip-and-continue selection under
  // fitCap. Fits in one shardCap shard by the invariant, so shard 1 always
  // covers everything the old posted path reviewed.
  const legacySections: string[] = [];
  const legacyIndices = new Set<number>();
  let legacyChars = 0;
  kept.forEach((section, index) => {
    if (legacyChars + section.length <= fitCap) {
      legacySections.push(section);
      legacyIndices.add(index);
      legacyChars += section.length;
    }
  });
  const skipped: SkippedFile[] = [];
  const shards: DiffShard[] = [];
  if (legacySections.length > 0) {
    shards.push({
      diff: legacySections.join(""),
      files: legacySections.map(sectionPath),
    });
  }
  let current: string[] = [];
  let currentFiles: string[] = [];
  let currentChars = 0;
  const flush = (): void => {
    if (current.length > 0) {
      shards.push({ diff: current.join(""), files: [...currentFiles] });
      current = [];
      currentFiles = [];
      currentChars = 0;
    }
  };
  for (let index = 0; index < kept.length; index += 1) {
    const section = kept[index] as string;
    if (legacyIndices.has(index)) continue;
    const path = sectionPath(section);
    if (section.length > shardCap) {
      skipped.push({ path, reason: "oversize", cap: section.length });
      continue;
    }
    if (shards.length >= MAX_SHARDS) {
      skipped.push({ path, reason: "shard_limit", cap: shardCap });
      continue;
    }
    if (currentChars + section.length > shardCap && current.length > 0) {
      flush();
      if (shards.length >= MAX_SHARDS) {
        skipped.push({ path, reason: "shard_limit", cap: shardCap });
        continue;
      }
    }
    current.push(section);
    currentFiles.push(path);
    currentChars += section.length;
  }
  flush();
  if (shards.length === 0) {
    return { kind: "unreviewable", warning, skipped };
  }
  // Keep skipped in diff order: oversize entries were collected inline above,
  // so re-sort by first appearance in `kept` for determinism.
  const order = new Map<string, number>();
  kept.forEach((section, index) => {
    const path = sectionPath(section);
    if (!order.has(path)) order.set(path, index);
  });
  skipped.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  return { kind: "sharded", shards, warning, skipped };
}

/** Per-section size signals for `review.diff.budget` totals/top-5 logging. */
export interface SectionSize {
  path: string;
  /** Raw section char length (packing budget uses this). */
  chars: number;
  /** Hunk `+` lines, excluding `+++` headers and `@@` markers. */
  added: number;
  /** Hunk `-` lines, excluding `---` headers and `@@` markers. */
  removed: number;
}

function hasHunks(section: string): boolean {
  return section.split("\n").some((line) => line.startsWith("@@"));
}

/**
 * Size signals derived from raw section text only. Sections with no hunks
 * (binary/rename) contribute zero added/removed lines so top-5 logging never
 * mis-ranks them; one test case pins each rule.
 */
export function describeSectionSize(section: string): SectionSize {
  const path = sectionPath(section);
  const chars = section.length;
  if (!hasHunks(section)) return { path, chars, added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { path, chars, added, removed };
}
/**
 * Parses a user-supplied diff cap. Accepts positive integers as numbers or
 * decimal strings; everything else (missing, malformed, fractional,
 * non-positive, infinite) yields undefined so the caller falls through.
 */
export function parseMaxDiffChars(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export interface ModelLimits {
  contextWindow: number;
  maxTokens: number;
}

/**
 * Best-effort catalog lookup for a "provider/modelId" string (split on the
 * first slash so OpenRouter ids containing slashes survive). Unknown,
 * unparseable, or custom models yield undefined and the caller keeps the
 * default cap — lookup must never throw on the review path.
 */
export function lookupModelLimits(model: string | undefined): ModelLimits | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  try {
    const entry = getBuiltinModel(
      model.slice(0, slash) as never,
      model.slice(slash + 1) as never,
    ) as { contextWindow?: unknown; maxTokens?: unknown } | undefined;
    if (!entry) return undefined;
    const { contextWindow, maxTokens } = entry;
    if (typeof contextWindow !== "number" || !(contextWindow > 0)) return undefined;
    return {
      contextWindow,
      maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Single precedence rule for the explicit cap, shared by every caller:
 * flag/option > PI_REVIEWER_MAX_DIFF_CHARS env > config-file maxDiffChars.
 * Importing config here keeps the rule in one place; config.ts only re-exports
 * types from prompt-builder, so there is no import cycle.
 */
export function resolveExplicitMaxDiffChars(flagValue?: number): number | undefined {
  const fromFlag = parseMaxDiffChars(flagValue);
  if (fromFlag !== undefined) return fromFlag;
  const fromEnv = parseMaxDiffChars(process.env[MAX_DIFF_CHARS_ENV_VAR]);
  if (fromEnv !== undefined) return fromEnv;
  try {
    return parseMaxDiffChars(readConfig().maxDiffChars);
  } catch {
    return undefined;
  }
}

export interface MaxDiffCharsOptions {
  /** Explicit user value; returned unclamped when positive. */
  explicit?: number;
  /** "provider/modelId" execution model for the derived default. */
  model?: string;
  /** Measured non-diff prompt chars (system prompt + policies). */
  nonDiffChars?: number;
}

/**
 * Resolves the diff cap for one review. An explicit value always wins and is
 * returned verbatim (callers may set it below the floor or above the derived
 * ceiling). Otherwise the cap is derived from the model's context window
 * minus the measured non-diff prompt and tool/output headroom, clamped to
 * [DEFAULT_MAX_CHARS, MAX_DERIVED_DIFF_CHARS]; unknown models keep 100k.
 */
export function resolveMaxDiffChars(options: MaxDiffCharsOptions): number {
  const explicit = parseMaxDiffChars(options.explicit);
  if (explicit !== undefined) return explicit;
  const limits = lookupModelLimits(options.model);
  if (!limits) return DEFAULT_MAX_CHARS;
  const outputReserve =
    limits.maxTokens > 0 ? limits.maxTokens * CHARS_PER_TOKEN : DEFAULT_OUTPUT_RESERVE_CHARS;
  const derived =
    limits.contextWindow * CHARS_PER_TOKEN -
    (options.nonDiffChars ?? 0) -
    TOOL_HEADROOM_CHARS -
    outputReserve;
  return Math.min(MAX_DERIVED_DIFF_CHARS, Math.max(DEFAULT_MAX_CHARS, Math.floor(derived)));
}
