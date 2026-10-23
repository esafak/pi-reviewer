import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseSummaryFlag,
  parseThinkingLevel,
  resolveExtraInstructions,
  review,
  type ReviewOptions,
} from "./review.js";
import { applySummaryRegeneration } from "./summary-command.js";
import { COMMAND_HINT_FOOTER, prSummaryRangeLabel, stripPrSummaryBlock } from "../core/output.js";
import { GitHubClient, type PullRequest } from "./github.js";
import {
  collectFindingHistory,
  decodeBatchMarker,
  encodeBatchMarker,
  isAuthorizedReviewCommand,
  isAuthorizedSummaryCommand,
  isEventRangeConsistent,
  isFirstBodiedReview,
  isRenovatePullRequest,
  isSafePullRequestNumber,
  normalizeEvent,
  selectAuthenticatedBatchMarkers,
  selectBatchRange,
  selectFirstBodiedSource,
  selectSummaryRegenerateRange,
  type BatchKind,
  type Event,
} from "./batch.js";
import { fetchReplySnapshot, handleReply } from "./reply.js";
import { recoverSynchronizeReplies } from "./recovery.js";
import { loadMcpConfigFromBase, resolveDefaultBranchSha, type CiMcpConfig } from "./mcp-config.js";
import { loadLspOverridesFromBase, type LspServerOverrides } from "../core/lsp/config.js";
import { log } from "./log.js";
import { assertModeImplemented, parseMode, type Mode } from "./mode.js";
import { withDependencyCheckRun } from "./check-run.js";
import { runDependencyCheck } from "./dependency-check.js";

