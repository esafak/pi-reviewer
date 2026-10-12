import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveGitHubResearchConfig,
  unavailableGitHubResearchWarnings,
} from "../../src/ci/github-research/config.js";
import { createGitHubResearchClient } from "../../src/ci/github-research/client.js";
import { createGitHubResearchTools } from "../../src/ci/github-research/tool.js";
import { validateGhArgs } from "../../src/ci/github-research/gh-allowlist.js";
import { createGhRunner } from "../../src/ci/github-research/gh-runner.js";

describe("gh-backed GitHub research", () => {
  it("enables with a token by default and supports opt-out", () => {
    expect(resolveGitHubResearchConfig({}, "t")).toEqual({ scope: "public", token: "t" });
    expect(resolveGitHubResearchConfig({ PI_REVIEWER_GH: "false" }, "t")).toBeUndefined();
    expect(unavailableGitHubResearchWarnings({})).toHaveLength(1);
  });
  it("allows only read operations and GET API", () => {
    expect(validateGhArgs(["pr", "view", "1", "--repo", "o/r"])).toBeUndefined();
    expect(validateGhArgs(["search", "code", "needle", "--json", "path"])).toBeUndefined();
    expect(validateGhArgs(["api", "repos/o/r", "--jq", ".private"])).toBeUndefined();
    for (const a of [
      ["pr", "merge", "1"],
      ["api", "repos/o/r", "-X", "POST"],
      ["api", "repos/o/r", "--input", "x"],
      ["issue", "close", "1"],
      ["pr", "view", "1;rm"],
    ])
      expect(validateGhArgs(a)).toBeTruthy();
  });
  it("uses execFile arguments and bounds output", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "[]" });
    const runner = createGhRunner("secret", run as never);
    expect(
      await runner(["search", "repos", "x", "--limit", "1", "--json", "name", "--jq", ".[:1]"]),
    ).toBe("[]");
    expect(run).toHaveBeenCalledWith(
      "gh",
      expect.any(Array),
      expect.objectContaining({
        timeout: 5000,
        maxBuffer: 7 * 1024 + 1,
        env: expect.objectContaining({ GH_TOKEN: "secret" }),
      }),
    );
    const oversized = vi.fn().mockResolvedValue({ stdout: "x".repeat(8 * 1024) });
    await expect(createGhRunner("t", oversized as never)(["repo", "view"])).rejects.toThrow(
      "budget",
    );
  });
  it("enforces the shared request and aggregate budgets", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "x".repeat(4 * 1024) });
    const gh = createGhRunner("t", run as never);
    await gh(["repo", "view"]);
    await gh(["repo", "view"]);
    await gh(["repo", "view"]);
    await expect(gh(["repo", "view"])).rejects.toThrow("output budget");
    const limited = createGhRunner("t", vi.fn().mockResolvedValue({ stdout: "ok" }) as never);
    for (let i = 0; i < 8; i++) await limited(["repo", "view"]);
    await expect(limited(["repo", "view"])).rejects.toThrow("request budget");
  });
  it("filters private search results in public scope", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ fullName: "org/public" }, { fullName: "org/private" }]),
      })
      .mockResolvedValueOnce({ stdout: "false" })
      .mockResolvedValueOnce({ stdout: "true" });
    const result = await createGitHubResearchClient("t", "public", Date.now, run as never).search(
      "repositories",
      "repo",
      5,
    );
    expect(result.results).toEqual([{ fullName: "org/public" }]);
  });
  it("soft-fails missing CLI and preserves the research tool names", async () => {
    const tools = createGitHubResearchTools(
      { scope: "public", token: "t" },
      {
        search: async () => {
          throw new Error("spawn gh ENOENT");
        },
        read: async () => ({}),
      },
    );
    const response = await tools[0]!.execute("id", { kind: "issues", query: "q" } as never);
    expect(JSON.stringify(response)).toContain("Continue without it");
    expect(tools.map((t) => t.name)).toEqual(["github_search", "github_read"]);
  });
  it("rejects unsupported API mutations", () => {
    expect(validateGhArgs(["api", "repos/o/r", "--method", "DELETE"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "-XPUT"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "--method=POST"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "--method", "POST"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "-XPOST"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "-X", "POST"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "-X", "GET", "--method=POST"])).toContain("GET");
    expect(validateGhArgs(["api", "repos/o/r", "--method=POST", "-X", "GET"])).toBeUndefined();
  });

  it("constructs allowlisted arguments for the advertised read kinds", async () => {
    const cases = [
      [
        { kind: "run", owner: "o", repo: "r", number: 11 },
        ["run", "view", "11", "--repo", "o/r", "--json", expect.any(String)],
      ],
      [
        { kind: "workflow", owner: "o", repo: "r", number: 12 },
        ["api", "repos/o/r/actions/workflows/12", "--jq", expect.any(String)],
      ],
      [
        { kind: "release", owner: "o", repo: "r", number: 13 },
        ["release", "view", "13", "--repo", "o/r", "--json", expect.any(String)],
      ],
      [{ kind: "diff", owner: "o", repo: "r", number: 14 }, ["pr", "diff", "14", "--repo", "o/r"]],
      [
        { kind: "checks", owner: "o", repo: "r", number: 15 },
        ["pr", "checks", "15", "--repo", "o/r", "--json", expect.any(String)],
      ],
      [
        { kind: "status", owner: "o", repo: "r" },
        ["pr", "status", "--repo", "o/r", "--json", expect.any(String)],
      ],
      [
        { kind: "discussion", owner: "o", repo: "r", number: 16 },
        ["api", "repos/o/r/discussions/16", "--jq", expect.any(String)],
      ],
    ] as const;
    for (const [params, expected] of cases) {
      const run = vi.fn().mockResolvedValue({ stdout: params.kind === "diff" ? "diff" : "{}" });
      await createGitHubResearchClient("t", "token-accessible", Date.now, run as never).read(
        params as never,
      );
      expect(run).toHaveBeenCalledWith("gh", expected, expect.any(Object));
    }
  });

  it("reads file content with allowlisted jq and decodes base64 in the client", async () => {
    const content = Buffer.from("export const answer = 42;\n").toString("base64");
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        path: "src/answer.ts",
        url: "https://github.com/o/r/blob/main/src/answer.ts",
        content,
      }),
    });
    const result = await createGitHubResearchClient(
      "t",
      "token-accessible",
      Date.now,
      run as never,
    ).read({ kind: "file", owner: "o", repo: "r", path: "src/answer.ts", ref: "main" });
    const argv = run.mock.calls[0]![1] as string[];
    expect(argv).toEqual([
      "api",
      "repos/o/r/contents/src/answer.ts?ref=main",
      "--jq",
      "{path:.path,url:.html_url,content:.content}",
    ]);
    expect(validateGhArgs(argv)).toBeUndefined();
    expect(result).toMatchObject({
      path: "src/answer.ts",
      content: "export const answer = 42;\n",
      ref: "main",
    });
  });
});
