export type SearchProviderId = "exa" | "brave" | "duckduckgo";

export type SearchFailureCode =
  | "unavailable"
  | "invalid_response"
  | "timeout"
  | "rate_limited"
  | "budget_exhausted";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: SearchProviderId;
  rank: number;
  resultId?: string;
  publishedAt?: string;
}

export interface SearchCitation {
  id: string;
  kind: "search-result" | "ai-answer";
  provider: SearchProviderId;
  title?: string;
  url?: string;
  queryHash: string;
  rank: number;
  retrievedAt: string;
}

export interface AiSearchResult {
  answer: string;
  citations: SearchResult[];
  requestId?: string;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  readonly supportsAi: boolean;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<SearchResult[]>;
  aiSearch?(query: string, maxSources: number, signal: AbortSignal): Promise<AiSearchResult>;
}

export interface SearchConfig {
  regular?: {
    provider: SearchProviderId;
    key?: string;
    maxQueries: number;
    maxResults: number;
    timeoutMs: number;
    required: boolean;
  };
  ai?: {
    provider: ExaOrBrave;
    key: string;
    maxQueries: number;
    maxSources: number;
    timeoutMs: number;
    required: boolean;
  };
}

export type ExaOrBrave = "exa" | "brave";

export interface SearchLedger {
  citations: SearchCitation[];
  add(result: SearchResult, query: string): SearchCitation;
}
