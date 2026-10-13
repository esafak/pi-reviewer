import { describe, expect, it, vi } from "vite-plus/test";

import { applySummaryRegeneration } from "../../src/ci/summary-command.js";

function fakeGithub(overrides: Record<string, unknown> = {}) {
  return {
    getPullRequest: vi.fn().mockResolvedValue({ head: { sha: "head-sha" } }),
    getReview: vi.fn().mockResolvedValue({ body: "old body" }),
    updateReview: vi.fn().mockResolvedValue({}),
    updateIssueComment: vi.fn().mockResolvedValue({}),
    request: vi.fn().mockResolvedValue({ body: "old body" }),
    ...overrides,
  };
}

const base = {
  repo: "owner/repo",
  prNumber: 42,
  headSha: "head-sha",
  overview: { pr_summary: "What: x. Why: y. Risks: z.", pr_diagram: "flowchart TD\nA-->B" },
  rangeLabel: "base111..head333",
};

describe("applySummaryRegeneration", () => {
  it("returns no-overview without touching the API", async () => {
    const github = fakeGithub();
    const outcome = await applySummaryRegeneration({
      ...base,
      github,
      target: { kind: "review", reviewId: 7 },
      overview: {},
    });
    expect(outcome).toBe("no-overview");
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.updateReview).not.toHaveBeenCalled();
  });

  it("skips the mutation when the head moved during generation", async () => {
    const github = fakeGithub({
      getPullRequest: vi.fn().mockResolvedValue({ head: { sha: "other-sha" } }),
    });
    const outcome = await applySummaryRegeneration({
      ...base,
      github,
      target: { kind: "review", reviewId: 7 },
    });
    expect(outcome).toBe("head-changed");
    expect(github.getReview).not.toHaveBeenCalled();
    expect(github.updateReview).not.toHaveBeenCalled();
    expect(github.updateIssueComment).not.toHaveBeenCalled();
  });

  it("replaces the block in a review body with a recomputed label", async () => {
    const marker = '<!-- pi-reviewer:batch:v1 {"version":1} -->';
    const github = fakeGithub({
      getReview: vi.fn().mockResolvedValue({
        body: `${marker}\n\nFindings prose\n\n<details>\n<summary>Summary · old111..old222</summary>\n\nStale\n\n</details>`,
      }),
    });
    const outcome = await applySummaryRegeneration({
      ...base,
      github,
      target: { kind: "review", reviewId: 7 },
    });
    expect(outcome).toBe("updated");
    expect(github.updateReview).toHaveBeenCalledWith("owner/repo", 42, 7, expect.any(String));
    const updated = github.updateReview.mock.calls[0][3] as string;
    expect(updated).toContain(marker);
    expect(updated).toContain("Findings prose");
    expect(updated).toContain("<summary>Summary · base111..head333</summary>");
    expect(updated).toContain("What: x. Why: y. Risks: z.");
    expect(updated).not.toContain("Stale");
    expect(updated).not.toContain("old111..old222");
  });

  it("updates issue-comment bodies through the issue-comment path", async () => {
    const github = fakeGithub({
      request: vi.fn().mockResolvedValue({ body: "Fallback prose" }),
    });
    const outcome = await applySummaryRegeneration({
      ...base,
      github,
      target: { kind: "issue", issueCommentId: 99 },
      overview: { pr_summary: "Fresh overview" },
    });
    expect(outcome).toBe("updated");
    expect(github.updateReview).not.toHaveBeenCalled();
    expect(github.updateIssueComment).toHaveBeenCalledWith(
      "owner/repo",
      42,
      99,
      expect.any(String),
    );
    const updated = github.updateIssueComment.mock.calls[0][3] as string;
    expect(updated).toContain("<details>");
    expect(updated).toContain("Fresh overview");
    expect(updated).toContain("Fallback prose");
  });
});
