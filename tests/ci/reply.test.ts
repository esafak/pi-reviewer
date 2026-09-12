import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { discoverPendingReplies, handleReply, recoverPendingReplies, resolveAuthorizedLogins } from "../../src/ci/reply.js";
import { recoverSynchronizeReplies } from "../../src/ci/recovery.js";
import { parseReplyAction } from "../../src/ci/review.js";
import { replyMarker, type Event } from "../../src/ci/batch.js";
import { GitHubClient, type PullRequest, type ReviewComment, type ReviewThread } from "../../src/ci/github.js";

afterEach(() => vi.unstubAllGlobals());

const pr: PullRequest = { number: 42, head: { sha: "head", repo: { full_name: "owner/repo" } }, base: { sha: "base", repo: { full_name: "owner/repo" } } };
const event: Event = { kind: "reply", pr: 42, headSha: "head", draft: false, fork: false, commentId: 9, parentCommentId: 8, actor: { login: "human", association: "MEMBER", type: "User" } };
const root: ReviewComment = { id: 8, body: "<!-- pi-reviewer:finding:v1 --> finding", path: "src/example.ts", line: 12, side: "RIGHT", user: { login: "reviewer[bot]", type: "Bot" } };
const triggering: ReviewComment = { id: 9, body: "Can you explain this?", in_reply_to_id: 8, user: { login: "human", type: "User" } };
const thread: ReviewThread = { id: "thread-1", isResolved: false, comments: { nodes: [{ id: 8 }, { id: 9 }], pageInfo: { hasNextPage: false } } };

function client(comments: ReviewComment[] = [root, triggering], current = pr, permissions: Record<string, string> = {}) {
  const all = [...comments];
  const reply = vi.fn(async (_repo: string, _number: number, id: number, body: string) => {
    all.push({ id: 10_000 + all.length, body, in_reply_to_id: id, user: { login: "reviewer[bot]", type: "Bot" } });
    return all.at(-1)!;
  });
  const createReviewCommentReaction = vi.fn(async () => ({ id: 11, content: "+1" }));
  const resolveThread = vi.fn(async () => undefined);
  const updateReviewComment = vi.fn(async (_repo: string, _number: number, id: number, body: string) => ({ id, body } as ReviewComment));
  const getCollaboratorPermission = vi.fn(async (_repo: string, login: string) => permissions[login] ?? "write");
  return {
    listComments: vi.fn(async () => [...all]),
    listThreads: vi.fn(async () => [thread]),
    getPullRequest: vi.fn(async () => current),
    getCollaboratorPermission,
    reply,
    updateReviewComment,
    resolveThread,
    createReviewCommentReaction,
  };
}

