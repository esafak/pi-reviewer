import { createBraveProvider } from "./providers/brave.js";
import { createDuckDuckGoProvider } from "./providers/duckduckgo.js";
import { createExaProvider } from "./providers/exa.js";
import type {
  AiSearchResult,
  SearchCitation,
  SearchConfig,
  SearchProvider,
  SearchResult,
} from "./types.js";

const INTERNAL_MAX_WALL_TIME_MS = 120_000;

const hash = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
};

function provider(id: "exa" | "brave" | "duckduckgo", key?: string): SearchProvider {
  if (id === "exa") return createExaProvider(key!);
  if (id === "brave") return createBraveProvider(key!);
  return createDuckDuckGoProvider();
}

export interface SearchClient {
  search(
    query: string,
    maxResults?: number,
  ): Promise<{
    results: SearchResult[];
    citations: SearchCitation[];
    remainingQueries: number;
  }>;
  aiSearch(
    query: string,
    maxSources?: number,
  ): Promise<{
    answer: string;
    answerCitation: SearchCitation;
    citations: SearchCitation[];
    remainingQueries: number;
  }>;
  snapshot(): SearchCitation[];
  hasRequiredFailure(): boolean;
}

export function createSearchClient(config: SearchConfig): SearchClient {
  const regularProvider = config.regular
    ? provider(config.regular.provider, config.regular.key)
    : undefined;
  const aiProvider = config.ai ? provider(config.ai.provider, config.ai.key) : undefined;
  const ledger: SearchCitation[] = [];
  const started = Date.now();
  let regularCalls = 0;
  let aiCalls = 0;
  let requiredFailure = false;
  let nextCitationId = 1;

  const add = async (
    item: SearchResult,
    query: string,
    kind: SearchCitation["kind"] = "search-result",
  ): Promise<SearchCitation> => {
    // Reserve the ID before hashing so Promise.all cannot assign one ID to
    // several concurrent provider results.
    const entry = {
      id: `${kind === "ai-answer" ? "ai" : "web"}:${nextCitationId++}`,
      kind,
      provider: item.provider,
      title: item.title,
      url: item.url,
      queryHash: await hash(query),
      rank: item.rank,
      retrievedAt: new Date().toISOString(),
    };
    ledger.push(entry);
    return entry;
  };

  const guard = (
    kind: "regular" | "ai",
    query: string,
    limit: number,
    timeoutMs: number,
    required: boolean,
  ) => {
    const fail = (message: string): never => {
      if (required) requiredFailure = true;
      throw new Error(message);
    };
    if (
      !query.trim() ||
      query.length > 500 ||
      [...query].some((char) => {
        const code = char.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    )
      fail("Search query is invalid");
    if (Date.now() - started >= INTERNAL_MAX_WALL_TIME_MS)
      fail("Search wall-clock budget exhausted");
    if (kind === "regular" ? regularCalls >= limit : aiCalls >= limit)
      fail("Search query budget exhausted");
    return AbortSignal.timeout(timeoutMs);
  };

  return {
    async search(query, maxResults = config.regular?.maxResults ?? 5) {
      if (!regularProvider || !config.regular) throw new Error("Regular web search is unavailable");
      const signal = guard(
        "regular",
        query,
        config.regular.maxQueries,
        config.regular.timeoutMs,
        config.regular.required,
      );
      regularCalls++;
      let results: SearchResult[];
      try {
        results = await regularProvider.search(
          query,
          Math.min(maxResults, config.regular.maxResults),
          signal,
        );
      } catch (error) {
        if (config.regular.required) requiredFailure = true;
        throw error;
      }
      const citations = await Promise.all(results.map((item) => add(item, query)));
      return {
        results,
        citations,
        remainingQueries: config.regular.maxQueries - regularCalls,
      };
    },
    async aiSearch(query, maxSources = config.ai?.maxSources ?? 5) {
      if (!aiProvider?.aiSearch || !config.ai) throw new Error("AI web search is unavailable");
      const signal = guard(
        "ai",
        query,
        config.ai.maxQueries,
        config.ai.timeoutMs,
        config.ai.required,
      );
      aiCalls++;
      let answer: AiSearchResult;
      try {
        answer = await aiProvider.aiSearch(
          query,
          Math.min(maxSources, config.ai.maxSources),
          signal,
        );
      } catch (error) {
        if (config.ai.required) requiredFailure = true;
        throw error;
      }
      const citations = await Promise.all(answer.citations.map((item) => add(item, query)));
      const answerCitation = await add(
        {
          title: "AI-search answer",
          url: "https://example.invalid/ai-answer",
          snippet: "",
          provider: answer.citations[0]?.provider ?? config.ai.provider,
          rank: 0,
        },
        query,
        "ai-answer",
      );
      answerCitation.url = undefined;
      return {
        answer: answer.answer,
        answerCitation,
        citations,
        remainingQueries: config.ai.maxQueries - aiCalls,
      };
    },
    snapshot: () => [...ledger],
    hasRequiredFailure: () => requiredFailure,
  };
}
