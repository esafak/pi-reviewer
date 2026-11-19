import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  blockingFindings,
  describeBlockingFindings,
  hasBlockingFindings,
  listOwnBlockingReviews,
  withdrawBlockingReviews,
  type BlockingReview,
} from "../../src/ci/blocking-review.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function client(reviews: BlockingReview[], login = "review-bot") {
  return {
    getUser: vi.fn(async () => ({ login })),
    listReviews: vi.fn(async () => reviews),
    getPullRequest: vi.fn(async () => ({ head: { sha: "head" } })),
    dismissReview: vi.fn(async () => ({})),
  };
}

describe("blockingFindings", () => {
  it("blocks on a CRITICAL finding posted by the current run", () => {
    expect(blockingFindings([], [{ severity: "CRITICAL" }])).toHaveLength(1);
  });

  it("blocks while an open CRITICAL finding stands", () => {
    expect(hasBlockingFindings([{ severity: "CRITICAL" }], [])).toBe(true);
  });

  it("keeps the block when an open finding's severity is unknown", () => {
    expect(hasBlockingFindings([{}], [])).toBe(true);
  });

  it("does not block once only WARN and INFO findings remain", () => {
    expect(hasBlockingFindings([{ severity: "WARN" }, { severity: "INFO" }], [])).toBe(false);
    expect(hasBlockingFindings([], [{ severity: "WARN" }])).toBe(false);
  });

  it("names what keeps the block standing", () => {
    expect(
      describeBlockingFindings([
        { commentId: 12, severity: "CRITICAL" },
        { commentId: 13 },
        { severity: "CRITICAL" },
      ]),
    ).toBe("#12 CRITICAL, #13 severity unknown, new CRITICAL finding");
  });
});

describe("listOwnBlockingReviews", () => {
  it("returns only the reviewer's own changes-requested reviews", async () => {
    const github = client([
      { id: 1, state: "CHANGES_REQUESTED", user: { login: "review-bot" } },
      { id: 2, state: "COMMENTED", user: { login: "review-bot" } },
      { id: 3, state: "DISMISSED", user: { login: "review-bot" } },
      { id: 4, state: "CHANGES_REQUESTED", user: { login: "human" } },
      { id: 5, state: "CHANGES_REQUESTED", user: { login: "Review-Bot" } },
    ]);

    await expect(
      listOwnBlockingReviews({ client: github, repo: "owner/repo", prNumber: 42 }),
    ).resolves.toEqual([1, 5]);
  });

  it("says when the standing block belongs to someone else", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const github = client([{ id: 4, state: "CHANGES_REQUESTED", user: { login: "human" } }]);

    await expect(
      listOwnBlockingReviews({ client: github, repo: "owner/repo", prNumber: 42 }),
    ).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("raised by human"));
  });

  it("returns undefined when the review state cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = client([]);
    github.getUser.mockRejectedValue(new Error("boom"));

    await expect(
      listOwnBlockingReviews({ client: github, repo: "owner/repo", prNumber: 42 }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not read the PR's"));
  });
});

describe("withdrawBlockingReviews", () => {
  const standing = (...ids: number[]): BlockingReview[] =>
    ids.map((id) => ({ id, state: "CHANGES_REQUESTED", user: { login: "review-bot" } }));

  it("dismisses exactly the reviews it was handed", async () => {
    const github = client(standing(1, 5));

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [1, 5],
        message: "no critical findings remain",
      }),
    ).resolves.toBe(2);
    expect(github.dismissReview.mock.calls).toEqual([
      ["owner/repo", 42, 1, "no critical findings remain"],
      ["owner/repo", 42, 5, "no critical findings remain"],
    ]);
  });

  it("abandons the withdrawal when a block appeared after the snapshot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = client(standing(1, 9));

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [1],
        message: "message",
      }),
    ).resolves.toBe(0);
    expect(github.dismissReview).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("appeared after this run read"));
  });

  it("dismisses only the handed reviews that still stand", async () => {
    const github = client(standing(1));

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [1, 5],
        message: "message",
      }),
    ).resolves.toBe(1);
    expect(github.dismissReview).toHaveBeenCalledTimes(1);
    expect(github.dismissReview).toHaveBeenCalledWith("owner/repo", 42, 1, "message");
  });

  it("does nothing, and reads nothing, without reviews to withdraw", async () => {
    const github = client([]);

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [],
        message: "message",
        expectedHeadSha: "head",
      }),
    ).resolves.toBe(0);
    expect(github.listReviews).not.toHaveBeenCalled();
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(github.dismissReview).not.toHaveBeenCalled();
  });

  it("keeps going when one dismissal fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = client(standing(1, 2));
    github.dismissReview.mockRejectedValueOnce(new Error("403 Resource not accessible"));

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [1, 2],
        message: "message",
      }),
    ).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not withdraw"));
  });

  it("leaves the block standing when the head moved since the findings were read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = client(standing(1));
    github.getPullRequest.mockResolvedValueOnce({ head: { sha: "newer-head" } });

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [1],
        message: "message",
        expectedHeadSha: "head",
      }),
    ).resolves.toBe(0);
    expect(github.dismissReview).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("head changed"));
  });

  it("never fails the caller when the review state cannot be re-read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const github = client(standing(1));
    github.listReviews.mockRejectedValueOnce(new Error("boom"));

    await expect(
      withdrawBlockingReviews({
        client: github,
        repo: "owner/repo",
        prNumber: 42,
        reviewIds: [1],
        message: "message",
      }),
    ).resolves.toBe(0);
    expect(github.dismissReview).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not read the PR's"));
  });
});
