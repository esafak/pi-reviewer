import type { ExaOrBrave, SearchConfig, SearchProviderId } from "./types.js";

const PROVIDERS = ["exa", "brave", "duckduckgo"] as const;

function enabled(value: string | undefined): boolean {
  return value === "true";
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : undefined;
}

function provider(raw: string | undefined): SearchProviderId | undefined {
  return PROVIDERS.includes(raw as SearchProviderId) ? (raw as SearchProviderId) : undefined;
}

function keyFor(id: SearchProviderId): string | undefined {
  if (id === "exa") return process.env.EXA_API_KEY || undefined;
  if (id === "brave") return process.env.BRAVE_SEARCH_API_KEY || undefined;
  return undefined;
}

export function searchProviderKey(id: SearchProviderId): string | undefined {
  return keyFor(id);
}

export function resolveSearchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  const regularId = provider(env.PI_REVIEWER_SEARCH_PROVIDER);
  const aiId = env.PI_REVIEWER_AI_SEARCH_PROVIDER as ExaOrBrave | undefined;
  const regularKey = regularId
    ? regularId === "exa"
      ? env.EXA_API_KEY
      : regularId === "brave"
        ? env.BRAVE_SEARCH_API_KEY
        : undefined
    : undefined;
  const aiProvider = aiId === "exa" || aiId === "brave" ? aiId : undefined;
  const aiKey =
    aiProvider === "exa"
      ? env.EXA_API_KEY
      : aiProvider === "brave"
        ? env.BRAVE_SEARCH_API_KEY
        : undefined;
  const config: SearchConfig = {};

  const regularLimits = regularId
    ? [
        boundedInt(env.PI_REVIEWER_SEARCH_MAX_QUERIES, 3, 1, 10),
        boundedInt(env.PI_REVIEWER_SEARCH_MAX_RESULTS, 5, 1, 10),
        boundedInt(env.PI_REVIEWER_SEARCH_TIMEOUT_MS, 8_000, 1_000, 30_000),
      ]
    : [];
  if (
    enabled(env.PI_REVIEWER_WEB_SEARCH) &&
    regularId &&
    (regularId === "duckduckgo" || regularKey) &&
    regularLimits.every((value): value is number => value !== undefined)
  ) {
    config.regular = {
      provider: regularId,
      key: regularKey,
      maxQueries: regularLimits[0],
      maxResults: regularLimits[1],
      timeoutMs: regularLimits[2],
      required: enabled(env.PI_REVIEWER_SEARCH_REQUIRED),
    };
  }

  const aiLimits = aiProvider
    ? [
        boundedInt(env.PI_REVIEWER_AI_SEARCH_MAX_QUERIES, 1, 1, 3),
        boundedInt(env.PI_REVIEWER_AI_SEARCH_MAX_SOURCES, 5, 1, 10),
        boundedInt(env.PI_REVIEWER_AI_SEARCH_TIMEOUT_MS, 15_000, 2_000, 60_000),
      ]
    : [];
  if (
    enabled(env.PI_REVIEWER_AI_SEARCH) &&
    aiProvider &&
    aiKey &&
    aiLimits.every((value): value is number => value !== undefined)
  ) {
    config.ai = {
      provider: aiProvider,
      key: aiKey,
      maxQueries: aiLimits[0],
      maxSources: aiLimits[1],
      timeoutMs: aiLimits[2],
      required: enabled(env.PI_REVIEWER_AI_SEARCH_REQUIRED),
    };
  }

  return config;
}

export function unavailableSearchWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (enabled(env.PI_REVIEWER_WEB_SEARCH) && !resolveSearchConfig(env).regular)
    warnings.push(
      "regular web search is unavailable (select a provider and configure its key if required)",
    );
  if (enabled(env.PI_REVIEWER_AI_SEARCH) && !resolveSearchConfig(env).ai)
    warnings.push("AI web search is unavailable (select Exa or Brave and configure its key)");
  return warnings;
}
