import { describe, expect, it, vi } from "vite-plus/test";
import { handleReply } from "../../src/ci/reply.js";
import { parseReplyAction } from "../../src/ci/review.js";
import { replyMarker, type Event } from "../../src/ci/batch.js";
import type { PullRequest, ReviewComment, ReviewThread } from "../../src/ci/github.js";

const pr: PullRequest = { number: 42, head: { sha: "head", repo: { full_name: "owner/repo" } }, base: { sha: "base", repo: { full_name: "owner/repo" } } };
const event: Event = { kind: "reply", pr: 42, headSha: "head", draft: false, fork: false, commentId: 9, parentCommentId: 8, actor: { login: "human", association: "MEMBER", type: "User" } };
const root: ReviewComment = { id: 8, body: "<!-- pi-reviewer:finding:v1 --> finding", path: "src/example.ts", line: 12, side: "RIGHT", user: { login: "reviewer[bot]", type: "Bot" } };
const triggering: ReviewComment = { id: 9, body: "Can you explain this?", in_reply_to_id: 8, user: { login: "human", type: "User" } };
const thread: ReviewThread = { id: "thread-1", isResolved: false, comments: { nodes: [{ id: 8 }, { id: 9 }], pageInfo: { hasNextPage: false } } };

function client(comments: ReviewComment[] = [root, triggering], current = pr) {
  const all = [...comments];
  const reply = vi.fn(async (_repo: string, _number: number, id: number, body: string) => {
    all.push({ id: 10_000 + all.length, body, in_reply_to_id: id, user: { login: "reviewer[bot]", type: "Bot" } });
    return all.at(-1)!;
  });
  const createReviewCommentReaction = vi.fn(async () => ({ id: 11, content: "+1" }));
  return {
    listComments: vi.fn(async () => [...all]),
    listThreads: vi.fn(async () => [thread]),
    getPullRequest: vi.fn(async () => current),
    reply,
    createReviewCommentReaction,
  };
}

describe("review-comment reply action path", () => {
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
    expect(github.reply).toHaveBeenCalledWith("owner/repo", 42, 8, `${replyMarker(9, 8, "thread-1")}\n<details>\n<summary>Prompt to fix with AI</summary>\n\n\`\`\`\nREPLY: src/example.ts:12\n\nThat is explained by the validation step.\n\nFor each issue above, determine whether it is valid. If so, fix it iteratively with one reviewer agent until convergence.\n\`\`\`\n\n</details>`);
    expect(generate).toHaveBeenCalledTimes(1);
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
    ["human-rooted", { ...root, user: { login: "human" }, body: "human finding" }, triggering, event],
    ["quoted-marker-root", { ...root, body: "Quoted <!-- pi-reviewer:finding:v1 --> finding" }, triggering, event],
    ["variant-marker-root", { ...root, body: "<!-- pi-reviewer :finding:v1 --> finding" }, triggering, event],
    ["bot-authored", root, { ...triggering, user: { login: "other-bot", type: "Bot" } }, { ...event, actor: { login: "other-bot", association: "MEMBER", type: "Bot" } }],
    ["unauthorized", root, triggering, { ...event, actor: { login: "human", association: "CONTRIBUTOR", type: "User" } }],
    ["resolved", root, triggering, event],
    ["stale head", root, triggering, { ...event, headSha: "old-head" }],
  ])("posts nothing for %s replies", async (name, parent, replyComment, replyEvent) => {
    const github = client([parent as ReviewComment, replyComment as ReviewComment], name === "resolved" ? pr : pr);
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
