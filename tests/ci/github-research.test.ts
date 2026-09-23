import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveGitHubResearchConfig,
  unavailableGitHubResearchWarnings,
} from "../../src/ci/github-research/config.js";
import {
  GITHUB_WALL_TIME_MS,
  createGitHubResearchClient,
  validOwner,
  validPath,
  validRef,
  validRepo,
} from "../../src/ci/github-research/client.js";
import { createGitHubResearchTools } from "../../src/ci/github-research/tool.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub research configuration", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(resolveGitHubResearchConfig({}, "token")).toBeUndefined();
  });

  it("defaults to public and requires a token when enabled", () => {
    expect(resolveGitHubResearchConfig({ PI_REVIEWER_GITHUB_RESEARCH: "true" }, "token")).toEqual({
      scope: "public",
      token: "token",
    });
    expect(resolveGitHubResearchConfig({ PI_REVIEWER_GITHUB_RESEARCH: "true" })).toBeUndefined();
  });

  it("fails closed on an unknown scope", () => {
    const env = {
      PI_REVIEWER_GITHUB_RESEARCH: "true",
      PI_REVIEWER_GITHUB_SCOPE: "anything",
    };
    expect(resolveGitHubResearchConfig(env, "token")).toBeUndefined();
    expect(unavailableGitHubResearchWarnings(env, "token")).toEqual([
      expect.stringContaining("scope must be public or token-accessible"),
    ]);
  });

  it("supports the explicit token-accessible scope", () => {
    expect(
      resolveGitHubResearchConfig(
        { PI_REVIEWER_GITHUB_RESEARCH: "true", PI_REVIEWER_GITHUB_SCOPE: "token-accessible" },
        "token",
      )?.scope,
    ).toBe("token-accessible");
  });
});

describe("GitHub research identifiers", () => {
  it("validates owners, repository names, refs, and relative paths", () => {
    expect(validOwner("org-name")).toBe(true);
    expect(validOwner("-org")).toBe(false);
    expect(validRepo("repo.name")).toBe(true);
    expect(validRepo("..")).toBe(false);
    expect(validRef("release/v1")).toBe(true);
    expect(validRef("-flag")).toBe(false);
    expect(validRef("../main")).toBe(false);
    expect(validPath("src/index.ts")).toBe(true);
    expect(validPath("/etc/passwd")).toBe(false);
    expect(validPath("src/../secret")).toBe(false);
  });
});

