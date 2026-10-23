import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { renderDependencySummary, runDependencyCheck } from "../../src/ci/dependency-check.js";
import { resolveUpstreams } from "../../src/ci/dependency/resolve.js";
import { review, type ReviewOutcome } from "../../src/ci/review.js";
import { encodeBatchMarker } from "../../src/ci/batch.js";
import { gitEnv } from "../../src/core/git-env.js";
import type { UpgradeResearch } from "../../src/ci/dependency/resolve.js";

vi.mock("../../src/ci/review.js", () => ({ review: vi.fn() }));
vi.mock("../../src/ci/dependency/resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ci/dependency/resolve.js")>();
  return { ...actual, resolveUpstreams: vi.fn() };
});

const reviewMock = vi.mocked(review);
const resolveMock = vi.mocked(resolveUpstreams);

/** A published outcome carrying the dispositions and findings a test wants. */
function published(
  research: UpgradeResearch[] = [],
  findings: Array<{ severity: "CRITICAL" | "WARN" | "INFO"; body: string }> = [],
): ReviewOutcome {
  return {
    kind: "published",
    decision: {
      action: "review",
      result: { summary: "Analyzed.", comments: [], research },
    },
    findings: findings.map((finding) => ({ ...finding })),
    diff: "",
  };
}

