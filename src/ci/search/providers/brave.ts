import { stripHtmlTags } from "../html.js";
import type { AiSearchResult, SearchProvider, SearchResult } from "../types.js";

const ORIGIN = "https://api.search.brave.com";

interface BraveChatDelta {
  content?: unknown;
}

interface BraveChatChoice {
  delta?: BraveChatDelta;
}

interface BraveChatChunk {
  choices?: BraveChatChoice[];
  citations?: unknown[];
}

interface BraveWebResponse {
  web?: {
    results?: unknown[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function chatChunk(value: unknown): BraveChatChunk | undefined {
  if (!isRecord(value)) return undefined;
  const choices = Array.isArray(value.choices)
    ? value.choices.filter(isRecord).map((choice) => ({
        delta: isRecord(choice.delta) ? choice.delta : undefined,
      }))
    : undefined;
  return {
    choices,
    citations: Array.isArray(value.citations) ? value.citations : undefined,
  };
}

function result(value: unknown, rank: number): SearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const item = value;
  if (typeof item.title !== "string" || typeof item.url !== "string") return undefined;
  return {
    title: item.title.slice(0, 500),
    url: item.url,
    snippet:
      typeof item.description === "string" ? stripHtmlTags(item.description).slice(0, 1_000) : "",
    provider: "brave",
    rank,
  };
}

function citation(value: unknown, rank: number): SearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const item = value;
  return result({ title: item.title, url: item.url, description: item.text ?? item.snippet }, rank);
}

async function responseJson(response: Response): Promise<BraveWebResponse> {
  if (!response.ok) throw new Error(`Brave request failed: ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error("Brave returned an invalid response");
  return {
    web: isRecord(value.web)
      ? { results: Array.isArray(value.web.results) ? value.web.results : undefined }
      : undefined,
  };
}

export function createBraveProvider(key: string): SearchProvider {
  const headers = { accept: "application/json", "x-subscription-token": key };
  return {
    id: "brave",
    supportsAi: true,
    async search(query, maxResults, signal) {
      const url = new URL(`${ORIGIN}/res/v1/web/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(maxResults));
      const data = await responseJson(await fetch(url, { headers, signal, redirect: "error" }));
      const values = data.web?.results ?? [];
      return values
        .map((item, index) => result(item, index + 1))
        .filter((item): item is SearchResult => Boolean(item));
    },
    async aiSearch(query, maxSources, signal): Promise<AiSearchResult> {
      const response = await fetch(`${ORIGIN}/res/v1/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: "brave",
          stream: true,
          enable_citations: true,
          enable_research: false,
          messages: [{ role: "user", content: query }],
        }),
        signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Brave AI request failed: ${response.status}`);
      const body = await response.text();
      let answer = "";
      const citations: SearchResult[] = [];
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const data = chatChunk(JSON.parse(raw));
          if (!data) continue;
          const content = data.choices?.[0]?.delta?.content;
          if (typeof content === "string") answer += content;
          const sourceValues = data.citations ?? [];
          for (const source of sourceValues) {
            const item = citation(source, citations.length + 1);
            if (item && !citations.some((existing) => existing.url === item.url))
              citations.push(item);
          }
        } catch {
          // Ignore non-JSON SSE keepalive frames; malformed substantive data is
          // rejected below when no grounded answer can be established.
        }
      }
      const tagged = [
        ...body.matchAll(/<citation[^>]*url=["']([^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>/gi),
      ];
      for (const [, url, title] of tagged)
        citations.push({
          title: title.slice(0, 500),
          url,
          snippet: "",
          provider: "brave",
          rank: citations.length + 1,
        });
      if (!answer.trim() || citations.length === 0)
        throw new Error("Brave returned an uncited answer");
      return { answer: answer.slice(0, 4_000), citations: citations.slice(0, maxSources) };
    },
  };
}