describe("GitHub research client", () => {
  it("searches code through REST and filters private results in public scope", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              name: "file.ts",
              path: "src/file.ts",
              html_url: "https://github.com/public/repo/blob/main/src/file.ts",
              repository: { name: "repo", full_name: "public/repo", private: false },
            },
            {
              name: "secret.ts",
              path: "src/secret.ts",
              html_url: "https://github.com/private/repo/blob/main/src/secret.ts",
              repository: { name: "repo", full_name: "private/repo", private: true },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubResearchClient("token", "public");
    const result = await client.search("code", "function thing", 5);
    expect(result.results).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("secret.ts");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/search/code?");
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=function+thing");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: expect.objectContaining({
        authorization: "Bearer token",
        "x-github-api-version": "2026-03-10",
      }),
    });
  });

  it("permits private search results only in token-accessible scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                name: "repo",
                full_name: "org/repo",
                private: true,
                html_url: "https://github.com/org/repo",
              },
            ],
          }),
        ),
      ),
    );
    const result = await createGitHubResearchClient("token", "token-accessible").search(
      "repositories",
      "repo",
      5,
    );
    expect(result.results).toEqual([expect.objectContaining({ full_name: "org/repo" })]);
  });

  it.each([
    ["issues", "ISSUE", "is:issue"],
    ["pull_requests", "PullRequest", "is:pr"],
  ] as const)(
    "searches %s through a visibility-aware GraphQL response",
    async (kind, typename, qualifier) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              search: {
                nodes: [
                  {
                    __typename: typename,
                    number: 12,
                    title: "Public result",
                    body: "Details",
                    ...(typename === "Issue"
                      ? { issueState: "OPEN" }
                      : { pullRequestState: "OPEN" }),
                    url: "https://github.com/org/repo/issues/12",
                    repository: { nameWithOwner: "org/repo", visibility: "PUBLIC" },
                  },
                  {
                    __typename: typename,
                    number: 13,
                    title: "Private result",
                    repository: { nameWithOwner: "org/private", visibility: "PRIVATE" },
                  },
                ],
              },
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const result = await createGitHubResearchClient("token", "public").search(kind, "search", 5);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].state).toBe("OPEN");
      expect(JSON.stringify(result)).not.toContain("Private result");
      const requestBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(requestBody.variables.query).toContain(qualifier);
      expect(requestBody.query).toContain("repository { nameWithOwner visibility }");
    },
  );

  it("verifies repository visibility before reading bounded file contents", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ private: false, full_name: "org/repo", default_branch: "main" }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "file",
            path: "src/index.ts",
            html_url: "https://github.com/org/repo/blob/main/src/index.ts",
            size: 3,
            content: Buffer.from("hi\n").toString("base64"),
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createGitHubResearchClient("token", "public").read({
      kind: "file",
      owner: "org",
      repo: "repo",
      path: "src/index.ts",
      ref: "main",
    });
    expect(result.content).toBe("hi\n");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/contents/src/index.ts");
    expect(String(fetchMock.mock.calls[1][0])).toContain("ref");
  });

  it("blocks a private repository before fetching its contents in public scope", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ private: true, full_name: "org/repo" })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubResearchClient("token", "public").read({
        kind: "file",
        owner: "org",
        repo: "repo",
        path: "README.md",
      }),
    ).rejects.toThrow("Private repositories");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([403, 429])(
    "redacts GitHub response bodies for rate-limit/permission status %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(new Response("private response", { status })),
      );
      await expect(
        createGitHubResearchClient("token", "public").search("code", "safe", 1),
      ).rejects.toThrow("rate limited or forbidden");
      try {
        await createGitHubResearchClient("token", "public").search("code", "safe", 1);
      } catch (error) {
        expect(String(error)).not.toContain("private response");
        expect(String(error)).not.toContain("token");
      }
    },
  );

  it("classifies an aborted request as a timeout without exposing the cause", async () => {
    const timeoutSignal = AbortSignal.abort();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("secret detail")));
    await expect(
      createGitHubResearchClient("token", "public").search("code", "safe", 1),
    ).rejects.toThrow("GitHub research request timed out");
  });

  it("enforces the shared request and wall-clock budgets", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ items: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const client = createGitHubResearchClient("token", "public");
    for (let index = 0; index < 8; index++) await client.search("code", "safe", 1);
    await expect(client.search("code", "safe", 1)).rejects.toThrow("request budget exhausted");

    let now = 0;
    const timedClient = createGitHubResearchClient("token", "public", () => now);
    now = GITHUB_WALL_TIME_MS;
    await expect(timedClient.search("code", "safe", 1)).rejects.toThrow("time budget exhausted");
  });

  it("uses a fixed GraphQL search for Discussions and filters by repository visibility", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            search: {
              nodes: [
                {
                  title: "Public",
                  body: "body",
                  number: 1,
                  repository: { nameWithOwner: "org/public", visibility: "PUBLIC" },
                },
                {
                  title: "Private",
                  body: "body",
                  number: 2,
                  repository: { nameWithOwner: "org/private", visibility: "PRIVATE" },
                },
              ],
            },
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createGitHubResearchClient("token", "public").search(
      "discussions",
      "query",
      5,
    );
    expect(result.results).toHaveLength(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain("type: DISCUSSION");
    expect(body.query).not.toContain("${");
    expect(body.variables).toEqual({ query: "query", first: 5 });
  });

  it("reads a specific Discussion and verifies repository visibility", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ private: false, full_name: "org/repo" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              repository: {
                visibility: "PUBLIC",
                discussion: {
                  title: "Design",
                  body: "Details",
                  number: 4,
                  url: "https://github.com/org/repo/discussions/4",
                  repository: { nameWithOwner: "org/repo", visibility: "PUBLIC" },
                },
              },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createGitHubResearchClient("token", "public").read({
      kind: "discussion",
      owner: "org",
      repo: "repo",
      number: 4,
    });
    expect(result.discussion).toEqual(expect.objectContaining({ number: 4, title: "Design" }));
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.query).toContain("discussion(number: $number)");
    expect(body.query).not.toContain("mutation");
    expect(body.variables).toEqual({ owner: "org", name: "repo", number: 4 });
  });

  it("returns a GitHub-specific not-found error for missing Discussions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ private: false, full_name: "org/repo" })),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: { repository: { visibility: "PUBLIC", discussion: null } } }),
          ),
        ),
    );
    await expect(
      createGitHubResearchClient("token", "public").read({
        kind: "discussion",
        owner: "org",
        repo: "repo",
        number: 999,
      }),
    ).rejects.toThrow("GitHub Discussion was not found");
  });

  it("marks a full search page as truncated", async () => {
    const response = JSON.stringify({
      items: Array.from({ length: 5 }, (_, index) => ({
        name: `repo-${index}`,
        full_name: `org/repo-${index}`,
        private: false,
        description: "description",
        html_url: "https://github.com/org/repo",
      })),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(response)),
    );
    const client = createGitHubResearchClient("token", "public");
    const first = await client.search("repositories", "repo", 5);
    expect(first.truncated).toBe(true);
  });

  it("enforces aggregate output across bounded search results", async () => {
    const response = JSON.stringify({
      items: Array.from({ length: 5 }, (_, index) => ({
        name: `file-${index}`,
        path: "src/".concat("p".repeat(450)),
        html_url: `https://github.com/org/repo/blob/main/${"u".repeat(250)}`,
        repository: {
          name: "r".repeat(100),
          full_name: "o".repeat(200),
          private: false,
          description: "description ".repeat(20),
          html_url: `https://github.com/${"u".repeat(280)}`,
          default_branch: "b".repeat(200),
          language: "l".repeat(80),
        },
      })),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => new Response(response)),
    );
    const client = createGitHubResearchClient("token", "public");
    const first = await client.search("code", "query", 5);
    expect(first.truncated).toBe(true);
    expect(first.results.length).toBeLessThan(5);
    await client.search("code", "query", 5);
    await expect(client.search("code", "query", 5)).rejects.toThrow(
      "aggregate output budget exhausted",
    );
  });

  it("enforces response and output size limits", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("x".repeat(140 * 1024), { headers: { "content-length": String(140 * 1024) } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createGitHubResearchClient("token", "public").search("issues", "bug", 5),
    ).rejects.toThrow("response exceeded the byte limit");
  });
});

