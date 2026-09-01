import { generateReplyResponse } from "./review.js";
import { decodeReplyMarker, isAuthorizedReply, isPiReviewerRootComment, replyMarker, type Event } from "./batch.js";
import type { PullRequest, ReviewComment, ReviewThread } from "./github.js";
import type { ThinkingLevel } from "../core/config.js";

export interface ReplyClient {
  listComments(repo: string, number: number): Promise<ReviewComment[]>;
  listThreads(repo: string, number: number): Promise<ReviewThread[]>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  reply(repo: string, number: number, comment: number, body: string): Promise<ReviewComment>;
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
  generate?: typeof generateReplyResponse;
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
    const hasMarker = (comments: ReviewComment[]) => comments.some(c => {
      const marker = decodeReplyMarker(c.body);
      return c.user?.login === identity.login && marker?.commentId === commentId && marker?.parentId === parentCommentId && marker?.threadId === thread.id;
    });
    if (hasMarker(replyComments) || pullRequest.head.sha !== event.headSha) return false;

    const nearby = replyComments.filter(c => thread.comments.nodes.some(n => n.id === c.id)).sort((a, b) => a.id - b.id).slice(-12).map(c => `${c.user?.login ?? "unknown"}: ${c.body}`).join("\n");
    const answer = await (options.generate ?? generateReplyResponse)({ parent: parent.body, userReply: triggering.body, thread: nearby, thinking: options.thinking, piApiKey: options.piApiKey });
    const [current, freshComments] = await Promise.all([github.getPullRequest(repo, event.pr!), github.listComments(repo, event.pr!)]);
    if (current.head.sha !== pullRequest.head.sha || hasMarker(freshComments)) return false;
    await github.reply(repo, event.pr!, parentCommentId, `${replyMarker(commentId, parentCommentId, thread.id)}\n${answer}`);
    return true;
  } catch (error) {
    console.warn(`[pi-reviewer] reply skipped after error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
