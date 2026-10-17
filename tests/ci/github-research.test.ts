import { describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveGitHubResearchConfig,
  unavailableGitHubResearchWarnings,
} from "../../src/ci/github-research/config.js";
import { createGitHubResearchClient } from "../../src/ci/github-research/client.js";
import { createGitHubResearchTools } from "../../src/ci/github-research/tool.js";
import { validateGhArgs } from "../../src/ci/github-research/gh-allowlist.js";
import { createGhRunner } from "../../src/ci/github-research/gh-runner.js";
import { readCachedRange, saveCachedFile } from "../../src/ci/github-research/cache.js";
describe("gh-backed GitHub research", () => {
  it("enables with a token by default and supports opt-out", () => {
    expect(resolveGitHubResearchConfig({}, "t")).toEqual({ scope: "public", token: "t" });
    expect(resolveGitHubResearchConfig({ PI_REVIEWER_GH: "false" }, "t")).toBeUndefined();
    expect(unavailableGitHubResearchWarnings({})).toHaveLength(1);
  });
  it("allows only read operations and GET API", () => {
    expect(validateGhArgs(["pr", "view", "1", "--repo", "o/r"])).toBeUndefined();
    expect(
      validateGhArgs([
        "search",
        "code",
        "needle",
        "--limit",
        "5",
        "--json",
        "path,repository,url",
        "--jq",
        ".[:5]",
      ]),
    ).toBeUndefined();
    expect(validateGhArgs(["search", "prs", "q", "--label", "bug"])).toBeUndefined();
    expect(validateGhArgs(["run", "list", "--label", "bug"])).toContain("not allowed");
    expect(validateGhArgs(["repo", "view", "--hostname", "github.com"])).toContain("unsafe");
    expect(validateGhArgs(["repo", "view", "-R", "o/r"])).toContain("unsafe");
    expect(
      validateGhArgs([
        "repo",
        "view",
        "--json",
        "name,fullName,description,url,visibility,defaultBranch",
      ]),
    ).toContain("JSON fields");
    expect(validateGhArgs(["api", "repos/o/r", "--jq", ".private"])).toBeUndefined();
    for (const blocked of [
      ["api", "repos/o/r", "--jq", ".private | ."],
      ["api", "repos/o/r", "--template", "{{.}}"],
      ["api", "repos/o/r", "--paginate"],
      ["api", "repos/o/r", "--watch"],
      ["api", "repos/o/r", "--hostname", "github.com"],
      ["api", "repos/o/r", "-H", "github.com"],
      ["pr", "view", "1", "--web"],
      ["pr", "view", "1", "-R", "o/r"],
    ])
      expect(validateGhArgs(blocked)).toBeTruthy();
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
      await runner([
        "search",
        "repos",
        "x",
        "--limit",
        "1",
        "--json",
        "name,fullName,description,url,visibility,defaultBranch",
        "--jq",
        ".[:1]",
      ]),
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

  it("preserves byte-identical legacy search argv when all optional filters are absent", async () => {
    const cases = [
      [
        "repositories",
        [
          "search",
          "repos",
          "q",
          "--limit",
          "5",
          "--json",
          "name,fullName,description,url,visibility,defaultBranch",
          "--jq",
          ".[:5]",
        ],
      ],
      [
        "code",
        ["search", "code", "q", "--limit", "5", "--json", "path,repository,url", "--jq", ".[:5]"],
      ],
      [
        "pull_requests",
        [
          "search",
          "prs",
          "q",
          "--limit",
          "5",
          "--json",
          "number,title,state,url,repository,updatedAt",
          "--jq",
          ".[:5]",
        ],
      ],
      [
        "issues",
        [
          "search",
          "issues",
          "q",
          "--limit",
          "5",
          "--json",
          "number,title,state,url,repository,updatedAt",
          "--jq",
          ".[:5]",
        ],
      ],
      [
        "runs",
        [
          "run",
          "list",
          "--limit",
          "5",
          "--json",
          "databaseId,name,status,conclusion,url,headBranch,headSha",
          "--jq",
          ".[:5]",
        ],
      ],
      ["workflows", ["workflow", "list", "--json", "id,name,state,path", "--jq", ".[:5]"]],
      [
        "releases",
        [
          "release",
          "list",
          "--limit",
          "5",
          "--json",
          "tagName,name,isDraft,isLatest,publishedAt",
          "--jq",
          ".[:5]",
        ],
      ],
    ] as const;
    for (const [kind, oldArgv] of cases) {
      const run = vi.fn().mockResolvedValue({ stdout: "[]" });
      await createGitHubResearchClient("t", "token-accessible", Date.now, run as never).search(
        kind,
        "q",
        5,
        {},
      );
      expect(run.mock.calls[0]![1]).toEqual(oldArgv);
    }
  });
  it("maps typed filters to exact argv and rejects invalid values", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "[]" });
    await createGitHubResearchClient("t", "token-accessible", Date.now, run as never).search(
      "pull_requests",
      "q",
      5,
      {
        state: "merged",
        label: "bug",
        assignee: "octocat",
        author: "octocat",
        search: "is:public",
        match: "title",
        sort: "updated",
        order: "asc",
      },
    );
    const argv = run.mock.calls[0]![1] as string[];
    expect(argv).toEqual([
      "search",
      "prs",
      "is:public q",
      "--limit",
      "5",
      "--json",
      "number,title,state,url,repository,updatedAt",
      "--jq",
      ".[:5]",
      "--merged",
      "--label",
      "bug",
      "--assignee",
      "octocat",
      "--author",
      "octocat",
      "--match",
      "title",
      "--sort",
      "updated",
      "--order",
      "asc",
    ]);
    expect(validateGhArgs(argv)).toBeUndefined();
    await expect(
      createGitHubResearchClient("t", "token-accessible").search("pull_requests", "q", 5, {
        label: "good first issue",
      }),
    ).rejects.toThrow("invalid");
    await expect(
      createGitHubResearchClient("t", "token-accessible").search("runs", "q", 5, {
        branch: "../bad",
      }),
    ).rejects.toThrow("invalid");
    await expect(
      createGitHubResearchClient("t", "token-accessible").search("code", "q", 5, { sort: "stars" }),
    ).rejects.toThrow("invalid");
  });
  it("maps repository and code search filters with exact flag and JSON argv", async () => {
    const repoRun = vi.fn().mockResolvedValue({ stdout: "[]" });
    await createGitHubResearchClient("t", "token-accessible", Date.now, repoRun as never).search(
      "repositories",
      "q",
      5,
      { language: "typescript", match: "name", sort: "stars", order: "desc" },
    );
    expect(repoRun.mock.calls[0]![1]).toEqual([
      "search",
      "repos",
      "q",
      "--limit",
      "5",
      "--json",
      "name,fullName,description,url,visibility,defaultBranch",
      "--jq",
      ".[:5]",
      "--language",
      "typescript",
      "--match",
      "name",
      "--sort",
      "stars",
      "--order",
      "desc",
    ]);
    const codeRun = vi.fn().mockResolvedValue({ stdout: "[]" });
    await createGitHubResearchClient("t", "token-accessible", Date.now, codeRun as never).search(
      "code",
      "q",
      5,
      { language: "typescript", match: "path" },
    );
    expect(codeRun.mock.calls[0]![1]).toEqual([
      "search",
      "code",
      "q",
      "--limit",
      "5",
      "--json",
      "path,repository,url",
      "--jq",
      ".[:5]",
      "--language",
      "typescript",
      "--match",
      "path",
    ]);
    expect(validateGhArgs(repoRun.mock.calls[0]![1] as string[])).toBeUndefined();
    expect(validateGhArgs(codeRun.mock.calls[0]![1] as string[])).toBeUndefined();
  });
  it("maps repo-local search options exactly", async () => {
    const cases = [
      [
        "runs",
        {
          workflow: ".github/workflows/CI.yml",
          branch: "feature/test",
          status: "completed",
          event: "push",
        },
        [
          "--workflow",
          ".github/workflows/CI.yml",
          "--branch",
          "feature/test",
          "--status",
          "completed",
          "--event",
          "push",
        ],
      ],
      ["workflows", { all: true }, ["--all"]],
      [
        "releases",
        { exclude_drafts: true, exclude_prereleases: true, order: "asc" },
        ["--exclude-drafts", "--exclude-pre-releases", "--order", "asc"],
      ],
    ] as const;
    for (const [kind, options, suffix] of cases) {
      const run = vi.fn().mockResolvedValue({ stdout: "[]" });
      await createGitHubResearchClient("t", "token-accessible", Date.now, run as never).search(
        kind,
        "q",
        5,
        options,
      );
      const argv = run.mock.calls[0]![1] as string[];
      expect(argv.slice(-suffix.length)).toEqual(suffix);
      expect(validateGhArgs(argv)).toBeUndefined();
    }
  });
  it("handles failed-run logs only when exit 1 has non-empty stdout", async () => {
    const useful = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("failed run"), { code: 1, stdout: "log output" }));
    await expect(
      createGhRunner(
        "t",
        useful as never,
      )(["run", "view", "12", "--repo", "o/r", "--log", "--exit-status"]),
    ).resolves.toBe("log output");
    for (const error of [
      Object.assign(new Error("missing"), { code: 1, stdout: "", stderr: "404" }),
      Object.assign(new Error("other failure"), { code: 2, stdout: "some output" }),
    ]) {
      const failed = vi.fn().mockRejectedValue(error);
      await expect(
        createGhRunner(
          "t",
          failed as never,
        )(["run", "view", "12", "--repo", "o/r", "--log", "--exit-status"]),
      ).rejects.toBeInstanceOf(Error);
    }
  });
  it("parses failed run JSON when only exit-status is requested", async () => {
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("run failed"), {
        code: 1,
        stdout: JSON.stringify({ databaseId: 12, conclusion: "failure", status: "completed" }),
      }),
    );
    const result = await createGitHubResearchClient(
      "t",
      "token-accessible",
      Date.now,
      run as never,
    ).read({
      kind: "run",
      owner: "o",
      repo: "r",
      number: 12,
      exit_status: true,
    });
    expect(run.mock.calls[0]![1]).toEqual([
      "run",
      "view",
      "12",
      "--repo",
      "o/r",
      "--exit-status",
      "--json",
      "databaseId,name,status,conclusion,url,headBranch,headSha",
    ]);
    expect(result.result).toMatchObject({ databaseId: 12, conclusion: "failure" });
  });
  it("accepts run attempts only from 1 through 1000 in the argv allowlist", () => {
    for (const value of ["999", "1000"])
      expect(validateGhArgs(["run", "view", "12", "--attempt", value])).toBeUndefined();
    expect(validateGhArgs(["run", "view", "12", "--attempt", "1001"])).toContain("attempt");
  });
  it("maps read enrichments, truncates string and array comments, and caps logs", async () => {
    const forPr = (comments: unknown) =>
      vi.fn().mockResolvedValue({ stdout: JSON.stringify({ comments }) });
    const stringRun = forPr("c".repeat(5 * 1024));
    const stringResult = await createGitHubResearchClient(
      "t",
      "token-accessible",
      Date.now,
      stringRun as never,
    ).read({ kind: "pull_request", owner: "o", repo: "r", number: 8, comments: true });
    expect(stringRun.mock.calls[0]![1]).toEqual([
      "pr",
      "view",
      "8",
      "--repo",
      "o/r",
      "--json",
      "number,title,body,comments,state,url,headRefName,baseRefName,updatedAt,isDraft",
    ]);
    expect((stringResult.pull_request as { comments: string }).comments).toContain("[truncated]");
    const arrayResult = await createGitHubResearchClient(
      "t",
      "token-accessible",
      Date.now,
      forPr([{ body: "c".repeat(5 * 1024) }]) as never,
    ).read({ kind: "pull_request", owner: "o", repo: "r", number: 8, comments: true });
    expect((arrayResult.pull_request as { comments: string }).comments).toContain("[truncated]");
    const run = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("failed"), { code: 1, stdout: "x".repeat(5 * 1024) }),
      );
    const log = await createGitHubResearchClient(
      "t",
      "token-accessible",
      Date.now,
      run as never,
    ).read({
      kind: "run",
      owner: "o",
      repo: "r",
      number: 11,
      log: true,
      exit_status: true,
      attempt: 2,
    });
    expect(run.mock.calls[0]![1]).toEqual([
      "run",
      "view",
      "11",
      "--repo",
      "o/r",
      "--log",
      "--exit-status",
      "--attempt",
      "2",
    ]);
    expect(log.result).toContain("[truncated]");
    const nameOnly = vi.fn().mockResolvedValue({ stdout: "src/a.ts\n" });
    await createGitHubResearchClient("t", "token-accessible", Date.now, nameOnly as never).read({
      kind: "diff",
      owner: "o",
      repo: "r",
      number: 3,
      name_only: true,
    });
    expect(nameOnly.mock.calls[0]![1]).toEqual(["pr", "diff", "3", "--repo", "o/r", "--name-only"]);
    const branch = vi.fn().mockResolvedValue({ stdout: "{}" });
    await createGitHubResearchClient("t", "token-accessible", Date.now, branch as never).read({
      kind: "repository",
      owner: "o",
      repo: "r",
      branch: "feature/test",
    });
    expect(branch.mock.calls[0]![1]).toEqual([
      "repo",
      "view",
      "o/r",
      "--branch",
      "feature/test",
      "--json",
      "name,nameWithOwner,description,url,visibility,defaultBranchRef",
    ]);
    await expect(
      createGitHubResearchClient("t", "token-accessible").read({
        kind: "run",
        owner: "o",
        repo: "r",
        number: 3,
        attempt: 0,
      }),
    ).rejects.toThrow("attempt");
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
  it("checks the current checkout once for public repo-local searches", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ isPrivate: false, nameWithOwner: "org/repo" }),
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ name: "Build nightly" }]) });
    const result = await createGitHubResearchClient("t", "public", Date.now, run as never).search(
      "runs",
      "build",
      5,
    );
    expect(result.results).toEqual([{ name: "Build nightly" }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![1]).toEqual(["repo", "view", "--json", "isPrivate,nameWithOwner"]);
    expect(run.mock.calls[1]![1]).not.toContain("--repo");
  });
  it("does not add a repo privacy request for token-accessible local searches", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ name: "Build nightly" }]) });
    await createGitHubResearchClient("t", "token-accessible", Date.now, run as never).search(
      "runs",
      "build",
      5,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["run", "list", "--limit", "5"]));
  });
  it("uses only valid gh search code JSON fields", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ path: "src/a.ts" }]) });
    await createGitHubResearchClient("t", "token-accessible", Date.now, run as never).search(
      "code",
      "needle",
      5,
    );
    expect(run.mock.calls[0]![1]).toEqual([
      "search",
      "code",
      "needle",
      "--limit",
      "5",
      "--json",
      "path,repository,url",
      "--jq",
      ".[:5]",
    ]);
  });
  it("fails loudly when public-scope current repository visibility is unavailable", async () => {
    const run = vi.fn().mockRejectedValue(new Error("gh repo view failed"));
    await expect(
      createGitHubResearchClient("t", "public", Date.now, run as never).search(
        "workflows",
        "deploy",
        5,
      ),
    ).rejects.toThrow("gh repo view failed");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      "runs",
      [{ name: "Build docs nightly" }, { name: "Build weekly" }],
      "BUILD nightly",
      [{ name: "Build docs nightly" }],
    ],
    [
      "workflows",
      [
        { name: "Deploy app", path: ".github/workflows/deploy.yml" },
        { name: "Build app", path: ".github/workflows/build.yml" },
      ],
      "deploy workflow",
      [{ name: "Deploy app", path: ".github/workflows/deploy.yml" }],
    ],
    [
      "releases",
      [
        { name: "October release", tagName: "v2.1" },
        { name: "October release", tagName: "v1.0" },
      ],
      "OCTOBER v2",
      [{ name: "October release", tagName: "v2.1" }],
    ],
  ] as const)(
    "matches all whitespace-tokenized query terms for %s",
    async (kind, items, query, expected) => {
      const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify(items) });
      const result = await createGitHubResearchClient(
        "t",
        "token-accessible",
        Date.now,
        run as never,
      ).search(kind, query, 5);
      expect(result.results).toEqual(expected);
    },
  );
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
    expect(tools.map((t) => t.name)).toEqual(["github_search", "github_read", "github_grep"]);
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
        [
          "run",
          "view",
          "11",
          "--repo",
          "o/r",
          "--json",
          "databaseId,name,status,conclusion,url,headBranch,headSha",
        ],
      ],
      [
        { kind: "workflow", owner: "o", repo: "r", number: 12 },
        ["api", "repos/o/r/actions/workflows/12", "--jq", "{id,name,state,path,url,html_url}"],
      ],
      [
        { kind: "release", owner: "o", repo: "r", number: 13 },
        [
          "api",
          "repos/o/r/releases/13",
          "--jq",
          "{tagName:.tag_name,name,isDraft:.draft,url:.html_url,publishedAt:.published_at}",
        ],
      ],
      [{ kind: "diff", owner: "o", repo: "r", number: 14 }, ["pr", "diff", "14", "--repo", "o/r"]],
      [
        { kind: "checks", owner: "o", repo: "r", number: 15 },
        ["pr", "checks", "15", "--repo", "o/r", "--json", "name,state,workflow"],
      ],
      [
        { kind: "status", owner: "o", repo: "r" },
        [
          "pr",
          "status",
          "--repo",
          "o/r",
          "--json",
          "createdAt,headRefName,isDraft,number,state,statusCheckRollup,title,url",
        ],
      ],
      [
        { kind: "discussion", owner: "o", repo: "r", number: 16 },
        [
          "api",
          "repos/o/r/discussions/16",
          "--jq",
          "{number,title,body,html_url,created_at,updated_at,category:.category.name,user:.user.login}",
        ],
      ],
      [
        { kind: "repository", owner: "o", repo: "r" },
        [
          "repo",
          "view",
          "o/r",
          "--json",
          "name,nameWithOwner,description,url,visibility,defaultBranchRef",
        ],
      ],
    ] as const;
    for (const [params, expected] of cases) {
      const value =
        params.kind === "repository"
          ? { name: "r", nameWithOwner: "o/r", defaultBranchRef: { name: "main" } }
          : {};
      const run = vi
        .fn()
        .mockResolvedValue({ stdout: params.kind === "diff" ? "diff" : JSON.stringify(value) });
      const result = await createGitHubResearchClient(
        "t",
        "token-accessible",
        Date.now,
        run as never,
      ).read(params as never);
      expect(run).toHaveBeenCalledWith("gh", expected, expect.any(Object));
      if (params.kind === "repository")
        expect(result.result).toMatchObject({
          nameWithOwner: "o/r",
          defaultBranchRef: { name: "main" },
        });
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
  it("maps release fields and preserves a null publishedAt for drafts", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        tagName: "v1.0",
        name: "Draft release",
        isDraft: true,
        url: "https://github.com/o/r/releases/1",
        publishedAt: null,
      }),
    });
    const result = await createGitHubResearchClient(
      "t",
      "token-accessible",
      Date.now,
      run as never,
    ).read({ kind: "release", owner: "o", repo: "r", number: 1 });
    expect(run.mock.calls[0]![1]).toEqual([
      "api",
      "repos/o/r/releases/1",
      "--jq",
      "{tagName:.tag_name,name,isDraft:.draft,url:.html_url,publishedAt:.published_at}",
    ]);
    expect(result.result).toMatchObject({ isDraft: true, publishedAt: null });
  });
});

