import type { SearchProvider, SearchResult } from "../types.js";
import { decodeHtmlEntities, stripHtmlTags } from "../html.js";

const ENDPOINT = "https://html.duckduckgo.com/html/";

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
        const urlValue = decodeHtmlEntities(match[1]);
        if (!/^https?:\/\//i.test(urlValue)) continue;
        results.push({
          title: decodeHtmlEntities(stripHtmlTags(match[2])).slice(0, 500),
          url: urlValue,
          snippet: decodeHtmlEntities(stripHtmlTags(match[3])).slice(0, 1_000),
          provider: "duckduckgo",
          rank: results.length + 1,
        });
      }
      return results;
    },
  };
}