describe("runDependencyCheck", () => {
  let dir: string;

  // Hooks export GIT_DIR/GIT_WORK_TREE; gitEnv() strips them, so every git
  // invocation here can only reach this fixture and never the developer's
  // repository (or the one a pre-push hook is running from).
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });
  const commit = (message: string) =>
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", message]);
  const write = async (file: string, text: string) => {
    await writeFile(path.join(dir, file), text, "utf-8");
    git(["add", file]);
  };
  const rev = (ref: string) =>
    execFileSync("git", ["rev-parse", ref], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();

  /** Commits `before`, then `after`, and returns the two revisions. */
  const range = async (file: string, before: string, after: string) => {
    await write(file, before);
    commit("before");
    const from = rev("HEAD");
    await write(file, after);
    commit("after");
    return { from, to: rev("HEAD") };
  };

  const options = (from: string, to: string) => ({
    repoCwd: dir,
    mergeBase: from,
    headSha: to,
    prNumber: 42,
    batchMarker: encodeBatchMarker({
      mode: "dependency",
      fromSha: from,
      toSha: to,
      kind: "opened",
      actor: "bot",
      reviewId: 0,
    }),
    review: {
      cwd: dir,
      output: "comment" as const,
      repo: "owner/repo",
      githubToken: "token",
    },
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-check-"));
    git(["init"]);
    reviewMock.mockReset();
    resolveMock.mockReset();
    reviewMock.mockResolvedValue(published());
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({ id, candidates: [] })),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a passing check without calling the model when nothing qualifying changed", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.1.0" } }),
      JSON.stringify({ dependencies: { react: "^18.2.0" } }),
    );

    const result = await runDependencyCheck(options(from, to));

    expect(reviewMock).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("No breaking-relevant upgrade was found");
    expect(result.summary).toContain("a library minor change, below the threshold");
  });

  it("analyses a major bump and hands the profile and anchors to the review", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({
        id,
        candidates: [{ id: `${id}-1`, via: "registry-metadata" as const, repo: "facebook/react" }],
      })),
    );
    reviewMock.mockResolvedValue(
      published([{ id: "placeholder", status: "researched", source: "local:CHANGELOG.md" }]),
    );

    const result = await runDependencyCheck(options(from, to));

    expect(reviewMock).toHaveBeenCalledTimes(1);
    const call = reviewMock.mock.calls[0]![0];
    expect(call.profile).toMatchObject({ kind: "dependency" });
    expect(call.commitId).toBe(to);
    expect(call.fromSha).toBe(from);
    expect(call.batchMarker).toContain('"mode":"dependency"');
    // The anchor is the line the constraint changed on, read from the diff.
    expect(call.dependencyAnchors?.[0]).toMatchObject({ manifest: "package.json", line: 1 });
    expect(result.summary).toContain("### Upgrades analyzed");
  });

  it("analyses a tool minor bump", async () => {
    const { from, to } = await range(
      "mise.toml",
      '[tools]\npython = "3.11"\n',
      '[tools]\npython = "3.12"\n',
    );

    await runDependencyCheck(options(from, to));

    // A runtime breaks across minor versions, so the threshold is the tool's,
    // not the library's.
    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(reviewMock.mock.calls[0]![0].profile).toMatchObject({
      changes: [expect.objectContaining({ name: "python", category: "tool", kind: "minor" })],
    });
  });

  it("analyses a pre-1.0 minor bump of a library", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^0.14.0" } }),
      JSON.stringify({ dependencies: { react: "^0.15.0" } }),
    );

    await runDependencyCheck(options(from, to));

    const call = reviewMock.mock.calls[0]![0];
    expect(call.profile).toMatchObject({ kind: "dependency" });
    expect(call.profile).toMatchObject({
      changes: [expect.objectContaining({ name: "react", kind: "pre-1.0-minor" })],
    });
  });

  it("names an unsupported manifest instead of silently ignoring it", async () => {
    const { from, to } = await range(
      "Podfile",
      "pod 'Alamofire', '~> 5.0'",
      "pod 'Alamofire', '~> 6.0'",
    );

    const result = await runDependencyCheck(options(from, to));

    expect(reviewMock).not.toHaveBeenCalled();
    expect(result.summary).toContain("### Unsupported manifests");
    expect(result.summary).toContain("`Podfile`");
  });

  it("keeps an unreachable upgrade unverifiable even when the model says it researched it", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({ id, candidates: [], unresolved: "the registry named no source" })),
    );
    // The review reports a disposition for the real upgrade id, and the
    // summary is built from that decision.
    reviewMock.mockImplementation(async () => {
      const realId = resolveMock.mock.calls[0]?.[1]?.[0] ?? "";
      return published([{ id: realId, status: "researched", source: "local:CHANGELOG.md" }]);
    });

    const result = await runDependencyCheck(options(from, to));

    expect(result.summary).toContain("Unverifiable: 1");
    expect(result.summary).toContain("the registry named no source");
  });

  it("publishes the findings the review published", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    reviewMock.mockResolvedValue(
      published(
        [],
        [{ severity: "CRITICAL", body: "React 19 removed an API this repository calls." }],
      ),
    );

    const result = await runDependencyCheck(options(from, to));

    expect(result.findings).toEqual([
      { severity: "CRITICAL", body: "React 19 removed an API this repository calls." },
    ]);
  });

  it("publishes an accepted local citation as a path in the checkout, not a verified source", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({
        id,
        candidates: [{ id: `${id}-1`, via: "registry-metadata" as const, repo: "facebook/react" }],
      })),
    );
    reviewMock.mockImplementation(async () => {
      const realId = resolveMock.mock.calls[0]?.[1]?.[0] ?? "";
      return published([{ id: realId, status: "researched", source: "local:docs/CHANGELOG.md" }]);
    });

    const result = await runDependencyCheck(options(from, to));

    expect(result.summary).toContain("researched via `docs/CHANGELOG.md`");
    expect(result.summary).toContain("a path in the checkout; the harness did not open it");
  });

  it("publishes a candidate citation by the id the harness resolved", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({
        id,
        candidates: [{ id: `${id}-1`, via: "registry-metadata" as const, repo: "facebook/react" }],
      })),
    );
    reviewMock.mockImplementation(async () => {
      const realId = resolveMock.mock.calls[0]?.[1]?.[0] ?? "";
      return published([{ id: realId, status: "researched", source: `candidate:${realId}-1` }]);
    });

    const result = await runDependencyCheck(options(from, to));

    expect(result.summary).toContain("researched via candidate");
    expect(result.summary).toContain("`u-");
    expect(result.summary).toContain("-1`");
  });

  it("reports the reason the model gave for an upgrade it could not verify", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({
        id,
        candidates: [{ id: `${id}-1`, via: "registry-metadata" as const, repo: "facebook/react" }],
      })),
    );
    reviewMock.mockImplementation(async () => {
      const realId = resolveMock.mock.calls[0]?.[1]?.[0] ?? "";
      return published([
        { id: realId, status: "unverified", reason: "the release notes listed no removals" },
      ]);
    });

    const result = await runDependencyCheck(options(from, to));

    expect(result.summary).toContain("Unverifiable: 1");
    expect(result.summary).toContain("the release notes listed no removals");
  });

  it("never publishes a credential-shaped value the model reported", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({
        id,
        candidates: [{ id: `${id}-1`, via: "registry-metadata" as const, repo: "facebook/react" }],
      })),
    );
    reviewMock.mockImplementation(async () => {
      const realId = resolveMock.mock.calls[0]?.[1]?.[0] ?? "";
      return published([
        {
          id: realId,
          status: "unverified",
          reason: "the notes showed AKIAIOSFODNN7EXAMPLE",
        },
      ]);
    });

    const result = await runDependencyCheck(options(from, to));

    expect(result.summary).toContain("withheld: the text carried a credential-shaped value");
    expect(result.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("names a disposition the harness discarded", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    );
    resolveMock.mockImplementation(async (_changes, ids) =>
      ids.map((id) => ({
        id,
        candidates: [{ id: `${id}-1`, via: "manifest" as const, repo: "facebook/react" }],
      })),
    );
    reviewMock.mockResolvedValue(
      published([{ id: "u-not-an-upgrade", status: "unverified", reason: "no time" }]),
    );

    const result = await runDependencyCheck(options(from, to));

    expect(result.summary).toContain("### Dispositions the harness did not accept");
    expect(result.summary).toContain("u-not-an-upgrade");
    expect(result.summary).toContain("did not account for this upgrade");
  });

  it("fails rather than reporting success over a range it could not read", async () => {
    await write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    commit("before");

    await expect(runDependencyCheck(options("not-a-revision", rev("HEAD")))).rejects.toThrow(
      /could not read the range/,
    );
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it("keeps the model out of the loop when no upgrade qualifies, and still names coverage", async () => {
    const { from, to } = await range(
      "package.json",
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      JSON.stringify({ dependencies: { react: "^18.0.1" } }),
    );

    const result = await runDependencyCheck(options(from, to));

    expect(reviewMock).not.toHaveBeenCalled();
    expect(result.summary).toContain("a patch change, below the threshold");
  });
});

describe("renderDependencySummary", () => {
  it("states what researched means and why an upgrade was left out", () => {
    const summary = renderDependencySummary({
      detection: { changes: [], unsupported: [], warnings: [] },
      analyzed: [],
      skipped: [],
      accounting: { accounts: [], diagnostics: [] },
      omitted: 2,
    });

    expect(summary).toContain("Reported researched: 0. Unverifiable: 0.");
    // The check run is where branch protection looks; the guarantee has to be
    // on that surface, not only in the review body and the docs.
    expect(summary).toContain("*Researched* is the model's claim");
    expect(summary).toContain("did not carry 2 upgrades");
  });
});
