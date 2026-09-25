import { generateReplyResponse, parseReplyAction } from "./review.js";
import {
  decodeReplyMarker,
  decodeStatusMarker,
  isPiReviewerRootComment,
  replyMarker,
  type Event,
} from "./batch.js";
import type { PullRequest, ReviewComment, ReviewThread } from "./github.js";
import type { ThinkingLevel } from "../core/config.js";
import { log } from "./log.js";
import type { Logger } from "../logging/index.js";

export interface ReplyClient {
  listComments(repo: string, number: number): Promise<ReviewComment[]>;
  listThreads(repo: string, number: number): Promise<ReviewThread[]>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  getCollaboratorPermission(repo: string, login: string): Promise<string | undefined>;
  reply(repo: string, number: number, comment: number, body: string): Promise<ReviewComment>;
  updateReviewComment(
    repo: string,
    number: number,
    comment: number,
    body: string,
  ): Promise<ReviewComment>;
  resolveThread(threadId: string): Promise<unknown>;
  createReviewCommentReaction(
    repo: string,
    number: number,
    comment: number,
    content: string,
  ): Promise<{ id: number; content: string }>;
}

export interface ReplyIdentity {
  login: string;
}

export interface ReplySnapshot {
  pullRequest: PullRequest;
  comments: ReviewComment[];
  threads: ReviewThread[];
}

const AUTHORIZED_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Resolves which candidate reply authors hold write-level repository permission.
 * This is the single authority for reply authorization: GitHub's `author_association`
 * is unreliable in Actions payloads (an org owner can be reported as CONTRIBUTOR)
 * and is computed per request, so it must not gate replies by itself. Fails closed.
 */
