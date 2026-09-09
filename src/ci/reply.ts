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

export interface ReplySnapshot {
  pullRequest: PullRequest;
  comments: ReviewComment[];
  threads: ReviewThread[];
}

export interface PendingReply {
  commentId: number;
  parentCommentId: number;
  threadId: string;
  actor: NonNullable<Event["actor"]>;
  headSha: string;
}

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

export interface ReplyCommentOptions {
  pending: PendingReply;
  repo: string;
  identity: ReplyIdentity;
  github: ReplyClient;
  snapshot: ReplySnapshot;
  refreshSnapshot: () => Promise<ReplySnapshot>;
  thinking?: ThinkingLevel;
  piApiKey?: string;
  generate?: (options: Parameters<typeof generateReplyResponse>[0]) => Promise<unknown>;
}

function isPendingReplyAuthorized(reply: PendingReply, identity: ReplyIdentity): boolean {
  return isAuthorizedReply({ kind: "reply", actor: reply.actor, draft: false, fork: false }) && reply.actor.login !== identity.login;
}

function findReplyContext(snapshot: ReplySnapshot, pending: PendingReply, identity: ReplyIdentity) {
  const parent = snapshot.comments.find(c => c.id === pending.parentCommentId);
  const triggering = snapshot.comments.find(c => c.id === pending.commentId);
  const thread = snapshot.threads.find(t => t.id === pending.threadId);
  if (!parent || !triggering || !thread || thread.isResolved) return undefined;
  if (triggering.user?.login !== pending.actor.login || triggering.in_reply_to_id !== pending.parentCommentId) return undefined;
  if (!isPiReviewerRootComment(parent) || parent.user?.login !== identity.login) return undefined;
  return { parent, triggering, thread };
}

function sameReplyMarker(comment: ReviewComment, pending: PendingReply): boolean {
  const marker = decodeReplyMarker(comment.body);
  return comment.user?.login !== undefined && marker?.commentId === pending.commentId && marker.parentId === pending.parentCommentId && marker.threadId === pending.threadId;
}

function recoverableMarker(comment: ReviewComment, pending: PendingReply): boolean {
  if (!sameReplyMarker(comment, pending)) return false;
  const status = decodeStatusMarker(comment.body);
  return status?.targetSha === pending.headSha && ["STILL_OPEN", "RESOLVED"].includes(status.status);
}

/** Finds the oldest unprocessed direct human reply for each unresolved finding root. */
export function discoverPendingReplies(snapshot: ReplySnapshot, identity: ReplyIdentity): PendingReply[] {
  const threadByComment = new Map(snapshot.threads.flatMap(thread => thread.comments.nodes.map(comment => [comment.id, thread] as const)));
  const roots = snapshot.comments.filter(comment => comment.id > 0 && comment.user?.login === identity.login && isPiReviewerRootComment(comment));
  const pending: PendingReply[] = [];
  for (const root of roots) {
    const thread = threadByComment.get(root.id);
    if (!thread || thread.isResolved) continue;
    const replies = snapshot.comments
      .filter(comment => comment.in_reply_to_id === root.id && comment.id > 0)
      .filter(comment => isAuthorizedReply({ kind: "reply", actor: { login: comment.user?.login, association: comment.author_association, type: comment.user?.type }, draft: false, fork: false }) && comment.user?.login !== identity.login)
      .sort((a, b) => (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0) || a.id - b.id);
    const candidate = replies.find(reply => {
      const marker = snapshot.comments.find(botReply => botReply.user?.login === identity.login && sameReplyMarker(botReply, { commentId: reply.id, parentCommentId: root.id, threadId: thread.id, actor: { login: reply.user?.login, association: reply.author_association, type: reply.user?.type }, headSha: snapshot.pullRequest.head.sha }));
      return !marker || recoverableMarker(marker, { commentId: reply.id, parentCommentId: root.id, threadId: thread.id, actor: { login: reply.user?.login, association: reply.author_association, type: reply.user?.type }, headSha: snapshot.pullRequest.head.sha });
    });
    if (candidate) pending.push({ commentId: candidate.id, parentCommentId: root.id, threadId: thread.id, actor: { login: candidate.user?.login, association: candidate.author_association, type: candidate.user?.type }, headSha: snapshot.pullRequest.head.sha });
  }
  return pending;
}

export async function fetchReplySnapshot(github: ReplyClient, repo: string, number: number, pullRequest?: PullRequest): Promise<ReplySnapshot> {
  const [current, comments, threads] = await Promise.all([pullRequest ? Promise.resolve(pullRequest) : github.getPullRequest(repo, number), github.listComments(repo, number), github.listThreads(repo, number)]);
  return { pullRequest: current, comments, threads };
}

