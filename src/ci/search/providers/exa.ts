import type { AiSearchResult, SearchProvider, SearchResult } from "../types.js";

const ORIGIN = "https://api.exa.ai";

interface ExaResponse {
  results?: unknown[];
  answer?: unknown;
  citations?: unknown[];
  requestId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function json(response: Response): Promise<ExaResponse> {
  if (!response.ok) throw new Error(`Exa request failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("Exa returned an invalid response");
  return value;
}

function result(value: unknown, provider: "exa", rank: number): SearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const item = value;
  if (typeof item.title !== "string" || typeof item.url !== "string") return undefined;
  return {
    title: item.title.slice(0, 500),
    url: item.url,
    snippet:
      typeof item.text === "string"
        ? item.text.slice(0, 1_000)
        : typeof item.summary === "string"
          ? item.summary.slice(0, 1_000)
          : "",
    provider,
    rank,
    resultId: typeof item.id === "string" ? item.id : undefined,
    publishedAt: typeof item.publishedDate === "string" ? item.publishedDate : undefined,
  };
}

export function createExaProvider(key: string): SearchProvider {
  const request = (path: string, body: Record<string, unknown>, signal: AbortSignal) =>
    fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });

  return {
    id: "exa",
    supportsAi: true,
    async search(query, maxResults, signal) {
      const data = await json(
        await request("/search", { query, numResults: maxResults, type: "fast" }, signal),
      );
      const values = Array.isArray(data.results) ? data.results : [];
      return values
        .map((item, index) => result(item, "exa", index + 1))
        .filter((item): item is SearchResult => Boolean(item));
    },
    async aiSearch(query, maxSources, signal): Promise<AiSearchResult> {
      const data = await json(
        await request("/answer", { query, model: "exa", text: false }, signal),
      );
      if (typeof data.answer !== "string") throw new Error("Exa returned no answer");
      const values = Array.isArray(data.citations) ? data.citations : [];
      const citations = values
        .slice(0, maxSources)
        .map((item, index) => result(item, "exa", index + 1))
        .filter((item): item is SearchResult => Boolean(item));
      if (citations.length === 0) throw new Error("Exa returned an uncited answer");
      return {
        answer: data.answer.slice(0, 4_000),
        citations,
        requestId: typeof data.requestId === "string" ? data.requestId : undefined,
      };
    },
  };
}