describe("GitHub research tools", () => {
  it("exposes only bounded search and read tools", () => {
    const client = { search: vi.fn(), read: vi.fn() } as never;
    expect(
      createGitHubResearchTools({ scope: "public", token: "token" }, client).map(
        (tool) => tool.name,
      ),
    ).toEqual(["github_search", "github_read"]);
  });

  it("rejects mismatched read arguments without calling the client", async () => {
    const client = { search: vi.fn(), read: vi.fn() } as never;
    const [, read] = createGitHubResearchTools({ scope: "public", token: "token" }, client);
    const result = await read.execute("id", {
      kind: "issue",
      owner: "org",
      repo: "repo",
      path: "README.md",
      number: 1,
    });
    expect(result.content[0].text).toContain("Path and ref are only valid for file reads");
    expect(client.read).not.toHaveBeenCalled();
  });

  it("sanitizes and caps tool errors before returning them", async () => {
    const client = {
      search: vi.fn().mockRejectedValue(new Error(`failure\u0000${"x".repeat(300)}`)),
      read: vi.fn(),
    } as never;
    const [search] = createGitHubResearchTools({ scope: "public", token: "token" }, client);
    const result = await search.execute("id", { kind: "code", query: "safe" });
    const text = result.content[0].text;
    expect(text).not.toContain("\u0000");
    expect(text.length).toBeLessThan(400);
    expect(text).toContain("failure");
  });
});
