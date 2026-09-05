import { generateReplyResponse, parseReplyAction } from "./review.js";
import { decodeReplyMarker, decodeStatusMarker, isAuthorizedReply, isPiReviewerRootComment, replyMarker, type Event } from "./batch.js";
import type { PullRequest, ReviewComment, ReviewThread } from "./github.js";
import type { ThinkingLevel } from "../core/config.js";

export interface ReplyClient {
  listComments(repo: string, number: number): Promise<ReviewComment[]>;
  listThreads(repo: string, number: number): Promise<ReviewThread[]>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  reply(repo: string, number: number, comment: number, body: string): Promise<ReviewComment>;
  updateReviewComment(repo: string, number: number, comment: number, body: string): Promise<ReviewComment>;
  resolveThread(threadId: string): Promise<unknown>;
  createReviewCommentReaction(repo: string, number: number, comment: number, content: string): Promise<{ id: number; content: string }>;
}

export interface ReplyIdentity { login: string }

export interface ReplyHandlerOptions {
  event: Event;
  repo: string;
  pullRequest: PullRequest;
  identity: ReplyIdentity;
  github: ReplyClient;
  thinking?: ThinkingLevel;
  piApiKey?: string;
  generate?: (options: Parameters<typeof generateReplyResponse>[0]) => Promise<unknown>;
}

/** Handle one review-comment reply without entering the normal review path. */
export async function handleReply(options: ReplyHandlerOptions): Promise<boolean> {
  const { event, repo, pullRequest, identity, github } = options;
  if (!isAuthorizedReply(event) || event.actor?.login === identity.login || !Number.isSafeInteger(event.commentId) || !Number.isSafeInteger(event.parentCommentId) || (event.commentId ?? 0) <= 0 || (event.parentCommentId ?? 0) <= 0) return false;

  try {
    const commentId = event.commentId as number;
    const parentCommentId = event.parentCommentId as number;
    const [replyComments, replyThreads] = await Promise.all([github.listComments(repo, event.pr!), github.listThreads(repo, event.pr!)]);
    const parent = replyComments.find(c => c.id === parentCommentId);
    const triggering = replyComments.find(c => c.id === commentId);
    const thread = replyThreads.find(t => t.comments.nodes.some(c => c.id === parentCommentId));
    if (!parent || !triggering || triggering.user?.login !== event.actor?.login || triggering.in_reply_to_id !== parentCommentId || !isPiReviewerRootComment(parent) || parent.user?.login !== identity.login || thread?.isResolved || !thread) return false;
    if (pullRequest.head.sha !== event.headSha) return false;
    const existingReply = replyComments.find(c => c.user?.login === identity.login && decodeReplyMarker(c.body)?.commentId === commentId && decodeReplyMarker(c.body)?.parentId === parentCommentId && decodeReplyMarker(c.body)?.threadId === thread.id);
    if (existingReply) {
      const existingStatus = decodeStatusMarker(existingReply.body);
      if (!existingStatus || existingStatus.targetSha !== pullRequest.head.sha || !["STILL_OPEN", "RESOLVED"].includes(existingStatus.status)) return false;
      const latest = await github.getPullRequest(repo, event.pr!);
      if (latest.head.sha !== pullRequest.head.sha) return false;
      if (existingStatus.status === "STILL_OPEN") {
        await github.resolveThread(thread.id);
        await github.updateReviewComment(repo, event.pr!, existingReply.id, existingReply.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'));
      } else {
        await github.resolveThread(thread.id);
      }
      return true;
    }
    const nearby = replyComments.filter(c => thread.comments.nodes.some(n => n.id === c.id)).sort((a, b) => a.id - b.id).slice(-12).map(c => `${c.user?.login ?? "unknown"}: ${c.body}`).join("\n");
    const action = parseReplyAction(await (options.generate ?? generateReplyResponse)({ parent: parent.body, userReply: triggering.body, thread: nearby, thinking: options.thinking, piApiKey: options.piApiKey }));
    if (!action) return false;
    const [current, freshComments] = await Promise.all([github.getPullRequest(repo, event.pr!), github.listComments(repo, event.pr!)]);
    if (current.head.sha !== pullRequest.head.sha) return false;
    if (action.action === "react") {
      await github.createReviewCommentReaction(repo, event.pr!, commentId, action.content);
    } else {
      const freshReply = freshComments.find(c => c.user?.login === identity.login && decodeReplyMarker(c.body)?.commentId === commentId && decodeReplyMarker(c.body)?.parentId === parentCommentId && decodeReplyMarker(c.body)?.threadId === thread.id);
      if (freshReply) {
        const freshStatus = decodeStatusMarker(freshReply.body);
        if (action.action !== "resolve" || !freshStatus || freshStatus.targetSha !== pullRequest.head.sha || !["STILL_OPEN", "RESOLVED"].includes(freshStatus.status)) return false;
        const latest = await github.getPullRequest(repo, event.pr!);
        if (latest.head.sha !== pullRequest.head.sha) return false;
        if (freshStatus.status === "STILL_OPEN") {
          await github.resolveThread(thread.id);
          await github.updateReviewComment(repo, event.pr!, freshReply.id, freshReply.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'));
        } else {
          await github.resolveThread(thread.id);
        }
        return true;
      }
      const lifecycle = action.action === "resolve"
        ? `\n<!-- pi-reviewer:status:v1 ${JSON.stringify({ findingId: parentCommentId, targetSha: pullRequest.head.sha, status: "STILL_OPEN" })} -->`
        : "";
      const posted = await github.reply(repo, event.pr!, parentCommentId, `${replyMarker(commentId, parentCommentId, thread.id)}${lifecycle}\n${action.body}`);
      if (action.action === "resolve") {
        const latest = await github.getPullRequest(repo, event.pr!);
        if (latest.head.sha !== pullRequest.head.sha) return false;
        await github.resolveThread(thread.id);
        await github.updateReviewComment(repo, event.pr!, posted.id, posted.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'));
      }
    }
    return true;
  } catch (error) {
    console.warn(`[pi-reviewer] reply skipped after error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
