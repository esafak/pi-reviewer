import { describe, expect, it } from "vite-plus/test";
import { extractPublicGitHubRepo, parseDeepWikiResult } from "../../src/core/deepwiki.js";

describe("extractPublicGitHubRepo", () => {
  it.each([
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["git@github.com:owner/repo.git", "owner/repo"],
  ])("resolves %s", (remote, expected) => {
    expect(extractPublicGitHubRepo(remote)).toBe(expected);
  });

  it.each(["git@gitlab.com:owner/repo.git", "https://github.com/owner/repo/tree/main", ""])(
    "rejects unsupported remote %s",
    (remote) => {
      expect(extractPublicGitHubRepo(remote)).toBeUndefined();
    },
  );
});

describe("parseDeepWikiResult", () => {
  it("prefers the structured result returned by MCP", () => {
    expect(
      parseDeepWikiResult({
        structuredContent: { result: "Structured documentation" },
        content: [{ type: "text", text: "Text fallback" }],
      }),
    ).toBe("Structured documentation");
  });

  it("supports text content when a server omits structured content", () => {
    expect(parseDeepWikiResult({ content: [{ type: "text", text: "Documentation" }] })).toBe(
      "Documentation",
    );
  });

  it("rejects MCP tool errors", () => {
    expect(() => parseDeepWikiResult({ isError: true, content: [] })).toThrow(
      "DeepWiki question tool returned an error",
    );
  });
});