export async function resolveAuthorizedLogins(
  github: ReplyClient,
  repo: string,
  logins: Iterable<string>,
  logger: Logger = log,
): Promise<ReadonlySet<string>> {
  const authorized = new Set<string>();
  for (const login of new Set(logins)) {
    if (!login) continue;
    try {
      const permission = await github.getCollaboratorPermission(repo, login);
      if (permission && AUTHORIZED_PERMISSIONS.has(permission)) authorized.add(login);
      else
        logger.warn("reply.permission.denied", "Reply author lacks write permission; ignoring", {
          login,
          permission: permission ?? "unknown",
        });
    } catch (error) {
      logger.warn("reply.permission.lookup_failed", "Could not resolve permission; denying reply", {
        login,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return authorized;
}

/** Distinct human authors of direct replies to pi-reviewer findings in this snapshot. */
function candidateReplyAuthors(snapshot: ReplySnapshot, identity: ReplyIdentity): string[] {
  // Mirror discovery's skip of thread-less and resolved roots so the permission
  // lookup only covers roots that can actually yield a pending reply.
  const actionableCommentIds = new Set(
    snapshot.threads.flatMap((thread) =>
      thread.isResolved ? [] : thread.comments.nodes.map((node) => node.id),
    ),
  );
  const rootIds = new Set(
    snapshot.comments
      .filter(
        (comment) =>
          comment.id > 0 &&
          comment.user?.login === identity.login &&
          isPiReviewerRootComment(comment) &&
          actionableCommentIds.has(comment.id),
      )
      .map((comment) => comment.id),
  );
  const logins = new Set<string>();
  for (const comment of snapshot.comments) {
    if (comment.in_reply_to_id == null || !rootIds.has(comment.in_reply_to_id)) continue;
    const login = comment.user?.login;
    if (login && login !== identity.login && comment.user?.type !== "Bot") logins.add(login);
  }
  return [...logins];
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
  logger?: Logger;
}

export interface ReplyCommentOptions {
  pending: PendingReply;
  repo: string;
  identity: ReplyIdentity;
  github: ReplyClient;
  snapshot: ReplySnapshot;
  refreshSnapshot: () => Promise<ReplySnapshot>;
  authorizedLogins: ReadonlySet<string>;
  thinking?: ThinkingLevel;
  piApiKey?: string;
  generate?: (options: Parameters<typeof generateReplyResponse>[0]) => Promise<unknown>;
  logger?: Logger;
}

function isPendingReplyAuthorized(
  reply: PendingReply,
  identity: ReplyIdentity,
  authorizedLogins: ReadonlySet<string>,
): boolean {
  const login = reply.actor.login;
  return (
    reply.actor.type !== "Bot" &&
    login !== undefined &&
    login !== identity.login &&
    authorizedLogins.has(login)
  );
}

function findReplyContext(snapshot: ReplySnapshot, pending: PendingReply, identity: ReplyIdentity) {
  const parent = snapshot.comments.find((c) => c.id === pending.parentCommentId);
  const triggering = snapshot.comments.find((c) => c.id === pending.commentId);
  const thread = snapshot.threads.find((t) => t.id === pending.threadId);
  if (!parent || !triggering || !thread || thread.isResolved) return undefined;
  if (
    triggering.user?.login !== pending.actor.login ||
    triggering.in_reply_to_id !== pending.parentCommentId
  )
    return undefined;
  if (!isPiReviewerRootComment(parent) || parent.user?.login !== identity.login) return undefined;
  return { parent, triggering, thread };
}

function sameReplyMarker(comment: ReviewComment, pending: PendingReply): boolean {
  const marker = decodeReplyMarker(comment.body);
  return (
    comment.user?.login !== undefined &&
    marker?.commentId === pending.commentId &&
    marker.parentId === pending.parentCommentId &&
    marker.threadId === pending.threadId
  );
}

function recoverableMarker(comment: ReviewComment, pending: PendingReply): boolean {
  if (!sameReplyMarker(comment, pending)) return false;
  const status = decodeStatusMarker(comment.body);
  return (
    status?.targetSha === pending.headSha && ["STILL_OPEN", "RESOLVED"].includes(status.status)
  );
}

/** Finds the oldest unprocessed direct human reply for each unresolved finding root. */
export function discoverPendingReplies(
  snapshot: ReplySnapshot,
  identity: ReplyIdentity,
  authorizedLogins: ReadonlySet<string>,
  logger: Logger = log,
): PendingReply[] {
  const threadByComment = new Map(
    snapshot.threads.flatMap((thread) =>
      thread.comments.nodes.map((comment) => [comment.id, thread] as const),
    ),
  );
  const roots = snapshot.comments.filter(
    (comment) =>
      comment.id > 0 && comment.user?.login === identity.login && isPiReviewerRootComment(comment),
  );
  const pending: PendingReply[] = [];
  let replyCount = 0;
  let authorizedReplyCount = 0;
  for (const root of roots) {
    const thread = threadByComment.get(root.id);
    if (!thread || thread.isResolved) continue;
    const replies = snapshot.comments
      .filter((comment) => comment.in_reply_to_id === root.id && comment.id > 0)
      .filter((comment) => {
        replyCount++;
        const login = comment.user?.login;
        const authorized =
          comment.user?.type !== "Bot" &&
          login !== undefined &&
          login !== identity.login &&
          authorizedLogins.has(login);
        if (authorized) {
          authorizedReplyCount++;
          logger.info("reply.authorized", "Reply author is authorized", {
            commentId: comment.id,
            login: login ?? "unknown",
            association: comment.author_association ?? "unknown",
          });
        } else if (comment.user?.type !== "Bot" && login !== identity.login)
          logger.warn("reply.not_authorized", "Reply author is not authorized", {
            commentId: comment.id,
            login: login ?? "unknown",
            association: comment.author_association ?? "unknown",
          });
        return authorized;
      })
      .sort(
        (a, b) =>
          (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0) ||
          a.id - b.id,
      );
    const candidate = replies.find((reply) => {
      const marker = snapshot.comments.find(
        (botReply) =>
          botReply.user?.login === identity.login &&
          sameReplyMarker(botReply, {
            commentId: reply.id,
            parentCommentId: root.id,
            threadId: thread.id,
            actor: {
              login: reply.user?.login,
              association: reply.author_association,
              type: reply.user?.type,
            },
            headSha: snapshot.pullRequest.head.sha,
          }),
      );
      return (
        !marker ||
        recoverableMarker(marker, {
          commentId: reply.id,
          parentCommentId: root.id,
          threadId: thread.id,
          actor: {
            login: reply.user?.login,
            association: reply.author_association,
            type: reply.user?.type,
          },
          headSha: snapshot.pullRequest.head.sha,
        })
      );
    });
    if (candidate)
      pending.push({
        commentId: candidate.id,
        parentCommentId: root.id,
        threadId: thread.id,
        actor: {
          login: candidate.user?.login,
          association: candidate.author_association,
          type: candidate.user?.type,
        },
        headSha: snapshot.pullRequest.head.sha,
      });
  }
  logger.info("reply.discovery.completed", "Reply discovery completed", {
    roots: roots.length,
    replies: replyCount,
    authors: authorizedLogins.size,
    authorizedReplies: authorizedReplyCount,
    pending: pending.length,
  });
  return pending;
}

export async function fetchReplySnapshot(
  github: ReplyClient,
  repo: string,
  number: number,
  pullRequest?: PullRequest,
): Promise<ReplySnapshot> {
  const [current, comments, threads] = await Promise.all([
    pullRequest ? Promise.resolve(pullRequest) : github.getPullRequest(repo, number),
    github.listComments(repo, number),
    github.listThreads(repo, number),
  ]);
  return { pullRequest: current, comments, threads };
}

/** Handles one discovered reply using the same semantics as the webhook fast path. */
export async function handleReplyComment(options: ReplyCommentOptions): Promise<boolean> {
  const { pending, repo, identity, github } = options;
  const logger = options.logger ?? log;
  if (!isPendingReplyAuthorized(pending, identity, options.authorizedLogins)) {
    logger.warn("reply.comment.not_authorized", "Reply is not authorized; ignoring", {
      commentId: pending.commentId,
      login: pending.actor.login ?? "unknown",
    });
    return false;
  }
  try {
    let snapshot = options.snapshot;
    let context = findReplyContext(snapshot, pending, identity);
    if (!context) {
      logger.warn("reply.context.unavailable", "Reply has no usable context; ignoring", {
        commentId: pending.commentId,
      });
      return false;
    }
    if (snapshot.pullRequest.head.sha !== pending.headSha) {
      logger.warn("reply.head_changed", "PR head moved before handling reply", {
        commentId: pending.commentId,
        expectedHeadSha: pending.headSha,
        actualHeadSha: snapshot.pullRequest.head.sha,
      });
      return false;
    }
    snapshot = await options.refreshSnapshot();
    context = findReplyContext(snapshot, pending, identity);
    if (!context) {
      logger.warn("reply.context.disappeared", "Reply context disappeared on refresh; ignoring", {
        commentId: pending.commentId,
      });
      return false;
    }
    if (snapshot.pullRequest.head.sha !== pending.headSha) {
      logger.warn("reply.head_changed", "PR head moved on refresh", {
        commentId: pending.commentId,
        expectedHeadSha: pending.headSha,
        actualHeadSha: snapshot.pullRequest.head.sha,
      });
      return false;
    }
    const { parent, triggering, thread } = context;
    const existingReply = snapshot.comments.find(
      (comment) => comment.user?.login === identity.login && sameReplyMarker(comment, pending),
    );
    if (existingReply) {
      const existingStatus = decodeStatusMarker(existingReply.body);
      if (
        !existingStatus ||
        existingStatus.targetSha !== pending.headSha ||
        !["STILL_OPEN", "RESOLVED"].includes(existingStatus.status)
      ) {
        logger.warn("reply.marker.unrecoverable", "Existing reply marker is not recoverable", {
          commentId: pending.commentId,
          headSha: pending.headSha,
        });
        return false;
      }
      if (existingStatus.status === "STILL_OPEN") {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before resolving an existing reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeResolve.head.sha,
          });
          return false;
        }
        await github.resolveThread(thread.id);
        const beforeUpdate = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeUpdate.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before updating an existing reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeUpdate.head.sha,
          });
          return false;
        }
        await github.updateReviewComment(
          repo,
          snapshot.pullRequest.number,
          existingReply.id,
          existingReply.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'),
        );
      } else {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before resolving an existing reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeResolve.head.sha,
          });
          return false;
        }
        await github.resolveThread(thread.id);
      }
      return true;
    }
    const nearby = snapshot.comments
      .filter((comment) => thread.comments.nodes.some((node) => node.id === comment.id))
      .sort((a, b) => a.id - b.id)
      .slice(-12)
      .map((comment) => `${comment.user?.login ?? "unknown"}: ${comment.body}`)
      .join("\n");
    const action = parseReplyAction(
      await (options.generate ?? generateReplyResponse)({
        parent: parent.body,
        userReply: triggering.body,
        thread: nearby,
        thinking: options.thinking,
        piApiKey: options.piApiKey,
      }),
    );
    if (!action) {
      logger.warn("reply.model.no_action", "Model returned no actionable response", {
        commentId: pending.commentId,
      });
      return false;
    }
    snapshot = await options.refreshSnapshot();
    context = findReplyContext(snapshot, pending, identity);
    if (!context) {
      logger.warn(
        "reply.context.disappeared",
        "Reply context disappeared before posting; ignoring",
        { commentId: pending.commentId },
      );
      return false;
    }
    if (snapshot.pullRequest.head.sha !== pending.headSha) {
      logger.warn("reply.head_changed", "PR head moved before posting reply", {
        commentId: pending.commentId,
        expectedHeadSha: pending.headSha,
        actualHeadSha: snapshot.pullRequest.head.sha,
      });
      return false;
    }
    const freshReply = snapshot.comments.find(
      (comment) => comment.user?.login === identity.login && sameReplyMarker(comment, pending),
    );
    if (action.action === "react") {
      const beforeReaction = await github.getPullRequest(repo, snapshot.pullRequest.number);
      if (beforeReaction.head.sha !== pending.headSha) {
        logger.warn("reply.head_changed", "PR head moved before reacting", {
          commentId: pending.commentId,
          expectedHeadSha: pending.headSha,
          actualHeadSha: beforeReaction.head.sha,
        });
        return false;
      }
      await github.createReviewCommentReaction(
        repo,
        snapshot.pullRequest.number,
        pending.commentId,
        action.content,
      );
    } else if (freshReply) {
      const freshStatus = decodeStatusMarker(freshReply.body);
      if (
        action.action !== "resolve" ||
        !freshStatus ||
        freshStatus.targetSha !== pending.headSha ||
        !["STILL_OPEN", "RESOLVED"].includes(freshStatus.status)
      ) {
        logger.warn("reply.marker.unrecoverable", "Fresh reply marker is not recoverable", {
          commentId: pending.commentId,
          headSha: pending.headSha,
        });
        return false;
      }
      if (freshStatus.status === "STILL_OPEN") {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before resolving a fresh reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeResolve.head.sha,
          });
          return false;
        }
        await github.resolveThread(context.thread.id);
        const beforeUpdate = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeUpdate.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before updating a fresh reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeUpdate.head.sha,
          });
          return false;
        }
        await github.updateReviewComment(
          repo,
          snapshot.pullRequest.number,
          freshReply.id,
          freshReply.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'),
        );
      } else {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before resolving a fresh reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeResolve.head.sha,
          });
          return false;
        }
        await github.resolveThread(context.thread.id);
      }
    } else {
      const lifecycle =
        action.action === "resolve"
          ? `\n<!-- pi-reviewer:status:v1 ${JSON.stringify({ findingId: pending.parentCommentId, targetSha: pending.headSha, status: "STILL_OPEN" })} -->`
          : "";
      const posted = await github.reply(
        repo,
        snapshot.pullRequest.number,
        pending.parentCommentId,
        `${replyMarker(pending.commentId, pending.parentCommentId, context.thread.id)}${lifecycle}\n${action.body}`,
      );
      if (action.action === "resolve") {
        const beforeResolve = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeResolve.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before resolving the posted reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeResolve.head.sha,
          });
          return false;
        }
        await github.resolveThread(context.thread.id);
        const beforeUpdate = await github.getPullRequest(repo, snapshot.pullRequest.number);
        if (beforeUpdate.head.sha !== pending.headSha) {
          logger.warn("reply.head_changed", "PR head moved before updating the posted reply", {
            commentId: pending.commentId,
            expectedHeadSha: pending.headSha,
            actualHeadSha: beforeUpdate.head.sha,
          });
          return false;
        }
        await github.updateReviewComment(
          repo,
          snapshot.pullRequest.number,
          posted.id,
          posted.body.replace(/"status":"STILL_OPEN"/, '"status":"RESOLVED"'),
        );
      }
    }
    return true;
  } catch (error) {
    logger.warn("reply.failed", "Reply skipped after error", {
      commentId: pending.commentId,
      error: error instanceof Error ? error.message : String(error),
    });
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
  authorizedLogins?: ReadonlySet<string>;
  thinking?: ThinkingLevel;
  piApiKey?: string;
  generate?: (options: Parameters<typeof generateReplyResponse>[0]) => Promise<unknown>;
  logger?: Logger;
}

