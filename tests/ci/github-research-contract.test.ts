import { describe, expect, it, vi } from "vite-plus/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubResearchClient } from "../../src/ci/github-research/client.js";
import { MAX_GH_FILE_BYTES, MAX_GH_RESULT_BYTES } from "../../src/ci/github-research/gh-runner.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "github-research",
);
interface ManifestEntry {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  capturedAt: string;
}
const manifest = JSON.parse(readFileSync(path.join(fixtureDir, "manifest.json"), "utf8")) as Record<
  string,
  ManifestEntry
>;
const fixture = (name: string) => {
  const entry = manifest[name]!;
  return { ...entry, output: readFileSync(path.join(fixtureDir, entry.stdout), "utf8") };
};

/**
 * The key a client command maps to, so a recorded capture can answer it.
 * The capture and the client build the same command shape; only the
 * repository, the number, and the path differ.
 */
const commandKey = (args: string[]): string => {
  const [group, command] = args;
  const fields = args.at(-1) ?? "";
  if (group === "api") {
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/discussions/")) return "api discussion";
    if (endpoint.includes("/actions/workflows/")) return "api workflow";
    if (endpoint.includes("/releases/")) return "api release";
    if (endpoint.includes("/contents/")) return "api contents";
    return "api other";
  }
  if (group === "pr" && command === "view")
    return fields.includes("comments") ? "pr view comments" : "pr view";
  if (group === "pr" && command === "diff")
    return args.includes("--name-only") ? "pr diff names" : "pr diff";
  if (group === "pr" && command === "checks") return "pr checks";
  if (group === "issue" && command === "view")
    return fields.includes("comments") ? "issue view comments" : "issue view";
  if (group === "run" && command === "view") {
    if (args.includes("--log")) return args.includes("--exit-status") ? "run log exit" : "run log";
    return args.includes("--exit-status") ? "run exit" : "run view";
  }
  if (group === "repo" && command === "view") return "repo view";
  return `${group} ${command}`;
};

