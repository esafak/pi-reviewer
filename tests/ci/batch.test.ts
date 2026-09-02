import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAgentResponseWithStatus } from "../../src/core/output.js";
import { collectFindingHistory, decodeBatchMarker, encodeBatchMarker, encodeBodyFindingMarker, isAuthorizedReply, isAuthorizedReviewCommand, isEventRangeConsistent, isPiReviewerRootComment, isSafePullRequestNumber, normalizeEvent, replyMarker, decodeReplyMarker, selectAuthenticatedBatchMarkers, selectBatchRange } from "../../src/ci/batch.js";

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

describe("resolved finding history", () => {
  it("collects resolved inline conversations from every participant and body fallback history", () => {
    const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/resolved-loki-pr-1604.json"), "utf8")) as { pullRequest: number; resolvedReview: number; laterReview: number; provenance: string };
    expect(fixture).toMatchObject({ pullRequest: 1604, resolvedReview: 5078197836, laterReview: 5083938684 });
    expect(fixture.provenance).toContain("Synthetic");
    const bodyFinding = { findingId: 9001, file: "charts/loki/values.yaml", line: 42, side: "RIGHT" as const, severity: "WARN" as const, body: "Loki values allow an unsafe configuration.", status: "RESOLVED" as const, targetSha: "resolved-sha", explanation: "human resolution" };
    const result = collectFindingHistory({
      login: "review-bot",
      reviews: [{ id: 5078197836, body: `${encodeBatchMarker({ fromSha: "base", toSha: "old", kind: "opened", actor: "review-bot", reviewId: 5078197836 })}\n${encodeBodyFindingMarker(bodyFinding)}`, user: { login: "review-bot" } }],
      issueComments: [{ id: 5083938684, body: "fallback", user: { login: "review-bot" } }],
      comments: [
        { id: 42, body: "<!-- pi-reviewer:finding:v1 -->\nLoki values allow an unsafe configuration.", user: { login: "review-bot" }, path: "charts/loki/values.yaml", line: 42, side: "RIGHT", pull_request_review_id: 5078197836, created_at: "2026-01-01T00:00:00Z" },
        { id: 43, body: "I checked the deployment; this is safe.", user: { login: "maintainer" }, in_reply_to_id: 42, created_at: "2026-01-01T00:01:00Z" },
        { id: 44, body: "<!-- pi-reviewer:status:v1 {\"findingId\":42,\"targetSha\":\"resolved-sha\",\"status\":\"RESOLVED\"} --> Resolved", user: { login: "review-bot" }, in_reply_to_id: 42, created_at: "2026-01-01T00:02:00Z" },
        { id: 45, body: "<!-- pi-reviewer:finding:v1 -->\nactive", user: { login: "review-bot" }, path: "src/a.ts", line: 1, side: "RIGHT", created_at: "2026-01-01T00:03:00Z" }
      ],
      threads: [{ id: "thread-42", isResolved: true, comments: { nodes: [{ id: 42 }, { id: 43 }, { id: 44 }] } }]
    });
    expect(result.activeFindings.map(f => f.commentId)).toEqual([45]);
    expect(result.resolvedFindings.map(f => f.historicalFindingId)).toEqual(["inline:42", "body:9001"]);
    expect(result.resolvedFindings[0].conversation).toContain("maintainer: I checked");
    expect(result.resolvedFindings[0].resolutionTargetSha).toBe("resolved-sha");
  });

  it("keeps identical text at different locations distinguishable", () => {
    const comments = [1, 2].map((id, i) => ({ id, body: "<!-- pi-reviewer:finding:v1 -->\nsame", user: { login: "bot" }, path: "src/a.ts", line: i + 1, side: "RIGHT", created_at: `2026-01-0${i + 1}` }));
    const result = collectFindingHistory({ login: "bot", reviews: [], issueComments: [], comments, threads: [{ id: "t1", isResolved: true, comments: { nodes: [{ id: 1 }] } }, { id: "t2", isResolved: true, comments: { nodes: [{ id: 2 }] } }] });
    expect(result.resolvedFindings.map(f => f.historicalFindingId)).toEqual(["inline:1", "inline:2"]);
  });

  it("keeps bot-authored lifecycle metadata authoritative across revisions", () => {
    const result = collectFindingHistory({
      login: "review-bot",
      reviews: [],
      issueComments: [],
      comments: [
        { id: 1, body: "<!-- pi-reviewer:finding:v1 -->\nactive issue", user: { login: "review-bot" }, path: "src/a.ts", line: 1, side: "RIGHT", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, body: "Quoting the bot: <!-- pi-reviewer:status:v1 {\"findingId\":1,\"targetSha\":\"fake\",\"status\":\"RESOLVED\"} --> looks resolved to me", user: { login: "maintainer" }, in_reply_to_id: 1, created_at: "2026-01-01T00:01:00Z" },
        { id: 10, body: "<!-- pi-reviewer:finding:v1 -->\nprior revision issue", user: { login: "review-bot" }, path: "src/b.ts", line: 2, side: "RIGHT", created_at: "2026-01-02T00:00:00Z" },
        { id: 11, body: "<!-- pi-reviewer:status:v1 {\"findingId\":10,\"targetSha\":\"prior-sha\",\"status\":\"PARTIALLY_RESOLVED\"} -->\nPartially addressed by prior-sha: improved", user: { login: "review-bot" }, in_reply_to_id: 10, created_at: "2026-01-02T00:01:00Z" },
        { id: 12, body: "<!-- pi-reviewer:status:v1 {\"findingId\":10,\"targetSha\":\"current-sha\",\"status\":\"RESOLVED\"} -->\nResolved by current-sha: fully fixed", user: { login: "review-bot" }, in_reply_to_id: 10, created_at: "2026-01-02T00:02:00Z" },
        { id: 13, body: "Thanks, confirmed!", user: { login: "maintainer" }, in_reply_to_id: 10, created_at: "2026-01-02T00:03:00Z" },
      ],
      threads: [
        { id: "t1", isResolved: false, comments: { nodes: [{ id: 1 }, { id: 2 }] } },
        { id: "t2", isResolved: true, comments: { nodes: [{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }] } },
      ],
    });
    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0].latestStatus).toBeUndefined();
    const resolved = result.resolvedFindings[0];
    expect(resolved.resolutionTargetSha).toBe("current-sha");
    expect(resolved.resolutionExplanation).toContain("Resolved by current-sha: fully fixed");
    expect(resolved.resolutionExplanation).not.toContain("status:v1");
  });

  it("keeps the latest bot status reply authoritative over later non-status bot replies", () => {
    const result = collectFindingHistory({
      login: "review-bot",
      reviews: [],
      issueComments: [],
      comments: [
        { id: 1, body: "<!-- pi-reviewer:finding:v1 -->\nissue", user: { login: "review-bot" }, path: "f.ts", line: 1, side: "RIGHT", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, body: "<!-- pi-reviewer:status:v1 {\"findingId\":1,\"targetSha\":\"sha1\",\"status\":\"PARTIALLY_RESOLVED\"} -->\nPartially addressed by sha1: improved", user: { login: "review-bot" }, in_reply_to_id: 1, created_at: "2026-01-01T00:01:00Z" },
        { id: 3, body: "<!-- pi-reviewer:reply:v1 {\"version\":1,\"commentId\":1,\"parentId\":1,\"threadId\":\"t\"} -->\nHere is the fix you asked for.", user: { login: "review-bot" }, in_reply_to_id: 1, created_at: "2026-01-01T00:02:00Z" },
      ],
      threads: [],
    });
    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0].latestStatus).toBe("PARTIALLY_RESOLVED");
  });

  it("decodes status metadata regardless of JSON key order", () => {
    const result = collectFindingHistory({
      login: "review-bot",
      reviews: [],
      issueComments: [],
      comments: [
        { id: 1, body: "<!-- pi-reviewer:finding:v1 -->\nissue", user: { login: "review-bot" }, path: "src/a.ts", line: 1, side: "RIGHT", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, body: "<!-- pi-reviewer:status:v1 {\"status\":\"RESOLVED\",\"findingId\":1,\"targetSha\":\"sha1\"} -->\nResolved", user: { login: "review-bot" }, in_reply_to_id: 1, created_at: "2026-01-01T00:01:00Z" },
      ],
      threads: [{ id: "t1", isResolved: true, comments: { nodes: [{ id: 1 }, { id: 2 }] } }],
    });
    expect(result.resolvedFindings[0]).toMatchObject({ resolutionTargetSha: "sha1", resolutionExplanation: "Resolved" });
  });

  it("regresses the synthetic PR #1604 unchanged Loki review and permits only proven reraises", () => {
    const fixture = JSON.parse(readFileSync(path.resolve(process.cwd(), "tests/fixtures/resolved-loki-pr-1604.json"), "utf8")) as { finding: { file: string; line: number; side: "LEFT" | "RIGHT"; body: string }; laterDiff: string };
    const history = [{ historicalFindingId: "inline:42", originalBody: fixture.finding.body, ...fixture.finding }];
    const unchanged = parseAgentResponseWithStatus(JSON.stringify({ summary: fixture.laterDiff, comments: [{ ...fixture.finding, severity: "WARN" }] }), "INFO", undefined, undefined, history);
    expect(unchanged.result.comments).toHaveLength(0);

    for (const reason of ["REINTRODUCED", "MATERIALLY_CHANGED", "CONTRADICTORY_EVIDENCE"] as const) {
      const reraised = parseAgentResponseWithStatus(JSON.stringify({ summary: fixture.laterDiff, comments: [{ ...fixture.finding, severity: "WARN", resolved_finding_id: "inline:42", re_raise_reason: reason, re_raise_evidence: fixture.laterDiff }] }), "INFO", undefined, undefined, history, { commitId: "later-sha", batchMarker: "batch-marker" });
      expect(reraised.result.comments).toHaveLength(1);
      expect(reraised.result.comments[0].reRaiseProvenance).toEqual({ historicalFindingId: "inline:42", reason, evidence: fixture.laterDiff });
      expect(reraised.result.comments[0].body).not.toContain("pi-reviewer:re-raise:v1");
    }
  });

  it("imports legacy active body markers and ignores malformed markers", () => {
    const result = collectFindingHistory({ login: "bot", reviews: [{ id: 1, user: { login: "bot" }, body: "legacy\n<!-- pi-reviewer:body-finding:v1 {broken} -->\n" + encodeBodyFindingMarker({ findingId: 7, file: "src/a.ts", line: 2, side: "RIGHT", severity: "INFO", body: "legacy finding" }) }], issueComments: [], comments: [], threads: [] });
    expect(result.activeFindings).toHaveLength(1);
    expect(result.activeFindings[0]).toMatchObject({ historicalFindingId: "body:7", body: "legacy finding" });
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
