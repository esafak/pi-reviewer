import { fetchReplySnapshot, recoverPendingReplies, type ReplyClient, type ReplyIdentity, type ReplySnapshot } from "./reply.js";
import type { PullRequest } from "./github.js";
import type { ThinkingLevel } from "../core/config.js";
import type { generateReplyResponse } from "./review.js";

export interface SynchronizeRecoveryOptions {
  repo: string;
  pullRequest: PullRequest;
  expectedHeadSha: string;
  identity: ReplyIdentity;
  github: ReplyClient;
  snapshot?: ReplySnapshot;
  thinking?: ThinkingLevel;
  piApiKey?: string;
  generate?: (options: Parameters<typeof generateReplyResponse>[0]) => Promise<unknown>;
}

/** Recovers conversation replies for a push while refusing stale PR heads. */
export async function recoverSynchronizeReplies(options: SynchronizeRecoveryOptions): Promise<number> {
  if (options.pullRequest.head.repo?.full_name !== options.repo || options.pullRequest.head.sha !== options.expectedHeadSha) {
    console.warn("[pi-reviewer] reply recovery skipped: PR head or repository changed");
    return 0;
  }
  const snapshot = options.snapshot ?? await fetchReplySnapshot(options.github, options.repo, options.pullRequest.number, options.pullRequest);
  if (snapshot.pullRequest.head.sha !== options.expectedHeadSha) {
    console.warn("[pi-reviewer] reply recovery skipped: snapshot head changed");
    return 0;
  }
  return recoverPendingReplies({
    ...options,
    snapshot,
    refreshSnapshot: () => fetchReplySnapshot(options.github, options.repo, options.pullRequest.number),
  });
}