describe("github file cache, ranges, and grep", () => {
  const filePayload = (text: string) =>
    JSON.stringify({
      path: "docs/notes.md",
      url: "https://github.com/o/r/blob/main/docs/notes.md",
      content: Buffer.from(text).toString("base64"),
    });

  it("caches the full download while returning a preview with size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-cache-test-"));
    const previous = process.env.PI_REVIEWER_GH_CACHE_DIR;
    process.env.PI_REVIEWER_GH_CACHE_DIR = dir;
    try {
      const text = `${"alpha\n".repeat(100)}needle here\n${"beta\n".repeat(1000)}`;
      const run = vi.fn().mockResolvedValue({ stdout: filePayload(text) });
      const result = await createGitHubResearchClient(
        "t",
        "token-accessible",
        Date.now,
        run as never,
      ).read({ kind: "file", owner: "o", repo: "r", path: "docs/notes.md" });
      expect(result).toMatchObject({ size: Buffer.byteLength(text), truncated: true });
      expect(result.content as string).toContain("[truncated]");
      // Full text is recoverable from the cache without another gh call.
      const range = await readCachedRange(
        dir,
        { owner: "o", repo: "r", path: "docs/notes.md" },
        101,
        1,
      );
      expect(range?.content).toBe("needle here");
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.PI_REVIEWER_GH_CACHE_DIR;
      else process.env.PI_REVIEWER_GH_CACHE_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves ranged re-reads from the cache with no gh call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-range-test-"));
    await saveCachedFile(
      dir,
      { owner: "o", repo: "r", ref: "main", path: "docs/notes.md" },
      "one\ntwo\nthree\nfour\n",
    );
    const run = vi.fn().mockRejectedValue(new Error("must not fetch"));
    const client = createGitHubResearchClient("t", "token-accessible", Date.now, run as never);
    const tools = createGitHubResearchTools({ scope: "token-accessible", token: "t" }, client, {
      cacheDir: dir,
    });
    const response = (await tools[1]!.execute("id", {
      kind: "file",
      owner: "o",
      repo: "r",
      path: "docs/notes.md",
      ref: "main",
      offset: 2,
      limit: 2,
    } as never)) as { content: Array<{ text: string }> };
    const body = JSON.parse(response.content[0]!.text.split("\n").slice(1).join("\n")) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ content: "two\nthree", offset: 2, limit: 2, totalLines: 5 });
    expect(run).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects ranges for non-file kinds and out-of-range limits", async () => {
    const client = createGitHubResearchClient("t", "token-accessible");
    await expect(
      client.read({ kind: "repository", owner: "o", repo: "r", offset: 1 } as never),
    ).rejects.toThrow("only valid for file reads");
    await expect(
      client.read({ kind: "file", owner: "o", repo: "r", path: "a.md", limit: 201 } as never),
    ).rejects.toThrow("range is invalid");
  });

  it("greps cached downloads with logical keys and scope filters", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-grep-test-"));
    await saveCachedFile(dir, { owner: "o", repo: "r", path: "a.md" }, "hello needle one\nplain\n");
    await saveCachedFile(dir, { owner: "o", repo: "other", path: "b.md" }, "needle two\n");
    // The inner workspace grep is stubbed: unit tests assert scope mapping
    // and reframing, never the ripgrep binary (resolved over the network on
    // runners without it). Stub text mirrors the inner tool's relative-path
    // line format for each scope root.
    const executeGrep = async (_id: string, input: Record<string, unknown>) => ({
      content: [
        {
          type: "text",
          text: String(input.path ?? "")
            .replace(/\\/gu, "/")
            .endsWith("/default")
            ? "a.md:1: hello needle one"
            : "o/r/default/a.md:1: hello needle one\no/other/default/b.md:1: needle two",
        },
      ],
      details: {},
    });
    const tools = createGitHubResearchTools(
      { scope: "token-accessible", token: "t" },
      undefined as never,
      {
        cacheDir: dir,
        executeGrep,
      },
    );
    const scoped = (await tools[2]!.execute("id", {
      pattern: "needle",
      owner: "o",
      repo: "r",
    } as never)) as { content: Array<{ text: string }> };
    const scopedBody = JSON.parse(scoped.content[0]!.text.split("\n").slice(1).join("\n")) as {
      matches: Array<{ repository: string; path: string; line: number }>;
    };
    expect(scopedBody.matches).toEqual([
      expect.objectContaining({ repository: "o/r", path: "a.md", line: 1 }),
    ]);
    const response = (await tools[2]!.execute("id", { pattern: "needle" } as never)) as {
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(response.content[0]!.text.split("\n").slice(1).join("\n")) as {
      matches: Array<{ repository: string; path: string }>;
    };
    expect(body.matches.map((m) => `${m.repository}/${m.path}`).sort()).toEqual([
      "o/other/b.md",
      "o/r/a.md",
    ]);
    const empty = (await tools[2]!.execute("id", {
      pattern: "needle",
      owner: "o",
      repo: "missing",
    } as never)) as { content: Array<{ text: string }> };
    expect(empty.content[0]!.text).toContain("No cached downloads match this scope");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects grep patterns with control characters", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-grep-invalid-test-"));
    const tools = createGitHubResearchTools(
      { scope: "token-accessible", token: "t" },
      undefined as never,
      {
        cacheDir: dir,
      },
    );
    const response = (await tools[2]!.execute("id", { pattern: "a\x00b" } as never)) as {
      content: Array<{ text: string }>;
    };
    expect(response.content[0]!.text).toContain("GitHub grep unavailable");
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps cache-hit ranged reads within the per-result budget", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-range-budget-test-"));
    // Minified single-line shape: 200 lines still exceed 7 KiB without a cap.
    await saveCachedFile(
      dir,
      { owner: "o", repo: "r", path: "bundle.min.js" },
      `x${"y".repeat(900 * 1024)}`,
    );
    const run = vi.fn().mockRejectedValue(new Error("must not fetch"));
    const client = createGitHubResearchClient("t", "token-accessible", Date.now, run as never);
    const tools = createGitHubResearchTools({ scope: "token-accessible", token: "t" }, client, {
      cacheDir: dir,
    });
    const response = (await tools[1]!.execute("id", {
      kind: "file",
      owner: "o",
      repo: "r",
      path: "bundle.min.js",
      offset: 1,
      limit: 200,
    } as never)) as { content: Array<{ text: string }> };
    expect(Buffer.byteLength(response.content[0]!.text)).toBeLessThanOrEqual(7 * 1024);
    expect(response.content[0]!.text).toContain("[truncated]");
    expect(run).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });

  it("fails closed when JSON escaping inflates a cache hit past the budget", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-range-escape-test-"));
    // 4 KiB of quotes fits the content cap but escapes past the 7 KiB result
    // budget; the fetch path rejects the same file, so the re-read must too.
    await saveCachedFile(dir, { owner: "o", repo: "r", path: "quotes.md" }, `"`.repeat(4096));
    const run = vi.fn().mockRejectedValue(new Error("must not fetch"));
    const client = createGitHubResearchClient("t", "token-accessible", Date.now, run as never);
    const tools = createGitHubResearchTools({ scope: "token-accessible", token: "t" }, client, {
      cacheDir: dir,
    });
    const response = (await tools[1]!.execute("id", {
      kind: "file",
      owner: "o",
      repo: "r",
      path: "quotes.md",
      offset: 1,
      limit: 200,
    } as never)) as { content: Array<{ text: string }> };
    expect(response.content[0]!.text).toContain("GitHub read unavailable");
    expect(response.content[0]!.text).toContain("byte limit");
    await rm(dir, { recursive: true, force: true });
  });

  it("scopes grep to ref-less paths and directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-grep-scope-test-"));
    await saveCachedFile(
      dir,
      { owner: "o", repo: "r", ref: "main", path: "docs/a.md" },
      "scoped needle here\n",
    );
    await saveCachedFile(dir, { owner: "o", repo: "r", path: "docs/b.md" }, "default needle\n");
    const executeGrep = async (_id: string, input: Record<string, unknown>) => ({
      content: [
        {
          type: "text",
          text: String(input.path ?? "")
            .replace(/\\/gu, "/")
            .endsWith("b.md")
            ? "b.md:1: default needle"
            : "a.md:1: scoped needle here",
        },
      ],
      details: {},
    });
    const tools = createGitHubResearchTools(
      { scope: "token-accessible", token: "t" },
      undefined as never,
      {
        cacheDir: dir,
        executeGrep,
      },
    );
    const byFile = (await tools[2]!.execute("id", {
      pattern: "needle",
      owner: "o",
      repo: "r",
      path: "docs/b.md",
    } as never)) as { content: Array<{ text: string }> };
    const byFileBody = JSON.parse(byFile.content[0]!.text.split("\n").slice(1).join("\n")) as {
      matches: Array<{ path: string }>;
    };
    expect(byFileBody.matches.map((m) => m.path)).toEqual(["docs/b.md"]);
    const byDir = (await tools[2]!.execute("id", {
      pattern: "needle",
      owner: "o",
      repo: "r",
      ref: "main",
      path: "docs",
    } as never)) as { content: Array<{ text: string }> };
    const byDirBody = JSON.parse(byDir.content[0]!.text.split("\n").slice(1).join("\n")) as {
      matches: Array<{ path: string }>;
    };
    expect(byDirBody.matches.map((m) => m.path)).toEqual(["docs/a.md"]);
    await rm(dir, { recursive: true, force: true });
  });
});