async function readEvent(): Promise<unknown> {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}
function ancestor(from: string, to: string, cwd = process.cwd()): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", from, to], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function hasCommit(sha: string, cwd = process.cwd()): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function isMergeCommit(sha: string, cwd = process.cwd()): boolean {
  try {
    const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", sha], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split(/\s+/);
    return parents.length >= 3;
  } catch {
    return false;
  }
}
// An incremental range spanning a merge imports the merged branch history, so
// the range must fall back to the merge-base diff which holds PR-only changes.
function rangeContainsMerge(from: string, to: string, cwd = process.cwd()): boolean {
  try {
    const count = execFileSync("git", ["rev-list", "--count", "--merges", `${from}..${to}`], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return Number.parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}
function gitAuthArgs(): string[] {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return [];
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [
    "-c",
    "http.https://github.com/.extraheader=",
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
  ];
}
function ensureCommit(sha: string, ref: string | undefined, cwd = process.cwd()): void {
  if (hasCommit(sha, cwd)) return;
  if (ref) {
    try {
      execFileSync("git", [...gitAuthArgs(), "fetch", "--no-tags", "origin", ref], { cwd });
    } catch {
      /* try the authenticated SHA below */
    }
  }
  if (!hasCommit(sha, cwd)) {
    execFileSync("git", [...gitAuthArgs(), "fetch", "--no-tags", "origin", `+${sha}`], { cwd });
  }
  if (!hasCommit(sha, cwd)) throw new Error(`Git commit ${sha} is unavailable after fetching`);
}

function isShallowRepository(cwd = process.cwd()): boolean {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

function unshallowRepository(cwd = process.cwd()): void {
  execFileSync("git", [...gitAuthArgs(), "fetch", "--unshallow", "--no-tags", "origin"], { cwd });
}

function repositoryDefaultBranch(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const repository = (payload as Record<string, unknown>).repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) return undefined;
  const branch = (repository as Record<string, unknown>).default_branch;
  return typeof branch === "string" ? branch : undefined;
}

/** Everything both modes read off the authenticated event and pull request. */
interface ModeContext {
  payload: unknown;
  event: Event;
  /** The event kind, narrowed past the reply branch: a reply never reaches a mode. */
  kind: BatchKind;
  /** The pull request number, validated before a mode runs. */
  prNumber: number;
  repo: string;
  token: string;
  github: GitHubClient;
  pullRequest: PullRequest;
  identity: { login: string };
}

/** The checkout both modes analyze, and the configuration that shapes it. */
interface PreparedEnvironment {
  /** The detached worktree at the analyzed head. */
  worktree: string;
  /** The trusted default-branch worktree MCP servers run in, when one is needed. */
  trustedMcpWorktree?: string;
  mcpConfig?: CiMcpConfig;
  lspOverrides: LspServerOverrides;
  /** Removes both worktrees; safe to call once. */
  cleanup(): Promise<void>;
}

/** The commits a mode analyzes, once they are local. */
interface PreparedCommits {
  /** The merge base of the pull request; the analyzed range starts here. */
  mergeBase: string;
}

/** What fetching the analyzed commits needs. */
interface CommitOptions {
  pullRequest: PullRequest;
  pullRequestNumber: number;
  /** The commit the analysis reviews: the authenticated head, or a dispatch target. */
  head: string;
}

/** What creating the analyzed worktree needs. */
interface WorktreeOptions {
  payload: unknown;
  /** The commit the analysis reviews: the authenticated head, or a dispatch target. */
  head: string;
}

/**
 * Fetches the analyzed head and base and computes their merge base.
 *
 * This runs before any ancestry, merge, or range decision a mode makes: the
 * default-branch checkout used by issue-comment and dispatch events may not
 * have the PR ref in its fetch refspec, and a decision taken over a commit
 * that is not local is a decision taken over the wrong range.
 */
function prepareCommits(options: CommitOptions): PreparedCommits {
  const { pullRequest, pullRequestNumber, head } = options;
  ensureCommit(head, `refs/pull/${pullRequestNumber}/head`);
  ensureCommit(pullRequest.base.sha, undefined);
  let mergeBase = pullRequest.base.sha;
  try {
    mergeBase =
      execFileSync("git", ["merge-base", pullRequest.base.sha, head], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim() || mergeBase;
  } catch {
    if (isShallowRepository()) {
      log.info(
        "review.history.unshallow",
        "Merge-base unavailable in shallow checkout; fetching full history once",
      );
      try {
        unshallowRepository();
        mergeBase =
          execFileSync("git", ["merge-base", pullRequest.base.sha, head], {
            cwd: process.cwd(),
            encoding: "utf8",
          }).trim() || mergeBase;
      } catch {
        log.warn(
          "review.merge_base.unavailable",
          "Could not compute merge-base after unshallow fetch; using PR base SHA",
        );
      }
    } else {
      log.warn("review.merge_base.unavailable", "Could not compute merge-base; using PR base SHA");
    }
  }

  return { mergeBase };
}

/**
 * Creates the checkout and configuration a mode runs against.
 *
 * Both modes get exactly the same preparation: a detached worktree at the
 * analyzed head, and the trusted MCP and LSP configuration loaded from the
 * default branch. The extraction keeps the analyzed-head worktree and the
 * trusted default-branch worktree separate, because a changelog the model
 * reads must come from the head — never from the branch the configuration was
 * trusted from.
 */
async function prepareWorktree(options: WorktreeOptions): Promise<PreparedEnvironment> {
  const { payload, head } = options;
  const mcpConfigPath = process.env.PI_REVIEWER_MCP_CONFIG_FILE;
  let mcpConfig: CiMcpConfig | undefined;
  let trustedDefaultBranchSha: string | undefined;
  if (mcpConfigPath?.trim()) {
    const defaultBranch = repositoryDefaultBranch(payload);
    if (!defaultBranch)
      throw new Error("Cannot load mcp-config-file: repository default branch is unavailable");
    trustedDefaultBranchSha = resolveDefaultBranchSha(process.cwd(), defaultBranch, gitAuthArgs());
    mcpConfig = loadMcpConfigFromBase(process.cwd(), trustedDefaultBranchSha, mcpConfigPath);
  }
  const lspConfigPath = process.env.PI_REVIEWER_LSP_CONFIG_FILE;
  let lspOverrides: LspServerOverrides = {};
  if (lspConfigPath?.trim()) {
    if (!trustedDefaultBranchSha) {
      const defaultBranch = repositoryDefaultBranch(payload);
      if (!defaultBranch)
        throw new Error("Cannot load lsp-config-file: repository default branch is unavailable");
      trustedDefaultBranchSha = resolveDefaultBranchSha(
        process.cwd(),
        defaultBranch,
        gitAuthArgs(),
      );
    }
    lspOverrides = loadLspOverridesFromBase(process.cwd(), trustedDefaultBranchSha, lspConfigPath);
  }

  const worktree = await mkdtemp(path.join(tmpdir(), "pi-reviewer-"));
  let trustedMcpWorktree: string | undefined;
  const cleanup = async (): Promise<void> => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
    } catch {
      await rm(worktree, { recursive: true, force: true });
    }
    if (trustedMcpWorktree) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", trustedMcpWorktree], {
          cwd: process.cwd(),
          stdio: "ignore",
        });
      } catch {
        await rm(trustedMcpWorktree, { recursive: true, force: true });
      }
    }
  };
  try {
    if (
      mcpConfig &&
      trustedDefaultBranchSha &&
      Object.values(mcpConfig.mcpServers).some((server) => typeof server.command === "string")
    ) {
      trustedMcpWorktree = await mkdtemp(path.join(tmpdir(), "pi-reviewer-mcp-trusted-"));
      execFileSync(
        "git",
        ["worktree", "add", "--detach", trustedMcpWorktree, trustedDefaultBranchSha],
        { cwd: process.cwd() },
      );
    }
    execFileSync("git", ["worktree", "add", "--detach", worktree, head], { cwd: process.cwd() });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    worktree,
    ...(trustedMcpWorktree ? { trustedMcpWorktree } : {}),
    ...(mcpConfig ? { mcpConfig } : {}),
    lspOverrides,
    cleanup,
  };
}