/** Handles one discovered reply using the same semantics as the webhook fast path. */
export async function handleReplyComment(options: ReplyCommentOptions): Promise<boolean> {
  const { pending, repo, identity, github } = options;
  if (!isPendingReplyAuthorized(pending, identity)) return false;
  try {
    let snapshot = options.snapshot;
    let context = findReplyContext(snapshot, pending, identity);
    if (!context || snapshot.pullRequest.head.sha !== pending.headSha) return false;
    snapshot = await options.refreshSnapshot();
    context = findReplyContext(snapshot, pending, identity);
    if (!context || snapshot.pullRequest.head.sha !== pending.headSha) return false;
    const { parent, triggering, thread } = context;
    const existingReply = snapshot.comments.find(comment => comment.user?.login === identity.login && sameReplyMarker(comment, pending));
    if (existingReply) {
      const existingStatus = decodeStatusMarker(existingReply.body);
      if (!existingStatus || existingStatus.targetSha !== pending.headSha || !["STILL_OPEN", "RESOLVED"].includes(existingStatus.status)) return false;
      if (existingStatus.status === "STILL_OPEN") {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) return false;
        await github.resolveThread(thread.id);
        const beforeUpdate = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeUpdate.head.sha !== pending.headSha) return false;
        await github.updateReviewComment(repo, snapshot.pullRequest.number, existingReply.id, existingReply.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'));
      } else {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) return false;
        await github.resolveThread(thread.id);
      }
      return true;
    }
    const nearby = snapshot.comments.filter(comment => thread.comments.nodes.some(node => node.id === comment.id)).sort((a, b) => a.id - b.id).slice(-12).map(comment => `${comment.user?.login ?? "unknown"}: ${comment.body}`).join("\n");
    const action = parseReplyAction(await (options.generate ?? generateReplyResponse)({ parent: parent.body, userReply: triggering.body, thread: nearby, thinking: options.thinking, piApiKey: options.piApiKey }));
    if (!action) return false;
    snapshot = await options.refreshSnapshot();
    context = findReplyContext(snapshot, pending, identity);
    if (!context || snapshot.pullRequest.head.sha !== pending.headSha) return false;
    const freshReply = snapshot.comments.find(comment => comment.user?.login === identity.login && sameReplyMarker(comment, pending));
    if (action.action === "react") {
      const beforeReaction = await github.getPullRequest(repo, snapshot.pullRequest.number);
      if (beforeReaction.head.sha !== pending.headSha) return false;
      await github.createReviewCommentReaction(repo, snapshot.pullRequest.number, pending.commentId, action.content);
    } else if (freshReply) {
      const freshStatus = decodeStatusMarker(freshReply.body);
      if (action.action !== "resolve" || !freshStatus || freshStatus.targetSha !== pending.headSha || !["STILL_OPEN", "RESOLVED"].includes(freshStatus.status)) return false;
      if (freshStatus.status === "STILL_OPEN") {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) return false;
        await github.resolveThread(context.thread.id);
        const beforeUpdate = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeUpdate.head.sha !== pending.headSha) return false;
        await github.updateReviewComment(repo, snapshot.pullRequest.number, freshReply.id, freshReply.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'));
      } else {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) return false;
        await github.resolveThread(context.thread.id);
      }
    } else {
      const lifecycle = action.action === "resolve"
        ? `\n<!-- pi-reviewer:status:v1 ${JSON.stringify({ findingId: pending.parentCommentId, targetSha: pending.headSha, status: "STILL_OPEN" })} -->`
        : "";
      const posted = await github.reply(repo, snapshot.pullRequest.number, pending.parentCommentId, `${replyMarker(pending.commentId, pending.parentCommentId, context.thread.id)}${lifecycle}\n${action.body}`);
      if (action.action === "resolve") {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) return false;
        await github.resolveThread(context.thread.id);
        const beforeUpdate = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeUpdate.head.sha !== pending.headSha) return false;
        await github.updateReviewComment(repo, snapshot.pullRequest.number, posted.id, posted.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'));
      }
    }
    return true;
  } catch (error) {
    console.warn(`[pi-reviewer] reply skipped after error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export interface ReplyRecoveryOptions {
  repo: string;
  pullRequest: PullRequest;
  identity: ReplyIdentity;
  github: ReplyClient;
  snapshot: ReplySnapshot;
  refreshSnapshot: () => Promise<ReplySnapshot>;
  thinking?: ThinkingLevel;
  piApiKey?: string;
  generate?: (options: Parameters<typeof generateReplyResponse>[0]) => Promise<unknown>;
}

/** Recovers one oldest unprocessed reply per unresolved root. */
export async function recoverPendingReplies(options: ReplyRecoveryOptions): Promise<number> {
  const pending = discoverPendingReplies(options.snapshot, options.identity);
  let recovered = 0;
  for (const reply of pending) {
    try {
      const snapshot = options.snapshot;
      if (snapshot.pullRequest.head.sha !== reply.headSha) continue;
      if (await handleReplyComment({ ...options, pending: reply, snapshot })) recovered++;
    } catch (error) {
      console.warn(`[pi-reviewer] reply recovery skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return recovered;
}

/** Handle one review-comment reply without entering the normal review path. */
export async function handleReply(options: ReplyHandlerOptions): Promise<boolean> {
  const { event, repo, pullRequest, identity, github } = options;
  if (!isAuthorizedReply(event) || event.actor?.login === identity.login || !Number.isSafeInteger(event.commentId) || !Number.isSafeInteger(event.parentCommentId) || (event.commentId ?? 0) <= 0 || (event.parentCommentId ?? 0) <= 0) return false;
  if (!event.headSha) return false;
  try {
    const snapshot = await fetchReplySnapshot(github, repo, event.pr!, pullRequest);
    const pending: PendingReply = { commentId: event.commentId as number, parentCommentId: event.parentCommentId as number, threadId: snapshot.threads.find(thread => thread.comments.nodes.some(comment => comment.id === event.parentCommentId))?.id ?? "", actor: event.actor ?? {}, headSha: event.headSha };
    return await handleReplyComment({ pending, repo, identity, github, snapshot, refreshSnapshot: () => fetchReplySnapshot(github, repo, event.pr!), thinking: options.thinking, piApiKey: options.piApiKey, generate: options.generate });
  } catch (error) {
    console.warn(`[pi-reviewer] reply skipped after error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