describe("review-comment reply action path", () => {
  it("discovers the oldest unprocessed direct reply per unresolved finding", () => {
    const first: ReviewComment = { id: 9, body: "first", in_reply_to_id: 8, created_at: "2026-01-01T00:00:00Z", author_association: "MEMBER", user: { login: "human", type: "User" } };
    const second: ReviewComment = { id: 10, body: "second", in_reply_to_id: 8, created_at: "2026-01-01T00:01:00Z", author_association: "MEMBER", user: { login: "human", type: "User" } };
    const handled: ReviewComment = { id: 11, body: replyMarker(9, 8, "thread-1"), in_reply_to_id: 8, user: { login: "reviewer[bot]", type: "Bot" } };
    const snapshot = { pullRequest: pr, comments: [root, first, second, handled], threads: [thread] };
    expect(discoverPendingReplies(snapshot, { login: "reviewer[bot]" }, new Set(["human"]))).toEqual([expect.objectContaining({ commentId: 10, parentCommentId: 8, threadId: "thread-1", headSha: "head" })]);
  });

  it("discovers replies from real listThreads output with aliased numeric ids", async () => {
    const body = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{
                id: "PRRT_kwDOLlU_5s",
                isResolved: false,
                comments: {
                  nodes: [{ id: "8" }, { id: "9" }],
                  pageInfo: { hasNextPage: false },
                },
              }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", text: vi.fn().mockResolvedValue(JSON.stringify(body)) }));
    const threads = await new GitHubClient("token").listThreads("owner/repo", 42);
    const humanReply: ReviewComment = { ...triggering, author_association: "MEMBER" };
    const snapshot = { pullRequest: pr, comments: [root, humanReply], threads };
    expect(threads[0].comments.nodes.map(comment => comment.id)).toEqual([8, 9]);
    expect(discoverPendingReplies(snapshot, { login: "reviewer[bot]" }, new Set(["human"]))).toEqual([
      expect.objectContaining({ commentId: 9, parentCommentId: 8, threadId: "PRRT_kwDOLlU_5s" }),
    ]);
  });

  it("does not let nested, unauthorized, resolved, or spoofed replies suppress recovery", () => {
    const secondRoot: ReviewComment = { id: 18, body: "<!-- pi-reviewer:finding:v1 --> second", user: { login: "reviewer[bot]", type: "Bot" } };
    const nested: ReviewComment = { id: 19, body: "nested", in_reply_to_id: 9, author_association: "MEMBER", user: { login: "human", type: "User" } };
    const unauthorized: ReviewComment = { id: 20, body: "outsider", in_reply_to_id: 8, author_association: "NONE", user: { login: "outsider", type: "User" } };
    const resolvedThread: ReviewThread = { id: "thread-2", isResolved: true, comments: { nodes: [{ id: 18 }], pageInfo: { hasNextPage: false } } };
    const spoofed: ReviewComment = { id: 21, body: replyMarker(9, 8, "thread-1"), in_reply_to_id: 8, author_association: "MEMBER", user: { login: "human", type: "User" } };
    const snapshot = { pullRequest: pr, comments: [root, { ...triggering, user: { login: "other", type: "User" } }, nested, unauthorized, secondRoot, spoofed], threads: [thread, resolvedThread] };
    expect(discoverPendingReplies(snapshot, { login: "reviewer[bot]" }, new Set(["human"]))).toEqual([expect.objectContaining({ commentId: 21, parentCommentId: 8 })]);
  });

  it("recovers a canceled reply event through the push path", async () => {
    const replyComment = { ...triggering, author_association: "MEMBER", created_at: "2026-01-01T00:00:00Z" };
    const snapshot = { pullRequest: pr, comments: [root, replyComment], threads: [thread] };
    const github = client([root, replyComment]);
    const generate = vi.fn(async () => ({ action: "resolve", body: "The exception is intentional for this adoption PR." }));

    expect(await recoverSynchronizeReplies({ repo: "owner/repo", pullRequest: pr, expectedHeadSha: "head", identity: { login: "reviewer[bot]" }, github, snapshot, generate })).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(github.reply).toHaveBeenCalledTimes(1);
    expect(github.resolveThread).toHaveBeenCalledWith("thread-1");
  });

  it("refuses stale, fork, and snapshot-mismatched synchronize recovery", async () => {
    const github = client();
    const generate = vi.fn();
    expect(await recoverSynchronizeReplies({ repo: "owner/repo", pullRequest: pr, expectedHeadSha: "other", identity: { login: "reviewer[bot]" }, github, snapshot: { pullRequest: pr, comments: [], threads: [] }, generate })).toBe(0);
    expect(await recoverSynchronizeReplies({ repo: "owner/repo", pullRequest: { ...pr, head: { ...pr.head, repo: { full_name: "fork/repo" } } }, expectedHeadSha: "head", identity: { login: "reviewer[bot]" }, github, snapshot: { pullRequest: pr, comments: [], threads: [] }, generate })).toBe(0);
    expect(await recoverSynchronizeReplies({ repo: "owner/repo", pullRequest: pr, expectedHeadSha: "head", identity: { login: "reviewer[bot]" }, github, snapshot: { pullRequest: { ...pr, head: { ...pr.head, sha: "other" } }, comments: [root, triggering], threads: [thread] }, generate })).toBe(0);
    expect(github.reply).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("continues recovery after one reply fails and does not invoke the model twice", async () => {
    const firstReply: ReviewComment = { ...triggering, author_association: "MEMBER" };
    const secondRoot: ReviewComment = { id: 18, body: "<!-- pi-reviewer:finding:v1 --> second", path: "src/other.ts", line: 4, side: "RIGHT", user: { login: "reviewer[bot]", type: "Bot" } };
    const secondReply: ReviewComment = { id: 19, body: "Please explain", in_reply_to_id: 18, author_association: "MEMBER", user: { login: "human", type: "User" } };
    const secondThread: ReviewThread = { id: "thread-2", isResolved: false, comments: { nodes: [{ id: 18 }, { id: 19 }], pageInfo: { hasNextPage: false } } };
    const github = client([root, firstReply, secondRoot, secondReply]);
    github.listThreads = vi.fn(async () => [thread, secondThread]);
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error("temporary model failure"))
      .mockResolvedValue({ action: "resolve", body: "acknowledged" });
    const snapshot = { pullRequest: pr, comments: [root, firstReply, secondRoot, secondReply], threads: [thread, secondThread] };
    expect(await recoverPendingReplies({ repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, snapshot, refreshSnapshot: async () => ({ pullRequest: pr, comments: [root, firstReply, secondRoot, secondReply], threads: [thread, secondThread] }), generate })).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(github.reply).toHaveBeenCalledTimes(1);
    github.listThreads = vi.fn(async () => [{ ...thread, isResolved: true }, secondThread]);
    expect(await recoverSynchronizeReplies({ repo: "owner/repo", pullRequest: pr, expectedHeadSha: "head", identity: { login: "reviewer[bot]" }, github, generate })).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(github.reply).toHaveBeenCalledTimes(1);
  });

  it("does not discover bot-authored replies", () => {
    const botReply: ReviewComment = { id: 22, body: "bot reply", in_reply_to_id: 8, author_association: "MEMBER", user: { login: "other-bot", type: "Bot" } };
    expect(discoverPendingReplies({ pullRequest: pr, comments: [root, botReply], threads: [thread] }, { login: "reviewer[bot]" }, new Set(["other-bot"]))).toEqual([]);
  });

  // Regression: the webhook payload reports CONTRIBUTOR for an org owner/admin, so
  // authorization must come from repository permission, not author_association.
  it("authorizes a reply by repository permission even when the payload association is CONTRIBUTOR", async () => {
    const github = client();
    const generate = vi.fn(async () => ({ action: "reply", body: "acknowledged" }));
    const contributor: Event = { ...event, actor: { login: "human", association: "CONTRIBUTOR", type: "User" } };

    expect(await handleReply({ event: contributor, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(true);
    expect(github.getCollaboratorPermission).toHaveBeenCalledWith("owner/repo", "human");
    expect(github.reply).toHaveBeenCalledTimes(1);
  });

  it("discovers a reply whose REST association is CONTRIBUTOR when permission authorizes it", () => {
    const contributor: ReviewComment = { ...triggering, author_association: "CONTRIBUTOR" };
    const snapshot = { pullRequest: pr, comments: [root, contributor], threads: [thread] };
    expect(discoverPendingReplies(snapshot, { login: "reviewer[bot]" }, new Set(["human"]))).toEqual([
      expect.objectContaining({ commentId: 9, parentCommentId: 8, threadId: "thread-1" }),
    ]);
  });

  it("fails closed and logs when the permission lookup fails", async () => {
    const github = client();
    github.getCollaboratorPermission.mockRejectedValueOnce(new Error("403 Resource not accessible"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn() })).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not resolve permission"));
      expect(github.reply).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores a reply author without write permission and logs the association", () => {
    const outsider: ReviewComment = { id: 30, body: "drive-by", in_reply_to_id: 8, author_association: "NONE", user: { login: "outsider", type: "User" } };
    const snapshot = { pullRequest: pr, comments: [root, outsider], threads: [thread] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(discoverPendingReplies(snapshot, { login: "reviewer[bot]" }, new Set(["human"]))).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"outsider" association=NONE is not authorized'));
    } finally {
      warn.mockRestore();
    }
  });

  // The recovery path resolves permissions itself when the caller does not inject a set.
  it("denies recovery when the candidate author has no write permission", async () => {
    const replyComment: ReviewComment = { ...triggering, author_association: "CONTRIBUTOR" };
    const snapshot = { pullRequest: pr, comments: [root, replyComment], threads: [thread] };
    const github = client([root, replyComment], pr, { human: "read" });
    const generate = vi.fn();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await recoverSynchronizeReplies({ repo: "owner/repo", pullRequest: pr, expectedHeadSha: "head", identity: { login: "reviewer[bot]" }, github, snapshot, generate })).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"human" lacks write permission'));
      expect(github.reply).not.toHaveBeenCalled();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("resolves each candidate author once and excludes unknown permissions", async () => {
    const github = client();
    github.getCollaboratorPermission.mockImplementation(async (_repo: string, login: string) => login === "admin" ? "admin" : undefined);
    const authorized = await resolveAuthorizedLogins(github, "owner/repo", ["admin", "admin", "ghost"]);
    expect([...authorized]).toEqual(["admin"]);
    expect(github.getCollaboratorPermission).toHaveBeenCalledTimes(2);
  });


  it("decodes JSON-escaped Markdown line breaks in assistant replies", () => {
    expect(parseReplyAction({ action: "reply", body: "First paragraph\\n\\n- **second**" })).toEqual({
      action: "reply",
      body: "First paragraph\n\n- **second**",
    });
  });

  it("posts one response rooted at the finding and remains idempotent", async () => {
    const github = client();
    const generate = vi.fn(async () => ({ action: "reply", body: "That is explained by the validation step." }));

    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(true);
    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(false);
    expect(github.reply).toHaveBeenCalledTimes(1);
    expect(github.reply).toHaveBeenCalledWith("owner/repo", 42, 8, `${replyMarker(9, 8, "thread-1")}\nThat is explained by the validation step.`);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("posts and resolves an explicit resolve action", async () => {
    const github = client();
    const generate = vi.fn(async () => ({ action: "resolve", body: "I am withdrawing this concern." }));

    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(true);
    expect(github.reply).toHaveBeenCalledWith("owner/repo", 42, 8, `${replyMarker(9, 8, "thread-1")}\n<!-- pi-reviewer:status:v1 {"findingId":8,"targetSha":"head","status":"STILL_OPEN"} -->\nI am withdrawing this concern.`);
    expect(github.updateReviewComment).toHaveBeenCalledWith("owner/repo", 42, 10_002, `${replyMarker(9, 8, "thread-1")}\n<!-- pi-reviewer:status:v1 {"findingId":8,"targetSha":"head","status":"RESOLVED"} -->\nI am withdrawing this concern.`);
    expect(github.resolveThread).toHaveBeenCalledWith("thread-1");
    expect(github.resolveThread.mock.invocationCallOrder[0]).toBeLessThan(github.updateReviewComment.mock.invocationCallOrder[0]);
  });
  it("does not mark a reply resolved when thread resolution fails", async () => {
    const github = client();
    github.resolveThread.mockRejectedValueOnce(new Error("resolve failed"));
    const generate = vi.fn(async () => ({ action: "resolve", body: "I am withdrawing this concern." }));

    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(false);
    expect(github.reply).toHaveBeenCalledWith("owner/repo", 42, 8, expect.stringContaining('"status":"STILL_OPEN"'));
    expect(github.updateReviewComment).not.toHaveBeenCalled();
  });
  it("retries resolution without duplicating an already-posted resolve reply", async () => {
    const github = client();
    const body = `${replyMarker(9, 8, "thread-1")}\n<!-- pi-reviewer:status:v1 {"findingId":8,"targetSha":"head","status":"STILL_OPEN"} -->\nI am withdrawing this concern.`;
    github.listComments.mockResolvedValue([root, triggering, { id: 10, body, in_reply_to_id: 8, user: { login: "reviewer[bot]" } }]);

    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn() })).toBe(true);
    expect(github.reply).not.toHaveBeenCalled();
    expect(github.updateReviewComment).toHaveBeenCalled();
    expect(github.resolveThread).toHaveBeenCalledWith("thread-1");
  });
  it("does not retry resolution for a stale event", async () => {
    const github = client();
    const body = `${replyMarker(9, 8, "thread-1")}\n<!-- pi-reviewer:status:v1 {"findingId":8,"targetSha":"head","status":"STILL_OPEN"} -->\nI am withdrawing this concern.`;
    github.listComments.mockResolvedValue([root, triggering, { id: 10, body, in_reply_to_id: 8, user: { login: "reviewer[bot]" } }]);

    expect(await handleReply({ event: { ...event, headSha: "old-head" }, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn() })).toBe(false);
    expect(github.reply).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
  });
  it("does not retry when the existing resolve marker targets another head", async () => {
    const github = client();
    const body = `${replyMarker(9, 8, "thread-1")}\n<!-- pi-reviewer:status:v1 {"findingId":8,"targetSha":"old-head","status":"STILL_OPEN"} -->\nI am withdrawing this concern.`;
    github.listComments.mockResolvedValue([root, triggering, { id: 10, body, in_reply_to_id: 8, user: { login: "reviewer[bot]" } }]);

    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn() })).toBe(false);
    expect(github.updateReviewComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
  });
  it("does not leave a resolved marker when the head moves after posting", async () => {
    const github = client();
    github.getPullRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ ...pr, head: { ...pr.head, sha: "new-head" } });
    const generate = vi.fn(async () => ({ action: "resolve", body: "I am withdrawing this concern." }));

    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(false);
    expect(github.reply).toHaveBeenCalledWith("owner/repo", 42, 8, expect.stringContaining('"status":"STILL_OPEN"'));
    expect(github.reply).not.toHaveBeenCalledWith("owner/repo", 42, 8, expect.stringContaining('"status":"RESOLVED"'));
    expect(github.updateReviewComment).not.toHaveBeenCalled();
    expect(github.resolveThread).not.toHaveBeenCalled();
  });
  it("reacts to the triggering user comment, not the root finding", async () => {
    const github = client();
    const generate = vi.fn(async () => ({ action: "react", content: "heart" }));
    expect(await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate })).toBe(true);
    expect(github.createReviewCommentReaction).toHaveBeenCalledWith("owner/repo", 42, 9, "heart");
    expect(github.reply).not.toHaveBeenCalled();
  });
  it("posts nothing for a malformed action", async () => {
    const github = client();
    await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn(async () => "plain text") });
    expect(github.reply).not.toHaveBeenCalled();
    expect(github.createReviewCommentReaction).not.toHaveBeenCalled();
  });

  it.each([
    ["human-rooted", { ...root, user: { login: "human" }, body: "human finding" }, triggering, event, {}],
    ["quoted-marker-root", { ...root, body: "Quoted <!-- pi-reviewer:finding:v1 --> finding" }, triggering, event, {}],
    ["variant-marker-root", { ...root, body: "<!-- pi-reviewer :finding:v1 --> finding" }, triggering, event, {}],
    ["bot-authored", root, { ...triggering, user: { login: "other-bot", type: "Bot" } }, { ...event, actor: { login: "other-bot", association: "MEMBER", type: "Bot" } }, {}],
    ["no write permission", root, { ...triggering, user: { login: "outsider", type: "User" } }, { ...event, actor: { login: "outsider", association: "CONTRIBUTOR", type: "User" } }, { outsider: "read" }],
    ["resolved", root, triggering, event, {}],
    ["stale head", root, triggering, { ...event, headSha: "old-head" }, {}],
  ])("posts nothing for %s replies", async (name, parent, replyComment, replyEvent, permissions) => {
    const github = client([parent as ReviewComment, replyComment as ReviewComment], pr, permissions as Record<string, string>);
    if (name === "resolved") github.listThreads.mockResolvedValue([{ ...thread, isResolved: true }]);

    await handleReply({ event: replyEvent as Event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn(async () => ({ action: "reply", body: "answer" })) });
    expect(github.reply).not.toHaveBeenCalled();
  });

  it("posts nothing when the authenticated duplicate marker already exists", async () => {
    const github = client([root, triggering, { id: 10, body: replyMarker(9, 8, "thread-1"), user: { login: "reviewer[bot]" } }]);
    await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn(async () => ({ action: "reply", body: "answer" })) });
    expect(github.reply).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong comment", replyMarker(99, 8, "thread-1")],
    ["wrong parent", replyMarker(9, 99, "thread-1")],
    ["wrong thread", replyMarker(9, 8, "thread-forged")],
  ])("does not trust a tampered %s marker", async (_name, marker) => {
    const github = client([root, triggering, { id: 10, body: marker, user: { login: "reviewer[bot]" } }]);
    await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn(async () => ({ action: "reply", body: "answer" })) });
    expect(github.reply).toHaveBeenCalledTimes(1);
  });

  it("does not let a human-authored forged marker suppress a response", async () => {
    const github = client([root, triggering, { id: 10, body: replyMarker(9, 8, "thread-1"), user: { login: "human" } }]);
    await handleReply({ event, repo: "owner/repo", pullRequest: pr, identity: { login: "reviewer[bot]" }, github, generate: vi.fn(async () => ({ action: "reply", body: "answer" })) });
    expect(github.reply).toHaveBeenCalledTimes(1);
  });
});