/** The review options both modes share: the run's inputs and its trusted configuration. */
function sharedReviewOptions(environment: PreparedEnvironment, context: ModeContext) {
  const minSeverityRaw = process.env.MIN_SEVERITY?.toUpperCase();
  const minSeverity =
    minSeverityRaw === "CRITICAL" || minSeverityRaw === "WARN" || minSeverityRaw === "INFO"
      ? minSeverityRaw
      : undefined;
  return {
    cwd: environment.worktree,
    output: "comment" as const,
    githubToken: context.token,
    repo: context.repo,
    minSeverity,
    thinking: parseThinkingLevel(process.env.PI_REVIEWER_THINKING),
    debug: process.env.PI_REVIEWER_DEBUG === "true",
    piApiKey: process.env.PI_API_KEY,
    extraInstructions: resolveExtraInstructions(),
    mcpConfig: environment.mcpConfig,
    mcpServerCwd: environment.trustedMcpWorktree,
    lspServers: process.env.PI_REVIEWER_LSP_SERVERS,
    lspOverrides: environment.lspOverrides,
  } satisfies Partial<ReviewOptions>;
}

async function main(): Promise<void> {
  const payload = await readEvent();
  const event = normalizeEvent(payload);
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  // The mode is validated before anything else runs: a request for a check
  // this build cannot perform must fail loudly rather than quietly run a
  // different one.
  const mode: Mode = parseMode(process.env.PI_REVIEWER_MODE);
  assertModeImplemented(mode);
  if (!repo || !token) {
    log.error(
      "action.configuration.missing",
      "This action requires repository and token configuration",
      { missing: [!repo && "GITHUB_REPOSITORY", !token && "GITHUB_TOKEN"].filter(Boolean) },
    );
    process.exitCode = 1;
    return;
  }
  if (!isSafePullRequestNumber(event.pr)) {
    // A check run cannot be placed without a pull request, so a missing number
    // is an error in the dependency mode rather than an event to ignore.
    if (mode === "dependency")
      throw new Error(
        "The dependency mode requires a pull request number; only pull request events, or a workflow_dispatch with pr-number, can run it.",
      );
    log.info("action.event.ignored", "Ignoring event without a pull request");
    return;
  }
  if (event.fork) {
    log.info(
      "action.pull_request.fork_skipped",
      "Fork PRs are not reviewed because secrets are unavailable",
    );
    return;
  }
  if (event.command && !isAuthorizedReviewCommand(event) && !isAuthorizedSummaryCommand(event)) {
    log.info("action.comment.unauthorized", "Ignoring unauthorized comment");
    return;
  }

  const github = new GitHubClient(token);
  const pullRequest = await github.getPullRequest(repo, event.pr);
  // The Renovate skip belongs to the review mode: a review of a dependency
  // bump is noise, while the dependency mode exists for exactly those bumps.
  if (mode === "review" && isRenovatePullRequest(pullRequest)) {
    log.info("action.pull_request.renovate_skipped", "Renovate PRs are not reviewed");
    return;
  }
  if (
    event.kind === "manual" &&
    event.command !== "/pi-review" &&
    event.command !== "/pi-summary" &&
    process.env.GITHUB_EVENT_NAME === "issue_comment"
  )
    return;
  if (pullRequest.draft && process.env.REVIEW_DRAFTS !== "true") {
    log.info("action.pull_request.draft_skipped", "Draft PR reviews are disabled");
    return;
  }
  const identity = await github.getUser();
  if (pullRequest.head.repo?.full_name !== repo) {
    log.info("action.pull_request.head_unavailable", "Fork or deleted-head PRs are not reviewed");
    return;
  }
  if (event.kind === "reply") {
    // This branch intentionally precedes all batch-marker, diff, and review work,
    // and it stays ahead of the mode branch: a reply performs no analysis, so it
    // creates no check run and concludes none. The payload's repository
    // relationship was checked above, before comment API access.
    try {
      if (
        await handleReply({
          event,
          repo,
          pullRequest,
          identity,
          github,
          thinking: parseThinkingLevel(process.env.PI_REVIEWER_THINKING),
          piApiKey: process.env.PI_API_KEY,
        })
      )
        log.info("reply.completed", "Replied to review comment", { commentId: event.commentId });
    } catch (error) {
      log.warn("reply.failed", "Reply skipped after error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const context: ModeContext = {
    payload,
    event,
    // The reply branch returned above, so the remaining kind is a batch kind.
    kind: event.kind,
    prNumber: event.pr,
    repo,
    token,
    github,
    pullRequest,
    identity,
  };
  if (mode === "dependency") await runDependencyMode(context);
  else await runReviewMode(context);
}

/**
 * The dependency mode: one analysis of the whole pull request, reported on a
 * check run created before the fallible work.
 */
async function runDependencyMode(context: ModeContext): Promise<void> {
  const { event, repo, github, pullRequest, identity } = context;
  // Reviewing an ancestor commit is meaningless for a whole-pull-request
  // dependency analysis, and ignoring it would diverge the check from the
  // review it gates.
  if (event.targetHead)
    throw new Error(
      "target-head is not supported in dependency mode: the analysis always covers the whole pull request.",
    );
  // Summary regeneration is a review-mode feature, and this mode would turn
  // the command into a full analysis: it performs no dependency work, so it
  // creates no check run either.
  if (event.command === "/pi-summary") {
    log.info(
      "dependency.summary_command.ignored",
      "Ignoring /pi-summary: summary regeneration belongs to the review mode",
    );
    return;
  }
  // The authenticated head is captured once and used for the check run and the
  // review's commit alike, so the gate and the review describe one commit.
  const head = pullRequest.head.sha;
  await withDependencyCheckRun(github, {
    repo,
    headSha: head,
    run: async () => {
      const commits = prepareCommits({
        pullRequest,
        pullRequestNumber: context.prNumber,
        head,
      });
      // The overview block is emitted once, as it is in the review mode: the
      // reader has already seen this pull request's overview after the first
      // dependency review.
      const isFirstReview = await isFirstDependencyReview(context);
      const environment = await prepareWorktree({ payload: context.payload, head });
      try {
        // The marker records the whole pull request range: it identifies the
        // mode's own work without claiming an incremental batch.
        const batchMarker = encodeBatchMarker({
          fromSha: commits.mergeBase,
          toSha: head,
          kind: context.kind,
          actor: identity.login,
          reviewId: 0,
          mode: "dependency",
        });
        return await runDependencyCheck({
          repoCwd: process.cwd(),
          mergeBase: commits.mergeBase,
          headSha: head,
          prNumber: context.prNumber,
          batchMarker,
          review: { ...sharedReviewOptions(environment, context), isFirstReview },
        });
      } finally {
        await environment.cleanup();
      }
    },
  });
}

/**
 * Whether no prior dependency review of this pull request published a body.
 *
 * The mode-scoped selector is the same one the review mode uses, so the two
 * modes' overview slots cannot consume each other.
 */
async function isFirstDependencyReview(context: ModeContext): Promise<boolean> {
  try {
    const [reviews, issueComments] = await Promise.all([
      context.github.listReviews(context.repo, context.prNumber),
      context.github.listIssueComments(context.repo, context.prNumber),
    ]);
    return isFirstBodiedReview(
      [...reviews, ...issueComments],
      context.identity.login,
      "dependency",
    );
  } catch (error) {
    // The overview block is a courtesy, not the analysis: a history the mode
    // could not read leaves the block out rather than costing the run — and a
    // run with no qualifying upgrade must still report a passing check.
    log.warn("dependency.review_history.unavailable", "Could not read prior reviews", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** The review mode: an incremental batch of the pull request's diff. */
async function runReviewMode(context: ModeContext): Promise<void> {
  const { event, repo, github } = context;
  const { identity } = context;
  let pullRequest = context.pullRequest;
  let replySnapshot = await fetchReplySnapshot(github, repo, context.prNumber, pullRequest);
  if (event.kind === "synchronize") {
    const expectedHead = event.targetHead ?? pullRequest.head.sha;
    const recovered = await recoverSynchronizeReplies({
      repo,
      pullRequest,
      expectedHeadSha: expectedHead,
      identity,
      github,
      snapshot: replySnapshot,
      thinking: parseThinkingLevel(process.env.PI_REVIEWER_THINKING),
      piApiKey: process.env.PI_API_KEY,
    });
    if (recovered > 0)
      log.info("reply.recovery.completed", "Recovered review replies before review", { recovered });
    replySnapshot = await fetchReplySnapshot(github, repo, context.prNumber);
    pullRequest = replySnapshot.pullRequest;
    if (pullRequest.head.repo?.full_name !== repo || pullRequest.head.sha !== expectedHead) {
      log.info("review.skipped", "PR state changed during reply recovery; skipping normal review");
      return;
    }
  }
  const reviews = await github.listReviews(repo, context.prNumber);
  const [comments, issueComments] = await Promise.all([
    github.listComments(repo, context.prNumber),
    github.listIssueComments(repo, context.prNumber),
  ]);
  const threads = replySnapshot.threads;
  // Issue-comment fallback markers are durable batch state too. Reviews and issue
  // comments have separate chronological collections, so merge them by creation
  // time. Issue comments are the later source on an equal timestamp because the
  // issue-comment fallback is attempted after review posting.
  const markerSources = [
    ...reviews.map((source, index) => ({
      ...source,
      markerTime: source.created_at ? Date.parse(source.created_at) || 0 : 0,
      markerSource: 0,
      markerIndex: index,
    })),
    ...issueComments.map((source, index) => ({
      ...source,
      markerTime: source.created_at ? Date.parse(source.created_at) || 0 : 0,
      markerSource: 1,
      markerIndex: index,
    })),
  ].sort(
    (a, b) =>
      a.markerTime - b.markerTime ||
      a.markerSource - b.markerSource ||
      a.markerIndex - b.markerIndex,
  );
  // Only this mode's markers are its state: a dependency-mode marker would
  // otherwise supply the reviewed range, the prior summary, and the
  // already-reviewed verdict for a different kind of check.
  const marked = selectAuthenticatedBatchMarkers(markerSources, identity.login, "review");
  const latest = marked.at(-1);
  const latestMarkerSource = latest
    ? [...markerSources].reverse().find((source) => {
        const marker = decodeBatchMarker(source.body);
        return (
          source.user?.login === identity.login &&
          marker?.actor === identity.login &&
          marker.mode === latest.mode &&
          marker.version === latest.version &&
          marker.fromSha === latest.fromSha &&
          marker.toSha === latest.toSha &&
          marker.kind === latest.kind &&
          marker.actor === latest.actor &&
          marker.reviewId === latest.reviewId
        );
      })
    : undefined;
  const priorSummary =
    stripPrSummaryBlock(
      latestMarkerSource?.body?.replace(/<!-- pi-reviewer:batch:v1 [^>]+ -->/, "") ?? "",
    )
      .split(COMMAND_HINT_FOOTER)
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || undefined;
  // Emit-once anchor for PR summaries: marker-only reaction-path reviews carry
  // no visible body, so they must not consume the first-review slot. Any
  // earlier bodied source does — even when a later source is marker-only.
  const hasPriorBodiedReview = !isFirstBodiedReview(markerSources, identity.login, "review");
  const { activeFindings, resolvedFindings } = collectFindingHistory({
    reviews,
    issueComments,
    comments,
    threads,
    login: identity.login,
    mode: "review",
  });
  const head = event.targetHead ?? pullRequest.head.sha;
  // Marker ranges are incremental only when their prior endpoint remains in the local ancestry.
  if (latest) {
    try {
      ensureCommit(latest.toSha, undefined);
    } catch (error) {
      log.warn(
        "review.marker_history.unavailable",
        "Prior marker commit is unavailable; reviewing the full range",
        {
          sha: latest.toSha,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  // The commits must be local before any ancestry or merge decision: a head
  // that is not fetched makes every one of them answer about the wrong range.
  const commits = prepareCommits({ pullRequest, pullRequestNumber: context.prNumber, head });
  const headIsMerge = event.kind === "synchronize" && isMergeCommit(head);
  // A merge followed by further pushes leaves a non-merge head over a range
  // that still imports merged-branch history, so check the whole range.
  const rangeHasMerge =
    latest && ancestor(latest.toSha, head) ? rangeContainsMerge(latest.toSha, head) : false;
  const mergeHead = headIsMerge || rangeHasMerge;
  if (event.targetHead && !ancestor(head, pullRequest.head.sha)) {
    throw new Error("workflow target-head must be an ancestor of the current PR head");
  }

  const range = selectBatchRange(commits.mergeBase, head, latest, ancestor, mergeHead);
  if (!isEventRangeConsistent(event, latest?.toSha ?? commits.mergeBase, head))
    log.warn(
      "review.event_sha.mismatch",
      "Event SHAs differ from authenticated PR state; using authenticated marker range",
    );
  if (!range.fresh && event.kind !== "manual") {
    log.info("review.skipped.already_reviewed", "Current head was already reviewed");
    return;
  }
  const environment = await prepareWorktree({ payload: context.payload, head });
  try {
    const marker = encodeBatchMarker({
      fromSha: range.fromSha,
      toSha: range.toSha,
      kind: context.kind,
      actor: identity.login,
      reviewId: 0,
      mode: "review",
    });
    log.info("review.started", "Reviewing pull request", {
      pullRequest: context.prNumber,
      fromSha: range.fromSha,
      toSha: range.toSha,
    });
    const shared = sharedReviewOptions(environment, context);
    if (event.command === "/pi-summary") {
      // Whole-diff summary regeneration: run the agent for its overview only
      // (never the incremental batch range), then update the first bodied
      // review in place instead of posting. Creates no markers or findings.
      if (!parseSummaryFlag(process.env.PI_REVIEWER_SUMMARY)) {
        log.info("summary.disabled", "PR summaries are disabled; ignoring /pi-summary");
        return;
      }
      const target = selectFirstBodiedSource(reviews, issueComments, identity.login, "review");
      if (!target) {
        log.info("summary_regenerate.no_target", "No prior review to update; ignoring /pi-summary");
        return;
      }
      const regenerateRange = selectSummaryRegenerateRange(commits.mergeBase, head);
      const outcome = await review({
        ...shared,
        pr: context.prNumber,
        commitId: regenerateRange.toSha,
        fromSha: regenerateRange.fromSha,
        allowEmptyDiff: true,
        title: pullRequest.title,
        body: pullRequest.body,
        summaryOnly: true,
      });
      const overview = outcome.kind === "summary-only" ? outcome.overview : {};
      await applySummaryRegeneration({
        github,
        repo,
        prNumber: context.prNumber,
        headSha: head,
        target:
          target.kind === "review"
            ? { kind: "review", reviewId: target.id }
            : { kind: "issue", issueCommentId: target.id },
        overview,
        rangeLabel: prSummaryRangeLabel(regenerateRange.fromSha, regenerateRange.toSha),
      });
      return;
    }
    await review({
      ...shared,
      pr: context.prNumber,
      commitId: head,
      fromSha: range.fresh ? range.fromSha : head,
      allowEmptyDiff: !range.fresh,
      batchMarker: range.fresh ? marker : undefined,
      activeFindings,
      resolvedFindings,
      priorSummary,
      // Author-stated intent comes from the authenticated pulls API result in
      // scope here, never from the webhook payload, so intent stays consistent
      // with the SHAs actually reviewed.
      title: pullRequest.title,
      body: pullRequest.body,
      summary: parseSummaryFlag(process.env.PI_REVIEWER_SUMMARY),
      isFirstReview: !hasPriorBodiedReview,
    });
    if (event.kind === "synchronize") {
      const latestPullRequest = await github.getPullRequest(repo, context.prNumber);
      if (latestPullRequest.head.sha === head) {
        const latestSnapshot = await fetchReplySnapshot(
          github,
          repo,
          context.prNumber,
          latestPullRequest,
        );
        const recovered = await recoverSynchronizeReplies({
          repo,
          pullRequest: latestPullRequest,
          expectedHeadSha: head,
          identity,
          github,
          snapshot: latestSnapshot,
          thinking: parseThinkingLevel(process.env.PI_REVIEWER_THINKING),
          piApiKey: process.env.PI_API_KEY,
        });
        if (recovered > 0)
          log.info("reply.recovery.completed", "Recovered review replies after review", {
            recovered,
          });
      } else {
        log.info(
          "reply.recovery.skipped",
          "Skipping final reply recovery because the PR head changed",
        );
      }
    }
  } finally {
    await environment.cleanup();
  }
}

// Return and set process.exitCode instead of exiting synchronously: stdout and
// stderr are asynchronous on a POSIX pipe (the Actions log), so an immediate
// exit can drop buffered writes before they reach the log.
try {
  await main();
} catch (error) {
  log.error("action.failed", "Action failed", {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
}
