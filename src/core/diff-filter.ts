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

function isNoise(filePath: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(filePath));
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
 *
 * The caller supplies the noise list: the review mode uses the shared
 * `NOISE_PATTERNS` unchanged, and the dependency mode adds the lockfiles whose
 * churn would otherwise crowd out the manifest change it is analyzing.
 */
export function stripNoiseFiles(
  raw: string,
  patterns: readonly RegExp[] = NOISE_PATTERNS,
): StrippedDiff {
  const sections = raw.split(/(?=^diff --git )/m).filter((s) => s.trim());

  const kept: string[] = [];
  const excluded: string[] = [];

  for (const section of sections) {
    const firstLine = section.split("\n")[0];
    const filePath = parseFilePath(firstLine);
    if (filePath && isNoise(filePath, patterns)) {
      excluded.push(filePath);
    } else {
      kept.push(section);
    }
  }

  return { kept, excluded };
}

export function filterDiff(
  raw: string,
  maxChars = DEFAULT_MAX_CHARS,
  patterns: readonly RegExp[] = NOISE_PATTERNS,
): FilterResult {
  const { kept, excluded } = stripNoiseFiles(raw, patterns);

  const warnings: string[] = [];

  if (excluded.length > 0) {
    warnings.push(
      `${excluded.length} noise file${excluded.length > 1 ? "s" : ""} excluded (${excluded.join(", ")})`,
    );
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
