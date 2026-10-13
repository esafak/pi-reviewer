import { GitHubClient } from "./github.js";
import { upsertPrSummaryBlock } from "../core/output.js";
import { log } from "./log.js";
import type { SummaryOverview } from "./review.js";

export interface SummaryRegenerationTarget {
  kind: "review" | "issue";
  /** Review ID when kind is "review". */
  reviewId?: number;
  /** Issue comment ID when kind is "issue". */
  issueCommentId?: number;
}

/** Narrowed client surface; structurally satisfied by GitHubClient and test fakes. */
export type SummaryGitHubClient = Pick<
  GitHubClient,
  "getPullRequest" | "getReview" | "updateReview" | "updateIssueComment" | "request"
>;

export type SummaryRegenerationOutcome = "updated" | "head-changed" | "no-overview";

/**
 * Applies a regenerated overview to the first bodied review or issue comment.
 * Re-fetches the target body immediately before mutating (heads may have
 * moved during generation), replaces or inserts only the summary block, and
 * leaves batch markers and body-finding markers byte-identical.
 */
export async function applySummaryRegeneration(options: {
  github: SummaryGitHubClient;
  repo: string;
  prNumber: number;
  headSha: string;
  target: SummaryRegenerationTarget;
  overview: SummaryOverview;
  rangeLabel: string;
}): Promise<SummaryRegenerationOutcome> {
  if (!options.overview.pr_summary?.trim()) {
    log.warn(
      "summary_regenerate.empty",
      "Summary pass returned no overview; leaving body unchanged",
    );
    return "no-overview";
  }
  const current = await options.github.getPullRequest(options.repo, options.prNumber);
  if (current.head.sha !== options.headSha) {
    log.warn(
      "summary_regenerate.head_changed",
      "PR head changed during summary regeneration; leaving first review unchanged",
    );
    return "head-changed";
  }
  const freshBody =
    options.target.kind === "review"
      ? ((await options.github.getReview(options.repo, options.prNumber, options.target.reviewId!))
          .body ?? "")
      : ((
          (await options.github.request<{ body?: string }>(
            `/repos/${options.repo}/issues/comments/${options.target.issueCommentId}`,
          )) as { body?: string }
        ).body ?? "");
  const updated = upsertPrSummaryBlock(
    freshBody,
    options.overview.pr_summary,
    options.overview.pr_diagram,
    options.rangeLabel,
  );
  if (options.target.kind === "review")
    await options.github.updateReview(
      options.repo,
      options.prNumber,
      options.target.reviewId!,
      updated,
    );
  else
    await options.github.updateIssueComment(
      options.repo,
      options.prNumber,
      options.target.issueCommentId!,
      updated,
    );
  log.info("summary_regenerate.updated", "Regenerated PR summary on first review", {
    pullRequest: options.prNumber,
  });
  return "updated";
}
