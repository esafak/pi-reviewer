import { describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveGitHubResearchConfig,
  unavailableGitHubResearchWarnings,
} from "../../src/ci/github-research/config.js";
import { createGitHubResearchClient } from "../../src/ci/github-research/client.js";
import { MAX_RELEASE_BODY_CHARS } from "../../src/ci/github-research/client.js";
import {
  MAX_RELEASE_NAME_CHARS,
  MAX_RELEASE_PUBLISHED_CHARS,
  MAX_RELEASE_TAG_CHARS,
  MAX_RELEASE_URL_CHARS,
  RELEASE_JQ_EXPRESSION,
  RELEASE_METADATA_CHARS,
} from "../../src/ci/github-research/gh-allowlist.js";
import type { GitHubResearchClient } from "../../src/ci/github-research/client.js";
import { createGitHubResearchTools } from "../../src/ci/github-research/tool.js";
import { githubReadSchema } from "../../src/ci/github-research/tool.js";
import { validateGhArgs } from "../../src/ci/github-research/gh-allowlist.js";
import { createGhRunner, MAX_GH_RESULT_BYTES } from "../../src/ci/github-research/gh-runner.js";
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
  it("no longer allows the removed read commands and options", () => {
    // `pr status` and `repo view --branch` left the read contract.
    expect(validateGhArgs(["pr", "status", "--repo", "o/r"])).toContain("not allowed");
    expect(validateGhArgs(["repo", "view", "o/r", "--branch", "main"])).toContain("not allowed");
    // The search side keeps its own branch and status filters, which reach
    // the run list command.
    expect(validateGhArgs(["run", "list", "--branch", "main"])).toBeUndefined();
    expect(validateGhArgs(["run", "list", "--status", "queued"])).toBeUndefined();
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
  describe("time budget", () => {
    // The runner measures time spent inside the subprocess, so the clock is
    // injected and the mock exec is what advances it.
    interface TimedRun {
      mock: { calls: Array<[string, string[], { timeout?: number }]> };
    }
    const timeoutsOf = (run: TimedRun) => run.mock.calls.map((call) => call[2]?.timeout);
    it("does not spend the allowance on time between calls", async () => {
      let now = 0;
      const run = vi.fn(
        async (_command: string, _args: string[], _options: { timeout?: number }) => {
          now += 1;
          return { stdout: "ok" };
        },
      );
      const gh = createGhRunner("t", run as never, { now: () => now });
      for (let i = 0; i < 8; i++) {
        now += 60_000;
        await expect(gh(["repo", "view"])).resolves.toBe("ok");
      }
      expect(run).toHaveBeenCalledTimes(8);
    });
    it("fails without dispatching once the allowance is spent", async () => {
      let now = 0;
      const run = vi.fn(
        async (_command: string, _args: string[], _options: { timeout?: number }) => {
          now += 100;
          return { stdout: "ok" };
        },
      );
      const gh = createGhRunner("t", run as never, { now: () => now, waitMs: 500, timeoutMs: 500 });
      for (let i = 0; i < 5; i++) await gh(["repo", "view"]);
      await expect(gh(["repo", "view"])).rejects.toThrow("time budget exhausted");
      expect(run).toHaveBeenCalledTimes(5);
      await expect(gh(["repo", "view"])).rejects.toThrow("time budget exhausted");
      expect(run).toHaveBeenCalledTimes(5);
    });
    it("shrinks the subprocess timeout as the allowance is consumed", async () => {
      let now = 0;
      const run = vi.fn(
        async (_command: string, _args: string[], _options: { timeout?: number }) => {
          now += 400;
          return { stdout: "ok" };
        },
      );
      const gh = createGhRunner("t", run as never, {
        now: () => now,
        waitMs: 1000,
        timeoutMs: 300,
      });
      await gh(["repo", "view"]);
      await gh(["repo", "view"]);
      await gh(["repo", "view"]);
      // The timeout is the per-call ceiling until the remaining allowance
      // drops below it, then it shrinks with the allowance.
      expect(timeoutsOf(run)).toEqual([300, 300, 200]);
    });
    it("charges the allowance for a subprocess that throws", async () => {
      let now = 0;
      const run = vi.fn(async () => {
        now += 100;
        throw new Error("boom");
      });
      const gh = createGhRunner("t", run as never, {
        now: () => now,
        waitMs: 250,
        timeoutMs: 5000,
      });
      await expect(gh(["repo", "view"])).rejects.toThrow("boom");
      await expect(gh(["repo", "view"])).rejects.toThrow("boom");
      await expect(gh(["repo", "view"])).rejects.toThrow("boom");
      expect(run).toHaveBeenCalledTimes(3);
      await expect(gh(["repo", "view"])).rejects.toThrow("time budget exhausted");
      expect(run).toHaveBeenCalledTimes(3);
    });
    it("keeps the queue alive after a rejected subprocess", async () => {
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("first failed"))
        .mockResolvedValue({ stdout: "ok" });
      const gh = createGhRunner("t", run as never);
      await expect(gh(["repo", "view"])).rejects.toThrow("first failed");
      await expect(gh(["repo", "view"])).resolves.toBe("ok");
    });
    it("dispatches one subprocess at a time so concurrent calls share one allowance", async () => {
      let now = 0;
      let active = 0;
      let peak = 0;
      const run = vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        now += 10;
        active -= 1;
        return { stdout: "ok" };
      });
      const gh = createGhRunner("t", run as never, {
        now: () => now,
        waitMs: 1000,
        timeoutMs: 5000,
      });
      const results = await Promise.all([
        gh(["repo", "view"]),
        gh(["repo", "view"]),
        gh(["repo", "view"]),
      ]);
      expect(results).toEqual(["ok", "ok", "ok"]);
      expect(peak).toBe(1);
    });
    it("passes an integer timeout for a fractional clock", async () => {
      let now = 0;
      const run = vi.fn(
        async (_command: string, _args: string[], _options: { timeout?: number }) => {
          now += 5.25;
          return { stdout: "ok" };
        },
      );
      const gh = createGhRunner("t", run as never, {
        now: () => now,
        waitMs: 100,
        timeoutMs: 5000,
      });
      await gh(["repo", "view"]);
      await gh(["repo", "view"]);
      const timeouts = timeoutsOf(run);
      expect(timeouts).toEqual([100, 94]);
      expect(timeouts.every((timeout) => Number.isInteger(timeout))).toBe(true);
      // Below a millisecond the call is rejected rather than dispatched with
      // a timeout of 0, which would disable the timeout instead of expiring it.
      let barely = 0;
      const barelyRun = vi.fn(async () => {
        barely += 9.6;
        return { stdout: "ok" };
      });
      const barelyGh = createGhRunner("t", barelyRun as never, {
        now: () => barely,
        waitMs: 10,
        timeoutMs: 5000,
      });
      await barelyGh(["repo", "view"]);
      await expect(barelyGh(["repo", "view"])).rejects.toThrow("time budget exhausted");
      expect(barelyRun).toHaveBeenCalledTimes(1);
    });
    it("rejects a limit that is not a finite positive number", () => {
      const run = vi.fn().mockResolvedValue({ stdout: "ok" });
      expect(() => createGhRunner("t", run as never, { waitMs: Number.NaN })).toThrow(
        "Invalid gh limit",
      );
      expect(() => createGhRunner("t", run as never, { timeoutMs: 0 })).toThrow("Invalid gh limit");
    });
  });

  describe("visibility probe cache", () => {
    const publicRepo = { stdout: "false" };
    const privateRepo = { stdout: "true" };
    const pullRequest = { stdout: JSON.stringify({ number: 1, title: "t" }) };
    const checkout = (host: string) => ({
      stdout: JSON.stringify({
        isPrivate: false,
        nameWithOwner: "org/repo",
        url: `https://${host}/org/repo`,
      }),
    });

    interface Fixture {
      calls: string[][];
      /** The keyed visibility probes issued for a repository. */
      keyed: (repo: string) => number;
      /** The checkout visibility probes issued. */
      checkoutProbes: () => number;
      client: GitHubResearchClient;
    }
    // One client over a mocked gh: the mock records every argv so a test can
    // count probes against content requests.
    const fixture = (respond: (args: string[]) => { stdout: string }): Fixture => {
      const calls: string[][] = [];
      const run = vi.fn(async (_cmd: string, args: string[]) => {
        calls.push(args);
        return respond(args);
      });
      return {
        calls,
        keyed: (repo) =>
          calls.filter(
            (args) => args[0] === "api" && args[1]?.toLowerCase() === `repos/${repo.toLowerCase()}`,
          ).length,
        checkoutProbes: () =>
          calls.filter((args) => args[0] === "repo" && args[1] === "view").length,
        client: createGitHubResearchClient("t", "public", run as never),
      };
    };
    const readPr = (client: GitHubResearchClient, repo = "org/repo") => {
      const [owner, name] = repo.split("/");
      return client.read({ kind: "pull_request", owner, repo: name, number: 1 });
    };

    // The probe-count rules, as one table: each case names the operations and
    // the probes they must produce.
    let failedProbe = false;
    const cases: Array<{
      label: string;
      respond: (args: string[]) => { stdout: string };
      run: (client: GitHubResearchClient) => Promise<unknown>;
      keyed: Record<string, number>;
      checkout?: number;
      /** The error every operation in the case rejects with, when it must. */
      throws?: string;
    }> = [
      {
        label: "two reads of one repository probe it once",
        respond: (args) => (args[0] === "api" ? publicRepo : pullRequest),
        run: async (client) => {
          await readPr(client);
          await readPr(client);
        },
        keyed: { "org/repo": 1 },
      },
      {
        label: "a search and a later read share the probe",
        respond: (args) =>
          args[0] === "search"
            ? { stdout: JSON.stringify([{ fullName: "org/repo", description: "d" }]) }
            : args[0] === "api"
              ? publicRepo
              : pullRequest,
        run: async (client) => {
          await client.search("repositories", "q", 5);
          await readPr(client);
        },
        keyed: { "org/repo": 1 },
      },
      {
        label: "search rows that share a repository probe it once",
        respond: (args) =>
          args[0] === "search"
            ? {
                stdout: JSON.stringify([
                  { fullName: "org/repo", description: "d" },
                  { fullName: "org/repo", description: "d2" },
                ]),
              }
            : args[0] === "api"
              ? publicRepo
              : pullRequest,
        run: async (client) => {
          await client.search("repositories", "q", 5);
        },
        keyed: { "org/repo": 1 },
      },
      {
        label: "repeated private rows are probed once",
        respond: (args) =>
          args[0] === "search"
            ? {
                stdout: JSON.stringify([
                  { fullName: "org/secret", description: "d" },
                  { fullName: "org/secret", description: "d2" },
                ]),
              }
            : args[0] === "api"
              ? privateRepo
              : pullRequest,
        run: async (client) => {
          await client.search("repositories", "q", 5);
        },
        keyed: { "org/secret": 1 },
      },
      {
        label: "different repositories are probed separately",
        respond: (args) => (args[0] === "api" ? publicRepo : pullRequest),
        run: async (client) => {
          await readPr(client, "org/one");
          await readPr(client, "org/two");
        },
        keyed: { "org/one": 1, "org/two": 1 },
      },
      {
        label: "cache keys are case-normalized",
        respond: (args) => (args[0] === "api" ? publicRepo : pullRequest),
        run: async (client) => {
          await client.read({ kind: "pull_request", owner: "Org", repo: "Repo", number: 1 });
          await readPr(client);
        },
        keyed: { "org/repo": 1 },
      },
      {
        label: "a failed probe is not retained and is retried",
        respond: (args) => {
          if (args[0] !== "api") return pullRequest;
          if (failedProbe) return publicRepo;
          failedProbe = true;
          throw new Error("network down");
        },
        run: async (client) => {
          await readPr(client).catch(() => undefined);
          await readPr(client);
        },
        keyed: { "org/repo": 2 },
      },
      {
        label: "two local searches probe the checkout once",
        respond: (args) => (args[0] === "repo" ? checkout("github.com") : { stdout: "[]" }),
        run: async (client) => {
          await client.search("runs", "build", 5);
          await client.search("runs", "build", 5);
        },
        keyed: {},
        checkout: 1,
      },
      {
        label: "a private checkout is not retained",
        respond: (args) =>
          args[0] === "repo"
            ? {
                stdout: JSON.stringify({
                  isPrivate: true,
                  nameWithOwner: "org/repo",
                  url: "https://github.com/org/repo",
                }),
              }
            : { stdout: "[]" },
        run: async (client) => {
          await client.search("runs", "build", 5).catch(() => undefined);
          await client.search("runs", "build", 5).catch(() => undefined);
        },
        keyed: {},
        checkout: 2,
      },
      {
        label: "a row whose repository cannot be resolved is admitted without a probe",
        respond: (args) =>
          args[0] === "search"
            ? { stdout: JSON.stringify([{ visibility: "PUBLIC", description: "d" }]) }
            : { stdout: "[]" },
        run: async (client) => {
          await client.search("repositories", "q", 5);
        },
        keyed: {},
      },
    ];
    for (const testCase of cases) {
      it(testCase.label, async () => {
        const { client, keyed, checkoutProbes } = fixture(testCase.respond);
        if (testCase.throws) await expect(testCase.run(client)).rejects.toThrow(testCase.throws);
        else await testCase.run(client);
        for (const [repo, count] of Object.entries(testCase.keyed))
          expect(keyed(repo), `keyed probes for ${repo}`).toBe(count);
        if (testCase.checkout !== undefined)
          expect(checkoutProbes(), "checkout probes").toBe(testCase.checkout);
      });
    }
    it("shares one checkout probe between concurrent local searches", async () => {
      const { client, checkoutProbes } = fixture((args) =>
        args[0] === "repo" ? checkout("github.com") : { stdout: "[]" },
      );
      await Promise.all([client.search("runs", "build", 5), client.search("runs", "build", 5)]);
      expect(checkoutProbes()).toBe(1);
    });
    it("probes a negative verdict once across concurrent searches", async () => {
      const { client, keyed } = fixture((args) =>
        args[0] === "search"
          ? {
              stdout: JSON.stringify([
                { fullName: "org/secret", description: "d" },
                { fullName: "org/secret", description: "d2" },
              ]),
            }
          : args[0] === "api"
            ? privateRepo
            : pullRequest,
      );
      await Promise.all([
        client.search("repositories", "q", 5),
        client.search("repositories", "q", 5),
      ]);
      expect(keyed("org/secret")).toBe(1);
    });
    it("shares one probe between concurrent lookups of a repository", async () => {
      const { client, keyed } = fixture((args) => (args[0] === "api" ? publicRepo : pullRequest));
      await Promise.all([readPr(client), readPr(client)]);
      expect(keyed("org/repo")).toBe(1);
    });
    it("does not share a cache between clients", async () => {
      const { client, keyed } = fixture((args) => (args[0] === "api" ? publicRepo : pullRequest));
      await readPr(client);
      const second = fixture((args) => (args[0] === "api" ? publicRepo : pullRequest));
      await readPr(second.client);
      expect(keyed("org/repo")).toBe(1);
      expect(second.keyed("org/repo")).toBe(1);
    });
    it("denies a read and excludes a row when the repository is private", async () => {
      const { client, calls, keyed } = fixture((args) =>
        args[0] === "search"
          ? { stdout: JSON.stringify([{ fullName: "org/secret", description: "d" }]) }
          : args[0] === "api"
            ? privateRepo
            : pullRequest,
      );
      await expect(readPr(client, "org/secret")).rejects.toThrow(
        "Private repositories are unavailable in public scope",
      );
      expect(calls.filter((args) => args[0] === "pr")).toHaveLength(0);
      const result = await client.search("repositories", "q", 5);
      expect(result.results).toEqual([]);
      expect(keyed("org/secret")).toBe(2);
    });
    it("does not retain a malformed verdict", async () => {
      const { client, keyed } = fixture((args) =>
        args[0] === "api" ? { stdout: "maybe" } : pullRequest,
      );
      await expect(readPr(client)).rejects.toThrow(
        "Private repositories are unavailable in public scope",
      );
      await expect(readPr(client)).rejects.toThrow(
        "Private repositories are unavailable in public scope",
      );
      expect(keyed("org/repo")).toBe(2);
    });
    it("seeds the keyed cache from the checkout when the host matches", async () => {
      const { client, keyed, checkoutProbes } = fixture((args) =>
        args[0] === "repo"
          ? checkout("github.com")
          : args[0] === "api"
            ? publicRepo
            : { stdout: "[]" },
      );
      await client.search("runs", "build", 5);
      await readPr(client);
      expect(keyed("org/repo")).toBe(0);
      expect(checkoutProbes()).toBe(1);
    });
    it("keeps the caches separate when the checkout host differs", async () => {
      const { client, keyed, checkoutProbes } = fixture((args) =>
        args[0] === "repo"
          ? checkout("ghe.example.com")
          : args[0] === "api"
            ? publicRepo
            : { stdout: "[]" },
      );
      await client.search("runs", "build", 5);
      await readPr(client);
      expect(keyed("org/repo")).toBe(1);
      expect(checkoutProbes()).toBe(1);
    });
  });

  it("keeps the read schema aligned with the read contract", () => {
    const schema = githubReadSchema as unknown as {
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    // An argument the schema no longer lists is rejected by the harness
    // before execute runs, so the obsolete ones are gone from the schema too.
    expect(Object.keys(schema.properties)).not.toContain("branch");
    expect(schema.additionalProperties).toBe(false);
    const kind = schema.properties.kind as { enum?: readonly string[] };
    expect(kind.enum).toContain("checks");
    expect(kind.enum).not.toContain("status");
  });

  it("reads a file at a commit SHA", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        path: "a.md",
        url: "u",
        content: Buffer.from("hi").toString("base64"),
      }),
    });
    const result = await createGitHubResearchClient("t", "token-accessible", run as never).read({
      kind: "file",
      owner: "o",
      repo: "r",
      path: "a.md",
      ref: "a40e42aa59dcfea801b7d9f70a64e53de4ee7ab1",
    });
    expect(run.mock.calls[0]![1]).toEqual([
      "api",
      "repos/o/r/contents/a.md?ref=a40e42aa59dcfea801b7d9f70a64e53de4ee7ab1",
      "--jq",
      "{path:.path,url:.html_url,content:.content}",
    ]);
    expect((result as { content: string }).content).toBe("hi");
  });

  describe("read contract", () => {
    interface ToolResult {
      content: Array<{ text: string }>;
      isError?: boolean;
    }
    const stubClient = () => {
      const read = vi.fn().mockResolvedValue({});
      const search = vi.fn().mockResolvedValue({});
      return { read, search, client: { read, search } as unknown as GitHubResearchClient };
    };
    const reject = async (args: Record<string, unknown>) => {
      const { read, client } = stubClient();
      const tools = createGitHubResearchTools({ scope: "token-accessible", token: "t" }, client);
      const response = (await tools[1]!.execute("id", args as never)) as ToolResult;
      return { response, read };
    };
    it("rejects a number on a kind that does not take one", async () => {
      const { response, read } = await reject({
        kind: "file",
        owner: "o",
        repo: "r",
        path: "a.md",
        number: 1,
      });
      expect(response.content[0]!.text).toContain("A number is not valid for the file kind");
      expect(response.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
    it("rejects path and ref on a kind that is not a file", async () => {
      const { response, read } = await reject({
        kind: "pull_request",
        owner: "o",
        repo: "r",
        number: 1,
        ref: "main",
      });
      expect(response.content[0]!.text).toContain("ref is only valid for file reads");
      expect(response.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
    it("rejects a kind-specific option on the wrong kind", async () => {
      const { response, read } = await reject({
        kind: "pull_request",
        owner: "o",
        repo: "r",
        number: 1,
        name_only: true,
      });
      expect(response.content[0]!.text).toContain("The name_only option is only valid for: diff");
      expect(response.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
    it("rejects a line range on a kind that is not a file", async () => {
      const { response, read } = await reject({
        kind: "issue",
        owner: "o",
        repo: "r",
        number: 1,
        offset: 1,
      });
      expect(response.content[0]!.text).toContain("The offset option is only valid for: file");
      expect(response.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
    it("rejects a missing required number", async () => {
      const { response, read } = await reject({ kind: "pull_request", owner: "o", repo: "r" });
      expect(response.content[0]!.text).toContain("A number is required for the pull_request kind");
      expect(response.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe("failure reporting", () => {
    interface ToolResult {
      content: Array<{ text: string }>;
      isError?: boolean;
    }
    const failingClient = () =>
      createGitHubResearchClient(
        "t",
        "token-accessible",
        vi.fn().mockRejectedValue(new Error("gh exploded")) as never,
      );
    it("marks a failed search as an error result", async () => {
      const tools = createGitHubResearchTools(
        { scope: "token-accessible", token: "t" },
        failingClient(),
      );
      const response = (await tools[0]!.execute("id", {
        kind: "repositories",
        query: "x",
      } as never)) as ToolResult;
      expect(response.content[0]!.text).toContain("GitHub search unavailable");
      expect(response.isError).toBe(true);
    });
    it("marks a failed read as an error result", async () => {
      const tools = createGitHubResearchTools(
        { scope: "token-accessible", token: "t" },
        failingClient(),
      );
      const response = (await tools[1]!.execute("id", {
        kind: "pull_request",
        owner: "o",
        repo: "r",
        number: 1,
      } as never)) as ToolResult;
      expect(response.content[0]!.text).toContain("GitHub read unavailable");
      expect(response.isError).toBe(true);
    });
    it("marks a failed grep as an error result", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-grep-error-test-"));
      const tools = createGitHubResearchTools(
        { scope: "token-accessible", token: "t" },
        failingClient(),
        { cacheDir: dir },
      );
      const response = (await tools[2]!.execute("id", { pattern: "a" } as never)) as ToolResult;
      expect(response.content[0]!.text).toContain("GitHub grep unavailable");
      expect(response.isError).toBe(true);
      await rm(dir, { recursive: true, force: true });
    });
    it("marks usage errors as error results", async () => {
      const read = vi.fn().mockResolvedValue({});
      const tools = createGitHubResearchTools({ scope: "token-accessible", token: "t" }, {
        read,
        search: vi.fn(),
      } as unknown as GitHubResearchClient);
      const wrongKind = (await tools[1]!.execute("id", {
        kind: "status",
        owner: "o",
        repo: "r",
      } as never)) as ToolResult;
      expect(wrongKind.content[0]!.text).toContain("Read kind must be one of: file");
      expect(wrongKind.isError).toBe(true);
      expect(read).not.toHaveBeenCalled();
      const wrongRef = (await tools[1]!.execute("id", {
        kind: "repository",
        owner: "o",
        repo: "r",
        ref: "main",
      } as never)) as ToolResult;
      expect(wrongRef.content[0]!.text).toContain(
        "ref is only valid for file reads; use kind=file with ref",
      );
      expect(wrongRef.isError).toBe(true);
      const obsoleteOption = (await tools[1]!.execute("id", {
        kind: "file",
        owner: "o",
        repo: "r",
        path: "a.md",
        branch: "main",
      } as never)) as ToolResult;
      expect(obsoleteOption.content[0]!.text).toContain("Unknown read option: branch");
      expect(obsoleteOption.isError).toBe(true);
    });
    it("does not mark a successful read as an error", async () => {
      const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ number: 1, title: "t" }) });
      const tools = createGitHubResearchTools(
        { scope: "token-accessible", token: "t" },
        createGitHubResearchClient("t", "token-accessible", run as never),
      );
      const response = (await tools[1]!.execute("id", {
        kind: "pull_request",
        owner: "o",
        repo: "r",
        number: 1,
      } as never)) as ToolResult;
      expect(response.isError).toBeFalsy();
    });
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
      await createGitHubResearchClient("t", "token-accessible", run as never).search(
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
    await createGitHubResearchClient("t", "token-accessible", run as never).search(
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
    await createGitHubResearchClient("t", "token-accessible", repoRun as never).search(
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
    await createGitHubResearchClient("t", "token-accessible", codeRun as never).search(
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
      await createGitHubResearchClient("t", "token-accessible", run as never).search(
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
  // Defensive compatibility coverage: the transport accepts a nonzero exit
  // that still carries stdout, so a run that reports its outcome that way is
  // read rather than lost. The captured CLI exits 0 for the JSON form and
  // nonzero for the log form; both are covered by the contract fixtures.
  it("parses failed run JSON when only exit-status is requested", async () => {
    const run = vi.fn().mockRejectedValue(
      Object.assign(new Error("run failed"), {
        code: 1,
        stdout: JSON.stringify({ databaseId: 12, conclusion: "failure", status: "completed" }),
      }),
    );
    const result = await createGitHubResearchClient("t", "token-accessible", run as never).read({
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
      forPr([{ body: "c".repeat(5 * 1024) }]) as never,
    ).read({ kind: "pull_request", owner: "o", repo: "r", number: 8, comments: true });
    expect((arrayResult.pull_request as { comments: string }).comments).toContain("[truncated]");
    const run = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("failed"), { code: 1, stdout: "x".repeat(5 * 1024) }),
      );
    const log = await createGitHubResearchClient("t", "token-accessible", run as never).read({
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
    await createGitHubResearchClient("t", "token-accessible", nameOnly as never).read({
      kind: "diff",
      owner: "o",
      repo: "r",
      number: 3,
      name_only: true,
    });
    expect(nameOnly.mock.calls[0]![1]).toEqual(["pr", "diff", "3", "--repo", "o/r", "--name-only"]);
    const repository = vi.fn().mockResolvedValue({ stdout: "{}" });
    await createGitHubResearchClient("t", "token-accessible", repository as never).read({
      kind: "repository",
      owner: "o",
      repo: "r",
    });
    expect(repository.mock.calls[0]![1]).toEqual([
      "repo",
      "view",
      "o/r",
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
    const result = await createGitHubResearchClient("t", "public", run as never).search(
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
        stdout: JSON.stringify({
          isPrivate: false,
          nameWithOwner: "org/repo",
          url: "https://github.com/org/repo",
        }),
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ name: "Build nightly" }]) });
    const result = await createGitHubResearchClient("t", "public", run as never).search(
      "runs",
      "build",
      5,
    );
    expect(result.results).toEqual([{ name: "Build nightly" }]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![1]).toEqual([
      "repo",
      "view",
      "--json",
      "isPrivate,nameWithOwner,url",
    ]);
    expect(run.mock.calls[1]![1]).not.toContain("--repo");
  });
  it("does not add a repo privacy request for token-accessible local searches", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ name: "Build nightly" }]) });
    await createGitHubResearchClient("t", "token-accessible", run as never).search(
      "runs",
      "build",
      5,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(["run", "list", "--limit", "5"]));
  });
  it("uses only valid gh search code JSON fields", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify([{ path: "src/a.ts" }]) });
    await createGitHubResearchClient("t", "token-accessible", run as never).search(
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
      createGitHubResearchClient("t", "public", run as never).search("workflows", "deploy", 5),
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
      const result = await createGitHubResearchClient("t", "token-accessible", run as never).search(
        kind,
        query,
        5,
      );
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
        ["api", "repos/o/r/releases/13", "--jq", RELEASE_JQ_EXPRESSION],
      ],
      [{ kind: "diff", owner: "o", repo: "r", number: 14 }, ["pr", "diff", "14", "--repo", "o/r"]],
      [
        { kind: "checks", owner: "o", repo: "r", number: 15 },
        ["pr", "checks", "15", "--repo", "o/r", "--json", "name,state,workflow"],
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
      const result = await createGitHubResearchClient("t", "token-accessible", run as never).read(
        params as never,
      );
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
    const result = await createGitHubResearchClient("t", "token-accessible", run as never).read({
      kind: "file",
      owner: "o",
      repo: "r",
      path: "src/answer.ts",
      ref: "main",
    });
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
    const result = await createGitHubResearchClient("t", "token-accessible", run as never).read({
      kind: "release",
      owner: "o",
      repo: "r",
      number: 1,
    });
    expect(run.mock.calls[0]![1]).toEqual([
      "api",
      "repos/o/r/releases/1",
      "--jq",
      RELEASE_JQ_EXPRESSION,
    ]);
    expect(result.result).toMatchObject({ isDraft: true, publishedAt: null });
  });

  it("delivers the release notes with the release, and says when they are truncated", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        tagName: "v2.0.0",
        name: "Breaking release",
        isDraft: false,
        url: "https://github.com/o/r/releases/2",
        publishedAt: "2026-10-20T04:13:50Z",
        body: "## Breaking\n- the removed API",
        bodyTruncated: false,
      }),
    });
    const result = await createGitHubResearchClient("t", "token-accessible", run as never).read({
      kind: "release",
      owner: "o",
      repo: "r",
      number: 2,
    });
    expect(result.result).toMatchObject({
      body: "## Breaking\n- the removed API",
      bodyTruncated: false,
    });
  });

  it("keeps the release search metadata-only", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ name: "October release", tagName: "v2.1" }]),
    });
    await createGitHubResearchClient("t", "token-accessible", run as never).search(
      "releases",
      "October",
      5,
    );
    const argv = run.mock.calls[0]![1] as string[];
    expect(argv).toContain("release");
    expect(argv).toContain("list");
    // The search lists the releases it finds; it never carries the notes,
    // because `gh release list` has no field for them.
    expect(argv.join(" ")).not.toContain("body");
  });

  it("keeps the projected release inside the transport's per-result cap", () => {
    // The bound is applied inside the projection, so the projected result is
    // what the transport receives. A character costs up to six bytes once
    // JSON escapes it, and the release's metadata takes the rest of the room.
    // The structure is measured, not assumed: it is the projection with
    // every value empty.
    const structure = Buffer.byteLength(
      '{"body":"","bodyTruncated":false,"isDraft":false,"name":null,"publishedAt":null,"tagName":null,"url":null}',
    );
    expect((MAX_RELEASE_BODY_CHARS + RELEASE_METADATA_CHARS) * 6 + structure).toBeLessThanOrEqual(
      MAX_GH_RESULT_BYTES,
    );
  });

  it("sends the release projection the allowlist accepts", () => {
    const run = vi.fn().mockResolvedValue({ stdout: "{}" });
    const client = createGitHubResearchClient("t", "token-accessible", run as never);
    return client.read({ kind: "release", owner: "o", repo: "r", number: 1 }).then(() => {
      const argv = run.mock.calls[0]![1] as string[];
      expect(validateGhArgs(argv)).toBeUndefined();
      const expression = argv[argv.indexOf("--jq") + 1]!;
      expect(expression).toBe(RELEASE_JQ_EXPRESSION);
      // Every field the projection carries is bounded, so the worst case
      // fits the transport's cap.
      expect(expression).toContain(`[0:${MAX_RELEASE_BODY_CHARS}]`);
      expect(expression).toContain(`[0:${MAX_RELEASE_TAG_CHARS}]`);
      expect(expression).toContain(`[0:${MAX_RELEASE_NAME_CHARS}]`);
      expect(expression).toContain(`[0:${MAX_RELEASE_URL_CHARS}]`);
      expect(expression).toContain(`[0:${MAX_RELEASE_PUBLISHED_CHARS}]`);
    });
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
      const result = await createGitHubResearchClient("t", "token-accessible", run as never).read({
        kind: "file",
        owner: "o",
        repo: "r",
        path: "docs/notes.md",
      });
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
    const client = createGitHubResearchClient("t", "token-accessible", run as never);
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

  it("rejects out-of-range limits and attempt numbers", async () => {
    const client = createGitHubResearchClient("t", "token-accessible");
    await expect(
      client.read({ kind: "file", owner: "o", repo: "r", path: "a.md", limit: 201 }),
    ).rejects.toThrow("range is invalid");
    await expect(
      client.read({ kind: "run", owner: "o", repo: "r", number: 1, attempt: 0 }),
    ).rejects.toThrow("attempt is invalid");
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
    const client = createGitHubResearchClient("t", "token-accessible", run as never);
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
    const client = createGitHubResearchClient("t", "token-accessible", run as never);
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
