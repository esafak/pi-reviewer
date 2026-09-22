import type { SearchProvider, SearchResult } from "../types.js";

const ENDPOINT = "https://html.duckduckgo.com/html/";

function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function createDuckDuckGoProvider(): SearchProvider {
  return {
    id: "duckduckgo",
    supportsAi: false,
    async search(query, maxResults, signal) {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      const response = await fetch(url, {
        signal,
        redirect: "error",
        headers: { accept: "text/html" },
      });
      if (!response.ok) throw new Error(`DuckDuckGo request failed: ${response.status}`);
      const html = (await response.text()).slice(0, 500_000);
      const results: SearchResult[] = [];
      const pattern =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(pattern)) {
        if (results.length >= maxResults) break;
        const urlValue = decode(match[1]);
        if (!/^https?:\/\//i.test(urlValue)) continue;
        results.push({
          title: decode(match[2].replace(/<[^>]+>/g, "")).slice(0, 500),
          url: urlValue,
          snippet: decode(match[3].replace(/<[^>]+>/g, "")).slice(0, 1_000),
          provider: "duckduckgo",
          rank: results.length + 1,
        });
      }
      return results;
    },
  };
}
