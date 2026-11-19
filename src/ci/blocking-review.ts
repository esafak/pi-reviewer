import type { Severity } from "../core/severity.js";

/** The review fields the gate reads, narrowed so callers can pass raw API data. */
export interface BlockingReview {
  id: number;
  state?: string;
  user?: { login?: string };
}

export interface BlockingReviewClient {
  getUser(): Promise<{ login: string }>;
  listReviews(repo: string, number: number): Promise<BlockingReview[]>;
  getPullRequest(repo: string, number: number): Promise<{ head: { sha: string } }>;
  dismissReview(repo: string, number: number, review: number, message: string): Promise<unknown>;
}

/** A finding that would justify a changes-requested review. */
export interface BlockingFinding {
  commentId?: number;
  severity?: Severity;
}

/**
 * Findings that warrant a block: a CRITICAL posted by the current run, or an
 * unresolved CRITICAL carried over. A finding whose severity is unknown counts
 * too — withdrawing a gate on a guess would clear a block the reviewer cannot
 * vouch for.
 */
export function blockingFindings(
  open: ReadonlyArray<BlockingFinding>,
  posted: ReadonlyArray<{ severity: Severity }>,
): BlockingFinding[] {
  return [
    ...posted.filter((finding) => finding.severity === "CRITICAL"),
    ...open.filter((finding) => finding.severity !== "WARN" && finding.severity !== "INFO"),
  ];
}

export function hasBlockingFindings(
  open: ReadonlyArray<BlockingFinding>,
  posted: ReadonlyArray<{ severity: Severity }>,
): boolean {
  return blockingFindings(open, posted).length > 0;
}

/** Human-readable list of what keeps the block standing, for the run log. */
export function describeBlockingFindings(findings: ReadonlyArray<BlockingFinding>): string {
  return findings
    .map((finding) =>
      finding.commentId === undefined
        ? `new ${finding.severity ?? "unknown-severity"} finding`
        : `#${finding.commentId} ${finding.severity ?? "severity unknown"}`,
    )
    .join(", ");
}

/**
 * Ids of the reviewer's own changes-requested reviews as they stand right now.
 *
 * Callers snapshot this *before* posting anything: a review created after this
 * point belongs to a newer finding enumeration than the one being acted on, so
 * it must survive the withdrawal. A read that fails yields `undefined`, which
 * withdraws nothing.
 */
export async function listOwnBlockingReviews(options: {
  client: BlockingReviewClient;
  repo: string;
  prNumber: number;
}): Promise<number[] | undefined> {
  const { client, repo, prNumber } = options;
  try {
    const identity = await client.getUser();
    const reviews = await client.listReviews(repo, prNumber);
    const login = identity.login.toLowerCase();
    const outstanding = reviews.filter((review) => review.state === "CHANGES_REQUESTED");
    const own = outstanding
      .filter((review) => review.user?.login?.toLowerCase() === login)
      .map((review) => review.id);
    if (own.length === 0 && outstanding.length > 0) {
      // The common cause is an identity or token change: the gate is standing
      // but under a login this run cannot dismiss, and it will never clear
      // itself. Say so, or the next person to hit a stuck PR has nothing.
      const authors = [...new Set(outstanding.map((review) => review.user?.login ?? "unknown"))];
      console.log(
        `[pi-reviewer] no own changes-requested review to withdraw; the standing block was raised by ${authors.join(", ")}`,
      );
    }
    return own;
  } catch (error) {
    console.warn(
      `[pi-reviewer] could not read the PR's review state: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Withdraws the given changes-requested reviews.
 *
 * GitHub keeps a changes-requested review blocking until the reviewer that
 * submitted it approves or dismisses it; a later comment review does not
 * supersede it. Resolving the threads and marking the findings RESOLVED
 * therefore leaves the PR blocked, so the reviewer has to withdraw the review
 * itself. Every step is best-effort: a gate that fails to close must not fail
 * the review that already posted.
 *
 * The handed ids are re-checked against the reviews standing right now: a block
 * that appeared since the snapshot reflects a newer finding enumeration than the
 * one being acted on, so it aborts the withdrawal instead of being swept up.
 */
export async function withdrawBlockingReviews(options: {
  client: BlockingReviewClient;
  repo: string;
  prNumber: number;
  reviewIds: readonly number[];
  message: string;
  /** Commit the finding state was computed for; a moved head aborts the withdrawal. */
  expectedHeadSha?: string;
}): Promise<number> {
  const { client, repo, prNumber, reviewIds } = options;
  const handed = new Set(reviewIds);
  if (handed.size === 0) return 0;
  try {
    const current = await listOwnBlockingReviews({ client, repo, prNumber });
    if (current === undefined) return 0;
    if (current.some((reviewId) => !handed.has(reviewId))) {
      console.warn(
        "[pi-reviewer] a changes-requested review appeared after this run read the findings; leaving the block standing",
      );
      return 0;
    }
    if (options.expectedHeadSha) {
      const pullRequest = await client.getPullRequest(repo, prNumber);
      if (pullRequest.head.sha !== options.expectedHeadSha) {
        console.warn(
          "[pi-reviewer] PR head changed before the block could be withdrawn; leaving it standing",
        );
        return 0;
      }
    }
    let withdrawn = 0;
    // Dismiss only what still stands: a review resolved by someone else in the
    // meantime needs no withdrawal and would only produce a failed request.
    for (const reviewId of reviewIds) {
      if (!current.includes(reviewId)) continue;
      try {
        await client.dismissReview(repo, prNumber, reviewId, options.message);
        withdrawn += 1;
      } catch (error) {
        console.warn(
          `[pi-reviewer] could not withdraw changes-requested review ${reviewId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (withdrawn > 0)
      console.log(
        `[pi-reviewer] withdrew ${withdrawn} changes-requested review(s) — no unresolved CRITICAL findings remain`,
      );
    return withdrawn;
  } catch (error) {
    console.warn(
      `[pi-reviewer] could not check the PR head before withdrawing: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}