interface Replay {
  stdout: string;
  stderr: string;
  exitCode: number;
}
const clientWith = (replay: (args: string[]) => Replay) => {
  const run = vi.fn(async (_cmd: string, args: string[]) => {
    const result = replay(args);
    if (result.exitCode !== 0)
      throw Object.assign(new Error(`Command failed: gh ${args.join(" ")}`), {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    return { stdout: result.stdout };
  });
  return createGitHubResearchClient("t", "token-accessible", run as never);
};
/** A client that answers each command with its recorded capture. */
const recorded = (byKey: Record<string, string>) =>
  clientWith((args) => {
    const name = byKey[commandKey(args)];
    if (!name) throw new Error(`No capture for ${commandKey(args)}`);
    const entry = fixture(name);
    return { stdout: entry.output, stderr: entry.stderr, exitCode: entry.exitCode };
  });

type Json = Record<string, unknown>;
const asJson = (value: unknown): Json => value as Json;

describe("GitHub research payload contracts", () => {
  // Each case reads a recorded capture through the real client and asserts
  // the shape it returns. The values are the tool's own; the assertions are
  // about the shape, never about the content.
  const cases: Array<{
    label: string;
    capture: string;
    key: string;
    read: Record<string, unknown>;
    envelope: string | null;
    assertions: (result: Json) => void;
  }> = [
    {
      label: "pull_request",
      capture: "pr-view",
      key: "pr view",
      read: { kind: "pull_request", owner: "o", repo: "r", number: 169 },
      envelope: "pull_request",
      assertions: (result) => {
        const pr = asJson(result.pull_request);
        expect(typeof pr.number).toBe("number");
        expect(typeof pr.title).toBe("string");
        expect(typeof pr.state).toBe("string");
        expect(typeof pr.headRefName).toBe("string");
      },
    },
    {
      label: "pull_request with comments",
      capture: "pr-view-comments",
      key: "pr view comments",
      read: { kind: "pull_request", owner: "o", repo: "r", number: 169, comments: true },
      envelope: "pull_request",
      assertions: (result) => {
        const pr = asJson(result.pull_request);
        // The comments arrive as the JSON text of the array, bounded to the
        // model-facing budget.
        expect(typeof pr.comments).toBe("string");
        const comments = JSON.parse(String(pr.comments)) as unknown[];
        expect(comments.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(String(pr.comments))).toBeLessThanOrEqual(4 * 1024);
      },
    },
    {
      label: "issue",
      capture: "issue-view",
      key: "issue view",
      read: { kind: "issue", owner: "o", repo: "r", number: 4 },
      envelope: "issue",
      assertions: (result) => {
        const issue = asJson(result.issue);
        expect(typeof issue.number).toBe("number");
        expect(typeof issue.title).toBe("string");
        expect(typeof issue.state).toBe("string");
      },
    },
    {
      label: "issue with comments",
      capture: "issue-view-comments",
      key: "issue view comments",
      read: { kind: "issue", owner: "o", repo: "r", number: 4, comments: true },
      envelope: "issue",
      assertions: (result) => {
        const issue = asJson(result.issue);
        // The scenario is an issue with no comments: the field is present as
        // the text of an empty array, not missing.
        expect(typeof issue.comments).toBe("string");
        expect(JSON.parse(String(issue.comments))).toEqual([]);
      },
    },
    {
      label: "discussion",
      capture: "discussion",
      key: "api discussion",
      read: { kind: "discussion", owner: "o", repo: "r", number: 2618 },
      envelope: "discussion",
      assertions: (result) => {
        const discussion = asJson(result.discussion);
        expect(typeof discussion.number).toBe("number");
        expect(typeof discussion.title).toBe("string");
        expect(typeof discussion.category).toBe("string");
        // The projection is `user:.user.login`, so the user is a string.
        expect(typeof discussion.user).toBe("string");
      },
    },
    {
      label: "run",
      capture: "run-view",
      key: "run view",
      read: { kind: "run", owner: "o", repo: "r", number: 39367612741 },
      envelope: "result",
      assertions: (result) => {
        const run = asJson(result.result);
        expect(typeof run.conclusion).toBe("string");
        expect(typeof run.status).toBe("string");
        expect(typeof run.databaseId).toBe("number");
      },
    },
    {
      label: "run log",
      capture: "run-log",
      key: "run log",
      read: { kind: "run", owner: "o", repo: "r", number: 39367612741, log: true },
      envelope: "result",
      assertions: (result) => {
        // A log is plain text, not JSON, and it is truncated to the budget.
        expect(typeof result.result).toBe("string");
        expect(result.result).toContain("[truncated]");
        expect(Buffer.byteLength(String(result.result))).toBeLessThanOrEqual(4 * 1024);
      },
    },
    {
      label: "run with exit status",
      capture: "run-exit-status",
      key: "run exit",
      read: { kind: "run", owner: "o", repo: "r", number: 39367612741, exit_status: true },
      envelope: "result",
      assertions: (result) => {
        // The JSON form carries the outcome; the command still exits 0.
        const run = asJson(result.result);
        expect(run.conclusion).toBe("failure");
      },
    },
    {
      label: "workflow",
      capture: "workflow",
      key: "api workflow",
      read: { kind: "workflow", owner: "o", repo: "r", number: 347788971 },
      envelope: "result",
      assertions: (result) => {
        const workflow = asJson(result.result);
        expect(typeof workflow.id).toBe("number");
        expect(typeof workflow.state).toBe("string");
        expect(typeof workflow.path).toBe("string");
      },
    },
    {
      label: "release",
      capture: "release",
      key: "api release",
      read: { kind: "release", owner: "o", repo: "r", number: 1 },
      envelope: "result",
      assertions: (result) => {
        const release = asJson(result.result);
        expect(typeof release.tagName).toBe("string");
        expect(typeof release.isDraft).toBe("boolean");
        expect(typeof release.publishedAt).toBe("string");
      },
    },
    {
      label: "repository",
      capture: "repo-view",
      key: "repo view",
      read: { kind: "repository", owner: "o", repo: "r" },
      envelope: "result",
      assertions: (result) => {
        const repository = asJson(result.result);
        expect(typeof repository.nameWithOwner).toBe("string");
        expect(typeof repository.visibility).toBe("string");
        expect(typeof asJson(repository.defaultBranchRef).name).toBe("string");
      },
    },
    {
      label: "diff",
      capture: "pr-diff",
      key: "pr diff",
      read: { kind: "diff", owner: "o", repo: "r", number: 169 },
      envelope: "result",
      assertions: (result) => {
        // A diff is plain text, and it is bounded to the model-facing budget.
        expect(typeof result.result).toBe("string");
        expect(String(result.result)).toContain("diff --git");
        expect(String(result.result)).toContain("[truncated]");
        expect(Buffer.byteLength(String(result.result))).toBeLessThanOrEqual(4 * 1024);
      },
    },
    {
      label: "diff with names only",
      capture: "pr-diff-names",
      key: "pr diff names",
      read: { kind: "diff", owner: "o", repo: "r", number: 169, name_only: true },
      envelope: "result",
      assertions: (result) => {
        expect(typeof result.result).toBe("string");
        for (const line of String(result.result).split("\n").filter(Boolean))
          expect(line).not.toContain("diff --git");
      },
    },
    {
      label: "checks",
      capture: "pr-checks",
      key: "pr checks",
      read: { kind: "checks", owner: "o", repo: "r", number: 169 },
      envelope: "result",
      assertions: (result) => {
        const checks = result.result as Array<Json>;
        expect(Array.isArray(checks)).toBe(true);
        expect(checks.length).toBeGreaterThan(0);
        for (const check of checks) {
          expect(typeof check.name).toBe("string");
          expect(typeof check.state).toBe("string");
          expect(typeof check.workflow).toBe("string");
        }
      },
    },
  ];
  for (const testCase of cases) {
    it(`${testCase.label} keeps the shape of the recorded response`, async () => {
      const client = recorded({ [testCase.key]: testCase.capture });
      const result = asJson(await client.read(testCase.read as never));
      expect(result.kind).toBe(testCase.read.kind);
      expect(result.repository).toBe("o/r");
      expect(testCase.envelope).not.toBeNull();
      expect(result[testCase.envelope!]).toBeDefined();
      testCase.assertions(result);
    });
  }

  it("records every capture as the command that was run", () => {
    // The manifest is the provenance of the fixtures: a capture that is not
    // reproducible from its own argv is not a capture.
    for (const [name, entry] of Object.entries(manifest)) {
      expect(entry.argv[0], `${name} argv`).toBe("gh");
      expect(entry.argv[1], `${name} argv`).not.toBe("gh");
      expect(entry.argv.length, `${name} argv`).toBeGreaterThan(1);
      expect(existsSync(path.join(fixtureDir, entry.stdout)), `${name} stdout`).toBe(true);
      expect(entry.capturedAt, `${name} capturedAt`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // The one capture that exits nonzero is the one that really does.
    expect(manifest["run-log-exit-status"]?.exitCode).toBe(1);
    expect(manifest["run-exit-status"]?.exitCode).toBe(0);
  });

  it("spreads the file fields at the top level, with no file envelope", async () => {
    const client = recorded({ "api contents": "file-contents" });
    const result = asJson(
      await client.read({ kind: "file", owner: "o", repo: "r", path: "package.json" }),
    );
    // There is no `file` envelope: the fields sit at the top level.
    expect(result.file).toBeUndefined();
    expect(typeof result.path).toBe("string");
    expect(typeof result.content).toBe("string");
    expect(typeof result.size).toBe("number");
    expect(typeof result.totalLines).toBe("number");
    expect(typeof result.truncated).toBe("boolean");
    // The content arrives decoded, not as the base64 the API returned.
    const captured = JSON.parse(fixture("file-contents").output) as Json;
    const source = Buffer.from(String(captured.content).replace(/\s/gu, ""), "base64").toString(
      "utf8",
    );
    expect(result.content).toBe(source);
  });

  it("returns a ranged slice of the file", async () => {
    const client = recorded({ "api contents": "file-contents" });
    const result = asJson(
      await client.read({
        kind: "file",
        owner: "o",
        repo: "r",
        path: "package.json",
        offset: 2,
        limit: 2,
      }),
    );
    expect(result.offset).toBe(2);
    expect(result.limit).toBe(2);
    expect(typeof result.truncated).toBe("boolean");
    const lines = String(result.content).split("\n");
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("accepts the stdout of a run that exits nonzero", async () => {
    // A log read with exit status is the one combination the transport sees
    // that exits nonzero: the JSON form reports the outcome and exits 0.
    const entry = fixture("run-log-exit-status");
    expect(entry.exitCode).toBe(1);
    const client = clientWith(() => ({
      stdout: entry.output,
      stderr: entry.stderr,
      exitCode: entry.exitCode,
    }));
    const result = asJson(
      await client.read({
        kind: "run",
        owner: "o",
        repo: "r",
        number: 39367612741,
        log: true,
        exit_status: true,
      }),
    );
    expect(typeof result.result).toBe("string");
    expect(result.result).toContain("[truncated]");
  });

  it("fails closed on a malformed base64 body", async () => {
    const client = clientWith(() => ({
      stdout: JSON.stringify({ path: "a.md", url: "u", content: "not base64!!" }),
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      client.read({ kind: "file", owner: "o", repo: "r", path: "a.md" }),
    ).rejects.toThrow("GitHub file content is invalid base64");
  });

  it("fails closed on a body that is not JSON", async () => {
    const client = clientWith(() => ({ stdout: "not json", stderr: "", exitCode: 0 }));
    await expect(
      client.read({ kind: "pull_request", owner: "o", repo: "r", number: 1 }),
    ).rejects.toThrow("gh returned invalid JSON");
  });

  it("fails closed when the download ceiling is exceeded", async () => {
    const client = clientWith(() => ({
      stdout: "x".repeat(MAX_GH_FILE_BYTES + 1),
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      client.read({ kind: "file", owner: "o", repo: "r", path: "big.md" }),
    ).rejects.toThrow("gh output budget exhausted");
  });

  it("fails closed when the framed result exceeds the model-facing ceiling", async () => {
    // A contents response inside the download ceiling whose framed result
    // does not fit the model-facing budget: the escaped preview does.
    const quotes = '"'.repeat(4 * 1024);
    const client = clientWith(() => ({
      stdout: JSON.stringify({
        path: "a.md",
        url: "u",
        content: Buffer.from(quotes).toString("base64"),
      }),
      stderr: "",
      exitCode: 0,
    }));
    await expect(
      client.read({ kind: "file", owner: "o", repo: "r", path: "a.md" }),
    ).rejects.toThrow("GitHub research result exceeded the byte limit");
  });

  it("fails closed when the aggregate ceiling is exceeded", async () => {
    // Each result is inside the per-result budget; together they are not.
    const chunk = JSON.stringify({ body: "x".repeat(MAX_GH_RESULT_BYTES - 200) });
    const client = clientWith(() => ({ stdout: chunk, stderr: "", exitCode: 0 }));
    const read = () => client.read({ kind: "pull_request", owner: "o", repo: "r", number: 1 });
    await read();
    await read();
    await expect(read()).rejects.toThrow("gh output budget exhausted");
  });
});
