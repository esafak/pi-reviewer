import { describe, expect, it } from "vite-plus/test";
import { decodeBatchMarker, encodeBatchMarker, isAuthorizedReply, isAuthorizedReviewCommand, isEventRangeConsistent, isPiReviewerRootComment, isSafePullRequestNumber, normalizeEvent, replyMarker, decodeReplyMarker, selectAuthenticatedBatchMarkers, selectBatchRange } from "../../src/ci/batch.js";

describe("batch markers", () => {
  it("round trips a versioned authenticated marker", () => {
    const encoded = encodeBatchMarker({ fromSha: "base", toSha: "head", kind: "synchronize", actor: "github-actions[bot]", reviewId: 4 });
    expect(decodeBatchMarker(encoded)).toEqual({ version: 1, fromSha: "base", toSha: "head", kind: "synchronize", actor: "github-actions[bot]", reviewId: 4 });
    expect(decodeBatchMarker("<!-- pi-reviewer:batch:v1 {\"toSha\":\"head\"} -->")).toBeUndefined();
  });
  it("selects the whole PR for adoption and a later push range thereafter", () => {
    expect(selectBatchRange("base", "head")).toEqual({ fromSha: "base", toSha: "head", fresh: true });
    const marker = { version: 1 as const, fromSha: "base", toSha: "old", kind: "opened" as const, actor: "bot", reviewId: 1 };
    expect(selectBatchRange("base", "head", marker, () => true)).toEqual({ fromSha: "old", toSha: "head", fresh: true });
    expect(selectBatchRange("base", "head", marker, () => false)).toEqual({ fromSha: "base", toSha: "head", fresh: true });
  });
  it("rejects unauthorized review commands and spoofed marker actors", () => {
    expect(isAuthorizedReviewCommand(normalizeEvent({ issue: { number: 1, pull_request: {} }, comment: { body: "/pi-review", author_association: "NONE", user: { type: "User" } } }))).toBe(false);
    expect(isAuthorizedReviewCommand(normalizeEvent({ issue: { number: 1, pull_request: {} }, comment: { body: "/pi-review", author_association: "MEMBER", user: { type: "Bot" } } }))).toBe(false);
    const marker = encodeBatchMarker({ fromSha: "a", toSha: "b", kind: "opened", actor: "attacker", reviewId: 1 });
    expect(decodeBatchMarker(marker)?.actor).not.toBe("github-actions[bot]");
    expect(selectAuthenticatedBatchMarkers([
      { id: 1, user: { login: "human" }, body: encodeBatchMarker({ fromSha: "a", toSha: "b", kind: "opened", actor: "github-actions[bot]", reviewId: 1 }) },
      { id: 2, user: { login: "github-actions[bot]" }, body: encodeBatchMarker({ fromSha: "a", toSha: "b", kind: "opened", actor: "github-actions[bot]", reviewId: 2 }) },
    ], "github-actions[bot]").map(m => m.reviewId)).toEqual([2]);
  });
  it("handles coalesced pushes and idempotent reruns", () => {
    const marker = { version: 1 as const, fromSha: "base", toSha: "first", kind: "synchronize" as const, actor: "app[bot]", reviewId: 9 };
    expect(selectBatchRange("base", "third", marker, () => true)).toMatchObject({ fromSha: "first", toSha: "third", fresh: true });
    expect(selectBatchRange("base", "first", marker, () => true)).toEqual({ fromSha: "first", toSha: "first", fresh: false });
    expect(normalizeEvent({ action: "synchronize", before: "first", after: "third", pull_request: { number: 1, head: { sha: "third", repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } } })).toMatchObject({ beforeSha: "first", afterSha: "third" });
  });
  it("keeps the newest marker when finalization left reviewId at zero", () => {
    const reviews = [
      { id: 10, user: { login: "bot" }, body: encodeBatchMarker({ fromSha: "base", toSha: "old", kind: "opened", actor: "bot", reviewId: 10 }) },
      { id: 11, user: { login: "bot" }, body: encodeBatchMarker({ fromSha: "old", toSha: "new", kind: "synchronize", actor: "bot", reviewId: 0 }) },
    ];
    expect(selectAuthenticatedBatchMarkers(reviews, "bot").at(-1)?.toSha).toBe("new");
  });
  it("accepts authenticated markers from issue-comment-shaped sources", () => {
    const marker = encodeBatchMarker({ fromSha: "base", toSha: "new", kind: "synchronize", actor: "bot", reviewId: 0 });
    expect(selectAuthenticatedBatchMarkers([{ id: 99, user: { login: "bot" }, body: marker }], "bot").at(-1)?.toSha).toBe("new");
  });
});

describe("event normalization", () => {
  it("normalizes PR and authorized comment events", () => {
    expect(normalizeEvent({ action: "opened", pull_request: { number: 3, head: { sha: "h", repo: { full_name: "o/f" } }, base: { repo: { full_name: "o/r" } } }, sender: { login: "x", type: "User" } })).toMatchObject({ kind: "opened", pr: 3, headSha: "h", fork: true });
    const event = normalizeEvent({ issue: { number: 3, pull_request: {} }, comment: { body: "/pi-review", author_association: "MEMBER", user: { login: "x", type: "User" } } });
    expect(isAuthorizedReviewCommand(event)).toBe(true);
  });
  it("rejects unsupported actions and checks both event SHAs", () => {
    expect(() => normalizeEvent({ action: "closed", pull_request: { number: 3 } })).toThrow(/Unsupported/);
    const event = normalizeEvent({ action: "synchronize", before: "old", after: "new", pull_request: { number: 3, head: { sha: "new" }, base: {} } });
    expect(isEventRangeConsistent(event, "old", "new")).toBe(true);
    expect(isEventRangeConsistent(event, "wrong", "new")).toBe(false);
  });
  it("normalizes review-comment replies without treating them as reviews", () => {
    expect(normalizeEvent({ action: "created", pull_request: { number: 3, head: { sha: "head", repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } }, comment: { id: 9, in_reply_to_id: 8, body: "question", user: { login: "human", type: "User" } } })).toMatchObject({ kind: "reply", pr: 3, commentId: 9, parentCommentId: 8, fork: false });
  });
  it("requires a root finding and authenticates reply marker ownership at selection time", () => {
    const root = { body: "<!-- pi-reviewer:finding:v1 --> finding" };
    expect(isPiReviewerRootComment(root)).toBe(true);
    expect(isPiReviewerRootComment({ ...root, in_reply_to_id: 3 })).toBe(false);
    expect(decodeReplyMarker(replyMarker(9, 8, "thread-1"))).toEqual({ version: 1, commentId: 9, parentId: 8, threadId: "thread-1" });
  });
  it("gates replies to trusted human repository participants", () => {
    expect(isAuthorizedReply({ kind: "reply", draft: false, fork: false, actor: { association: "MEMBER", type: "User" } })).toBe(true);
    expect(isAuthorizedReply({ kind: "reply", draft: false, fork: false, actor: { association: "CONTRIBUTOR", type: "User" } })).toBe(false);
    expect(isAuthorizedReply({ kind: "reply", draft: false, fork: false, actor: { association: "MEMBER", type: "Bot" } })).toBe(false);
  });
  it("accepts only positive safe PR numbers", () => {
    expect(isSafePullRequestNumber(1)).toBe(true);
    expect(isSafePullRequestNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafePullRequestNumber(0)).toBe(false);
    expect(isSafePullRequestNumber(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(normalizeEvent({ inputs: { "pr-number": "not-a-number" } }).pr).toBeUndefined();
  });
});