/** Recovers one oldest unprocessed reply per unresolved root. */
export async function recoverPendingReplies(options: ReplyRecoveryOptions): Promise<number> {
  const logger = options.logger ?? log;
  const authorizedLogins =
    options.authorizedLogins ??
    (await resolveAuthorizedLogins(
      options.github,
      options.repo,
      candidateReplyAuthors(options.snapshot, options.identity),
      logger,
    ));
  const pending = discoverPendingReplies(
    options.snapshot,
    options.identity,
    authorizedLogins,
    logger,
  );
  let recovered = 0;
  for (const reply of pending) {
    try {
      const snapshot = options.snapshot;
      if (snapshot.pullRequest.head.sha !== reply.headSha) {
        logger.warn("reply.head_changed", "PR head changed before recovery", {
          commentId: reply.commentId,
          expectedHeadSha: reply.headSha,
          actualHeadSha: snapshot.pullRequest.head.sha,
        });
        continue;
      }
      if (
        await handleReplyComment({ ...options, logger, authorizedLogins, pending: reply, snapshot })
      )
        recovered++;
    } catch (error) {
      logger.warn("reply.recovery.failed", "Reply recovery skipped after error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (pending.length > 0)
    logger.info("reply.recovery.completed", "Reply recovery completed", {
      pending: pending.length,
      recovered,
    });
  return recovered;
}

/** Handle one review-comment reply without entering the normal review path. */
export async function handleReply(options: ReplyHandlerOptions): Promise<boolean> {
  const { event, repo, pullRequest, identity, github } = options;
  const logger = options.logger ?? log;
  // Log before any bail so the fast path identifies the event it handled even
  // when it ends without side effects.
  logger.info("reply.event.received", "Reply event received", {
    kind: event.kind,
    commentId: event.commentId,
    parentCommentId: event.parentCommentId,
    author: event.actor?.login ?? "unknown",
    actorType: event.actor?.type ?? "unknown",
    headSha: event.headSha ?? "none",
  });
  if (event.kind !== "reply") {
    logger.warn("reply.event.ignored", "Unexpected event kind", { kind: event.kind });
    return false;
  }
  if (event.actor?.type === "Bot") {
    logger.info("reply.event.ignored", "Reply author is a bot");
    return false;
  }
  if (!event.actor?.login) {
    logger.warn("reply.event.ignored", "Reply event has no actor login");
    return false;
  }
  if (event.actor.login === identity.login) {
    logger.info("reply.event.ignored", "Reply author is the reviewer itself");
    return false;
  }
  if (
    !Number.isSafeInteger(event.commentId) ||
    !Number.isSafeInteger(event.parentCommentId) ||
    (event.commentId ?? 0) <= 0 ||
    (event.parentCommentId ?? 0) <= 0
  ) {
    logger.warn("reply.event.invalid_comment_ids", "Reply event has invalid comment IDs", {
      commentId: event.commentId,
      parentCommentId: event.parentCommentId,
    });
    return false;
  }
  if (!event.headSha) {
    logger.warn("reply.event.ignored", "Reply event has no head SHA");
    return false;
  }
  const authorizedLogins = await resolveAuthorizedLogins(github, repo, [event.actor.login], logger);
  if (!authorizedLogins.has(event.actor.login)) {
    logger.warn("reply.event.ignored", "Reply author is not authorized", {
      login: event.actor.login,
    });
    return false;
  }
  try {
    const snapshot = await fetchReplySnapshot(github, repo, event.pr!, pullRequest);
    const pending: PendingReply = {
      commentId: event.commentId as number,
      parentCommentId: event.parentCommentId as number,
      threadId:
        snapshot.threads.find((thread) =>
          thread.comments.nodes.some((comment) => comment.id === event.parentCommentId),
        )?.id ?? "",
      actor: event.actor ?? {},
      headSha: event.headSha,
    };
    return await handleReplyComment({
      pending,
      repo,
      identity,
      github,
      snapshot,
      authorizedLogins,
      refreshSnapshot: () => fetchReplySnapshot(github, repo, event.pr!),
      thinking: options.thinking,
      piApiKey: options.piApiKey,
      generate: options.generate,
      logger,
    });
  } catch (error) {
    logger.warn("reply.failed", "Reply skipped after error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
