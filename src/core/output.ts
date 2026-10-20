import { writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDiffPositions, partitionComments } from "./diff-positions.js";
import { escapeHtmlCommentText } from "./html-comment.js";
import { PR_DIAGRAM_MAX_LENGTH, PR_SUMMARY_MAX_LENGTH } from "./prompts.js";
import { GitHubClient } from "../ci/github.js";
import {
  bodyFindingId,
  decodeBodyFindingMarkers,
  encodeBodyFindingMarker,
  updateBodyFindingMarker,
} from "../ci/batch.js";
import {
  AI_FIX_FOOTER,
  appendAiFixFooter,
  hasAiFixProse,
  neutralizeDetailsTags,
  normalizeAiFixBody,
  normalizeMarkdownText,
  renderAiFixPrompt,
  renderAiFixPromptList,
  renderFindingSummary,
  removeAiFixFooter,
} from "./ai-fix-footer.js";
import type { SearchCitation } from "../ci/search/types.js";

export type OutputTarget = "terminal" | "comment" | "file";
export type Severity = "CRITICAL" | "WARN" | "INFO";

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };
const SEVERITY_EMOJI: Record<Severity, string> = { CRITICAL: "🔴", WARN: "🟡", INFO: "🔵" };

export interface ReviewComment {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: Severity;
  body: string;
  suggestion?: string;
  resolved_finding_id?: string;
  re_raise_reason?: "REINTRODUCED" | "MATERIALLY_CHANGED" | "CONTRADICTORY_EVIDENCE";
  re_raise_evidence?: string;
  /** Server-validated re-raise provenance attached by normalizeReviewResult; model-supplied values are always overwritten. */
  reRaiseProvenance?: {
    historicalFindingId: string;
    reason?: ReviewComment["re_raise_reason"];
    evidence?: string;
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  finding_updates?: FindingUpdate[];
  /** What/Why/Risk overview for the collapsible PR summary block (first review only). */
  pr_summary?: string;
  /** Raw Mermaid source (no fences) for the summary block diagram. */
  pr_diagram?: string;
  /** Raw diff included by the agent in SSH+UI mode */
  diff?: string;
  tokenUsage?: TokenUsage;
}

export interface FindingUpdate {
  comment_id: number;
  status: "RESOLVED" | "PARTIALLY_RESOLVED" | "STILL_OPEN";
  explanation: string;
}

export interface FallbackParseDiagnostic {
  /** Which candidate the diagnostic describes; "none" when no candidate existed. */
  candidateSource: "full-text" | "fenced-block" | "json-object" | "none";
  /** Start offset of the candidate in the original text. */
  candidateIndex: number;
  /** Length of the candidate in characters. */
  candidateLength: number;
  /** Total number of candidates attempted. */
  candidateCount: number;
  /** Sanitized JSON.parse error message (control chars stripped, truncated). */
  error?: string;
  /** Character offset of the parse failure within the candidate, when known. */
  errorPosition?: number;
  /** Bounded, redacted snippet around the failure; never the full response. */
  excerpt?: string;
}

export interface ParsedAgentResponse {
  result: ReviewResult;
  /** True only when the response contained a valid review-shaped JSON object. */
  parsed: boolean;
  /** Safe diagnostic for a rejected text fallback; reason itself never contains model content. */
  rejectionReason?:
    | "malformed JSON"
    | "invalid summary"
    | "invalid comments"
    | "invalid finding_updates";
  /** Structured parse diagnostic for a malformed-JSON rejection; excerpt is bounded and redacted. */
  rejectionDetail?: FallbackParseDiagnostic;
}

export interface OutputOptions {
  target: OutputTarget;
  /** Schema-validated review content; present unless the model chose "none". */
  structuredResult?: ReviewResult;
  cwd?: string;
  githubToken?: string;
  prNumber?: number;
  repo?: string;
  commitId?: string;
  /** Commit containing the left side of the reviewed diff. */
  baseCommitId?: string;
  minSeverity?: Severity;
  /** Raw diff the model was shown. When present, inline comments are validated
   * against it and unpositionable ones are moved to the review body instead of
   * being sent inline (GitHub rejects the whole review on one bad position). */
  diff?: string;
  batchMarker?: string;
  existingFindings?: ExistingFinding[];
  existingFindingKeys?: ReadonlySet<string>;
  allowedFindingIds?: ReadonlySet<number>;
  resolvedFindings?: ResolvedFinding[];
  /**
   * The model chose the "none" action: it has nothing to publish. The harness
   * acknowledges the PR itself — a thumbs-up when it has no open findings,
   * otherwise a marker-only no-op — and never posts a review body.
   */
  none?: boolean;
  /** Render the collapsible PR summary block when the result carries an overview. */
  summaryEnabled?: boolean;
  /** True when no prior authenticated review with a body exists (first review). */
  isFirstReview?: boolean;
  /**
   * Files dropped by the diff-size filter. Rendered as a harness-owned
   * warning — never model prose — so skipped coverage is unmissable.
   */
  skippedDiff?: SkippedDiffNotice;
  /** Current-run, server-recorded external evidence; never model-authored. */
  evidence?: readonly SearchCitation[];
}

/**
 * Deterministic record of diff-budget overflow for the posted review body.
 * `shortfall` is raw-minus-cap chars: how much more budget the full diff
 * needed. Positive whenever `files` is non-empty.
 */
export interface SkippedDiffNotice {
  files: string[];
  cap: number;
  shortfall: number;
}

/** Max skipped paths listed before collapsing the remainder into a count. */
export const MAX_LISTED_SKIPPED_FILES = 50;

/**
 * Harness-owned overflow notice: a GitHub WARNING callout with the shortfall,
 * plus a collapsible path list. Rendered from server-measured values, so the
 * model can neither omit nor understate it. Paths are untrusted diff data:
 * code-spanned with backticks neutralized, inside the same details-tag
 * neutralization as other visible text.
 */
export function renderSkippedDiffNotice(notice: SkippedDiffNotice): string {
  const count = notice.files.length;
  const shown = notice.files.slice(0, MAX_LISTED_SKIPPED_FILES);
  const rest = count - shown.length;
  const items = shown.map((file) => `- \`${sanitizeVisibleReviewText(file).replace(/`/g, "'")}\``);
  if (rest > 0) items.push(`- …and ${rest} more`);
  return [
    "> [!WARNING]",
    `> Diff budget exceeded — ${count} file${count === 1 ? " was" : "s were"} not reviewed (${notice.shortfall.toLocaleString()} chars over the ${notice.cap.toLocaleString()}-char cap).`,
    "",
    "<details>",
    `<summary>Skipped files (${count})</summary>`,
    "",
    ...items,
    "",
    "</details>",
  ].join("\n");
}
export interface ResolvedFinding {
  historicalFindingId: string;
  file?: string;
  line?: number;
  side?: string;
  originalBody: string;
  kind?: "inline" | "body";
}
export interface OutputMetadata {
  reviewId?: number;
  commentIds: number[];
  fallback: boolean;
}
async function responseJson(
  response: Response,
): Promise<{ id?: number; comments?: Array<{ id?: number }> } | undefined> {
  if (typeof response.json !== "function") return undefined;
  try {
    return (await response.json()) as { id?: number; comments?: Array<{ id?: number }> };
  } catch {
    return undefined;
  }
}

export interface ExistingFinding {
  commentId: number;
  threadId?: string;
  body?: string;
  reviewId?: number;
  issueCommentId?: number;
  bodyFinding?: boolean;
  reviewBody?: string;
}

const FINDING_STATUSES = ["RESOLVED", "PARTIALLY_RESOLVED", "STILL_OPEN"] as const;

/** Best-effort cleanup of the reviewer's stale PR-level approval reaction. */
async function clearStaleThumbsUp(token: string, repo: string, prNumber: number): Promise<void> {
  const client = new GitHubClient(token);
  try {
    const identity = await client.getUser();
    const reactions = await client.listReactions(repo, prNumber);
    const ownThumbsUps = reactions.filter(
      (reaction) => reaction.content === "+1" && reaction.user?.login === identity.login,
    );
    const deletions = await Promise.allSettled(
      ownThumbsUps.map((reaction) => client.deleteReaction(repo, prNumber, reaction.id)),
    );
    const failed = deletions.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      const reasons = failed
        .map((result) =>
          result.status === "rejected"
            ? result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
            : "",
        )
        .join("; ");
      console.warn(
        `[pi-reviewer] could not remove ${failed.length} stale thumbs-up reaction(s): ${reasons}`,
      );
    }
    const removed = ownThumbsUps.length - failed.length;
    if (removed > 0)
      console.log(
        `[pi-reviewer] findings detected — removed ${removed} stale thumbs-up reaction(s) from the PR`,
      );
  } catch (error) {
    console.warn(
      `[pi-reviewer] could not remove stale thumbs-up reaction: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function findingUpdateRejection(
  update: unknown,
  allowedFindingIds?: ReadonlySet<number>,
): { update?: FindingUpdate; reason: string; commentId: unknown; status: unknown } {
  const value = update && typeof update === "object" ? (update as Record<string, unknown>) : {};
  const commentId = value.comment_id;
  const status = value.status;
  if (!Number.isInteger(commentId))
    return { reason: "comment_id is not an integer", commentId, status };
  if (allowedFindingIds && !allowedFindingIds.has(commentId as number))
    return { reason: "unknown active-finding ID", commentId, status };
  if (!FINDING_STATUSES.includes(status as (typeof FINDING_STATUSES)[number]))
    return { reason: "invalid status", commentId, status };
  if (typeof value.explanation !== "string")
    return { reason: "explanation is not a string", commentId, status };
  if (value.explanation.length > 2000)
    return { reason: "explanation exceeds 2000 characters", commentId, status };
  return {
    update: {
      comment_id: commentId as number,
      status: status as FindingUpdate["status"],
      explanation: value.explanation,
    },
    reason: "",
    commentId,
    status,
  };
}

function formatDiagnosticValue(value: unknown, kind: "comment_id" | "status"): string {
  if (kind === "comment_id" && typeof value === "number" && Number.isFinite(value))
    return String(value);
  if (
    kind === "status" &&
    typeof value === "string" &&
    FINDING_STATUSES.includes(value as (typeof FINDING_STATUSES)[number])
  )
    return value;
  return "invalid";
}

function structuredResultRejection(
  value: unknown,
): "invalid summary" | "invalid comments" | "invalid finding_updates" | undefined {
  if (!value || typeof value !== "object") return "invalid summary";
  const result = value as Record<string, unknown>;
  if (typeof result.summary !== "string") return "invalid summary";
  if (
    result.pr_summary !== undefined &&
    (typeof result.pr_summary !== "string" || result.pr_summary.length > PR_SUMMARY_MAX_LENGTH)
  )
    return "invalid summary";
  if (
    result.pr_diagram !== undefined &&
    (typeof result.pr_diagram !== "string" || result.pr_diagram.length > PR_DIAGRAM_MAX_LENGTH)
  )
    return "invalid summary";
  if (!Array.isArray(result.comments) || !result.comments.every(isReviewComment))
    return "invalid comments";
  if (result.finding_updates !== undefined && !Array.isArray(result.finding_updates))
    return "invalid finding_updates";
  return undefined;
}

/** Normalize tool output while isolating contextual finding validation from the review itself. */
export function normalizeReviewResult(
  result: ReviewResult,
  options: Pick<
    OutputOptions,
    | "minSeverity"
    | "allowedFindingIds"
    | "existingFindingKeys"
    | "resolvedFindings"
    | "commitId"
    | "batchMarker"
  >,
  warnInvalidUpdates: boolean,
): ReviewResult {
  const minRank = SEVERITY_RANK[options.minSeverity ?? "INFO"];
  const comments = result.comments
    .map((comment) => {
      const { suggestion, ...fields } = comment;
      return {
        ...fields,
        body: normalizeAiFixBody(sanitizeVisibleReviewText(comment.body)),
        ...(typeof suggestion === "string"
          ? { suggestion: normalizeMarkdownText(suggestion) }
          : {}),
        severity: normalizeSeverity(comment.severity),
      };
    })
    .filter((comment) => SEVERITY_RANK[comment.severity] >= minRank)
    .filter((comment) => !options.existingFindingKeys?.has(normalizeFinding(comment)))
    .filter((comment) => {
      const history = options.resolvedFindings ?? [];
      if (
        comment.resolved_finding_id &&
        !history.some((f) => f.historicalFindingId === comment.resolved_finding_id)
      ) {
        console.warn("[pi-reviewer] dropped re-raise: unknown historical finding ID");
        return false;
      }
      const cited = comment.resolved_finding_id
        ? history.find((f) => f.historicalFindingId === comment.resolved_finding_id)
        : undefined;
      if (cited && !hasCompatibleHistoricalLink(comment, cited)) {
        console.warn("[pi-reviewer] dropped re-raise: historical finding does not match candidate");
        return false;
      }
      const match = cited ?? history.find((f) => hasMatchingFindingIdentity(comment, f));
      if (!match) return true;
      // Identity matches without an explicit historical link stay suppressed,
      // so the ID equality check below is what enforces the provenance link.
      const valid =
        comment.resolved_finding_id === match.historicalFindingId &&
        ["REINTRODUCED", "MATERIALLY_CHANGED", "CONTRADICTORY_EVIDENCE"].includes(
          comment.re_raise_reason ?? "",
        ) &&
        typeof comment.re_raise_evidence === "string" &&
        comment.re_raise_evidence.trim().length > 0 &&
        comment.re_raise_evidence.length <= 2000;
      if (!valid) console.warn("[pi-reviewer] dropped re-raise: invalid provenance");
      return valid;
    })
    .map((comment) => {
      // Provenance is derived only from fields validated by the filter above;
      // reassigning the key here also drops any model-supplied value.
      const historical = (options.resolvedFindings ?? []).find(
        (f) => f.historicalFindingId === comment.resolved_finding_id,
      );
      const reRaiseProvenance = historical
        ? {
            historicalFindingId: historical.historicalFindingId,
            reason: comment.re_raise_reason,
            evidence: comment.re_raise_evidence,
          }
        : undefined;
      return { ...comment, ...(reRaiseProvenance ? { reRaiseProvenance } : {}) };
    });
  const updates: FindingUpdate[] = [];
  for (const candidate of result.finding_updates ?? []) {
    const checked = findingUpdateRejection(candidate, options.allowedFindingIds);
    if (checked.update) updates.push(checked.update);
    else if (warnInvalidUpdates) {
      console.warn(
        `[pi-reviewer] dropped finding update comment_id=${formatDiagnosticValue(checked.commentId, "comment_id")}${checked.status === undefined ? "" : ` status=${formatDiagnosticValue(checked.status, "status")}`} reason=${checked.reason}`,
      );
    }
  }
  return {
    summary: normalizeMarkdownText(result.summary),
    comments,
    ...(updates.length ? { finding_updates: updates } : {}),
    ...(typeof result.pr_summary === "string" && result.pr_summary.trim()
      ? {
          pr_summary: sanitizeVisibleReviewText(normalizeMarkdownText(result.pr_summary)).slice(
            0,
            PR_SUMMARY_MAX_LENGTH,
          ),
        }
      : {}),
    ...(typeof result.pr_diagram === "string" && result.pr_diagram.trim()
      ? { pr_diagram: result.pr_diagram.slice(0, PR_DIAGRAM_MAX_LENGTH) }
      : {}),
    ...(result.diff !== undefined ? { diff: result.diff } : {}),
  };
}

/** Applies model-approved transitions independently so a failed mutation can be retried safely. */
export async function reconcileFindingUpdates(options: {
  token: string;
  repo: string;
  prNumber: number;
  targetSha: string;
  updates: FindingUpdate[];
  findings: ExistingFinding[];
}): Promise<Set<number>> {
  const client = new GitHubClient(options.token);
  const known = new Map(options.findings.map((f) => [f.commentId, f]));
  const outstanding = new Set(options.findings.map((f) => f.commentId));
  const hasMutations = options.updates.some((update) => update.status !== "STILL_OPEN");
  const identity = hasMutations ? await client.getUser() : undefined;
  if (identity) {
    const current = await client.getPullRequest(options.repo, options.prNumber);
    if (current.head.sha !== options.targetSha) {
      console.warn(
        "[pi-reviewer] PR head changed before reconciliation; leaving lifecycle state unchanged",
      );
      return outstanding;
    }
  }
  const priorReplies = await client.listComments(options.repo, options.prNumber).catch(() => []);
  const isTargetHeadCurrent = async () => {
    try {
      const current = await client.getPullRequest(options.repo, options.prNumber);
      return current.head.sha === options.targetSha;
    } catch {
      return false;
    }
  };
  type BodyUpdate = FindingUpdate & { status: Exclude<FindingUpdate["status"], "STILL_OPEN"> };
  const bodyUpdates = new Map<string, { finding: ExistingFinding; updates: BodyUpdate[] }>();
  for (const update of options.updates) {
    const finding = known.get(update.comment_id);
    if (!finding) continue;
    if (update.status === "STILL_OPEN") continue;
    if (
      finding.bodyFinding &&
      (finding.reviewId || finding.issueCommentId) &&
      finding.reviewBody !== undefined
    ) {
      const key = finding.reviewId
        ? `review:${finding.reviewId}`
        : `issue:${finding.issueCommentId}`;
      const group = bodyUpdates.get(key) ?? { finding, updates: [] };
      group.updates.push(update as BodyUpdate);
      bodyUpdates.set(key, group);
      continue;
    }
  }
  for (const [reviewKey, group] of bodyUpdates) {
    let updatedBody: string;
    try {
      const freshReview = group.finding.issueCommentId
        ? await client.request<{ body?: string }>(
            `/repos/${options.repo}/issues/comments/${group.finding.issueCommentId}`,
          )
        : await client.getReview(
            options.repo,
            options.prNumber,
            Number(reviewKey.slice("review:".length)),
          );
      if (typeof freshReview.body !== "string") {
        console.warn(
          `[pi-reviewer] could not update body source ${reviewKey}: fetched source has no body`,
        );
        continue;
      }
      updatedBody = freshReview.body;
    } catch (error) {
      console.warn(
        `[pi-reviewer] could not fetch body source ${reviewKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const changedFindingIds = new Set<number>();
    for (const update of group.updates) {
      const currentMarker = decodeBodyFindingMarkers(updatedBody).find(
        (marker) => marker.findingId === update.comment_id,
      );
      if (
        currentMarker?.targetSha === options.targetSha &&
        currentMarker.status === update.status &&
        currentMarker.explanation === update.explanation
      ) {
        if (update.status === "RESOLVED") outstanding.delete(update.comment_id);
        continue;
      }
      const nextBody = updateBodyFindingMarker(
        updatedBody,
        update.comment_id,
        update.status,
        options.targetSha,
        update.explanation,
      );
      if (nextBody !== updatedBody) {
        updatedBody = nextBody;
        changedFindingIds.add(update.comment_id);
      }
    }
    if (updatedBody === group.finding.reviewBody || !(await isTargetHeadCurrent())) continue;
    try {
      if (group.finding.issueCommentId)
        await client.updateIssueComment(
          options.repo,
          options.prNumber,
          group.finding.issueCommentId,
          updatedBody,
        );
      else
        await client.updateReview(
          options.repo,
          options.prNumber,
          Number(reviewKey.slice("review:".length)),
          updatedBody,
        );
      for (const update of group.updates) {
        if (update.status === "RESOLVED" && changedFindingIds.has(update.comment_id))
          outstanding.delete(update.comment_id);
      }
    } catch (error) {
      console.warn(
        `[pi-reviewer] could not update body source ${reviewKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const update of options.updates) {
    const finding = known.get(update.comment_id);
    if (!finding || update.status === "STILL_OPEN") continue;
    if (
      finding.bodyFinding &&
      (finding.reviewId || finding.issueCommentId) &&
      finding.reviewBody !== undefined
    )
      continue;
    const linkedSha = options.targetSha.slice(0, 7);
    const body = `<!-- pi-reviewer:status:v1 ${JSON.stringify({ findingId: update.comment_id, targetSha: options.targetSha, status: update.status })} -->\n${update.status === "RESOLVED" ? `Resolved by ${linkedSha}` : `Partially addressed by ${linkedSha}`}: ${update.explanation}`;
    const alreadyReplied = priorReplies.some(
      (reply) =>
        reply.user?.login === identity?.login &&
        reply.in_reply_to_id === finding.commentId &&
        reply.body.includes(`"targetSha":"${options.targetSha}"`) &&
        reply.body.includes(`"status":"${update.status}"`),
    );
    try {
      if (!alreadyReplied) {
        // Recheck after loading all replies and immediately before persisting
        // lifecycle state; the initial guard can be separated from this point
        // by a slow paginated API response.
        if (!(await isTargetHeadCurrent())) {
          console.warn(
            `[pi-reviewer] PR head changed before replying to finding ${finding.commentId}; leaving lifecycle state unchanged`,
          );
          continue;
        }
        await client.reply(options.repo, options.prNumber, finding.commentId, body);
      }
    } catch (error) {
      console.warn(
        `[pi-reviewer] could not reply to finding ${finding.commentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (update.status === "RESOLVED" && finding.threadId) {
      try {
        // Revalidate immediately before the destructive mutation. The review
        // may have taken long enough for the PR head to advance since the
        // initial post-time guard.
        if (!(await isTargetHeadCurrent())) {
          console.warn(
            `[pi-reviewer] PR head changed before resolving finding ${finding.commentId}; leaving thread open`,
          );
          continue;
        }
        await client.resolveThread(finding.threadId);
      } catch (error) {
        console.warn(
          `[pi-reviewer] could not resolve finding ${finding.commentId}; will retry resolution: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }
    if (update.status === "RESOLVED") outstanding.delete(finding.commentId);
  }
  return outstanding;
}

export function extractAssistantText(message: unknown): string {
  const msg = message as { role?: string; content?: unknown };
  if (msg?.role !== "assistant") return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type?: string }).type === "text"
        ) {
          return (part as { text?: string }).text ?? "";
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

export function extractLastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantText(messages[i]);
    if (text) return text;
  }
  return "";
}

function normalizeSeverity(value: unknown): Severity {
  if (value === "CRITICAL" || value === "WARN" || value === "INFO") return value;
  return "INFO";
}

function isReviewComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== "object") return false;
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.file === "string" &&
    typeof comment.line === "number" &&
    Number.isFinite(comment.line) &&
    (comment.side === "LEFT" || comment.side === "RIGHT") &&
    typeof comment.body === "string" &&
    hasAiFixProse(comment.body)
  );
}

/**
 * Text-fallback recovery: a model that omits `side` almost always means an
 * added/context line, which is RIGHT. Only a genuinely absent side is filled
 * in — an unrecognized value fails closed rather than guessing. The
 * submit_review tool schema requires `side`, so schema-validated output never
 * relies on this default.
 */
function withDefaultCommentSide(comments: readonly unknown[]): unknown[] {
  return comments.map((comment) => {
    if (!comment || typeof comment !== "object") return comment;
    const record = comment as Record<string, unknown>;
    if (record.side !== undefined && record.side !== null && record.side !== "") return comment;
    return { ...record, side: "RIGHT" };
  });
}

/** A candidate substring tagged with its start index in the original text. */
interface Candidate {
  content: string;
  index: number;
  source: "full-text" | "fenced-block" | "json-object";
}

/**
 * Extract the inner content of **every** fenced code block in `text`.
 * Uses a non-greedy global match so each ```...``` pair yields exactly one
 * block — fixing the previous greedy regex that spanned first-open → last-close
 * and swallowed everything (including inner fences) into one blob.
 *
 * Returns candidates tagged with the index of the opening fence so the caller
 * can sort them by source position.
 */
function extractAllFencedBlocks(text: string): Candidate[] {
  const blocks: Candidate[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ content: m[1].trim(), index: m.index, source: "fenced-block" });
  }
  return blocks;
}

/**
 * String/escape-aware brace scanner that finds **every** top-level `{...}`
 * object in `text` (not just the first). Handles braces inside JSON string
 * values and escape sequences so they don't confuse depth tracking.
 *
 * Note: a stray unclosed `{` in reasoning prose will swallow every subsequent
 * object until EOF — but fenced blocks are extracted independently, so the
 * review is still recoverable when the model uses a code fence.
 *
 * Returns candidates tagged with the index of the opening `{`.
 */
function extractAllJsonObjects(text: string): Candidate[] {
  const objects: Candidate[] = [];
  let depth = 0,
    start = -1,
    inString = false,
    escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push({ content: text.slice(start, i + 1), index: start, source: "json-object" });
          start = -1;
        }
      }
    }
  }
  return objects;
}

const MAX_DIAGNOSTIC_ERROR_LENGTH = 120;
const MAX_DIAGNOSTIC_EXCERPT_LENGTH = 160;
const DIAGNOSTIC_EXCERPT_RADIUS = 60;

function sanitizeParseErrorMessage(message: string): string {
  const cleaned = [...message]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_ERROR_LENGTH);
  return cleaned || "parse error";
}

function extractJsonErrorPosition(message: string, inputLength: number): number | undefined {
  const positionMatch = message.match(/at position (\d+)/i);
  if (positionMatch) {
    const position = Number.parseInt(positionMatch[1], 10);
    if (Number.isFinite(position)) return Math.min(position, inputLength);
  }
  if (/unexpected end of json input/i.test(message)) return inputLength;
  const lineColumnMatch = message.match(/line (\d+) column (\d+)/i);
  if (lineColumnMatch) {
    const line = Number.parseInt(lineColumnMatch[1], 10);
    const column = Number.parseInt(lineColumnMatch[2], 10);
    if (Number.isFinite(line) && Number.isFinite(column)) return undefined;
  }
  return undefined;
}

function sanitizeDiagnosticExcerpt(content: string, errorPosition?: number): string {
  if (content.length === 0) return "";
  const position = errorPosition ?? 0;
  const clamped = Math.max(0, Math.min(position, content.length));
  const start = Math.max(0, clamped - DIAGNOSTIC_EXCERPT_RADIUS);
  const end = Math.min(content.length, clamped + DIAGNOSTIC_EXCERPT_RADIUS);
  const window = content.slice(start, end);
  const singleLine = [...window]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  // Redact secret-like runs without revealing their value; the excerpt
  // stays structural (surrounding JSON punctuation) rather than credential content.
  const redacted = singleLine
    .replace(/(sk-|ghp_|gho_|github_pat_|xox[bap]-)[A-Za-z0-9_\-+/=]{8,}/gi, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{20,}/g, "[redacted]");
  if (redacted.length <= MAX_DIAGNOSTIC_EXCERPT_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_EXCERPT_LENGTH)}…`;
}

interface JsonParseAttempt {
  parsed?: Record<string, unknown>;
  error?: string;
  errorPosition?: number;
}

function attemptJsonParse(input: string): JsonParseAttempt {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return { parsed: parsed as Record<string, unknown> };
    return { error: "parsed value is not an object", errorPosition: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: sanitizeParseErrorMessage(message),
      errorPosition: extractJsonErrorPosition(message, input.length),
    };
  }
}

function tryParseJSONDetailed(raw: string): {
  parsed: Record<string, unknown> | null;
  error?: string;
  errorPosition?: number;
} {
  // Build the control-char-tolerant variant alongside an escaped->raw
  // code-unit map, so a winning escaped-attempt position translates back
  // to raw-candidate coordinates and excerpt slicing stays consistent.
  let escaped = "";
  const owner: number[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const code = raw.charCodeAt(i);
    if (escape) {
      escaped += c;
      owner.push(i);
      escape = false;
    } else if (c === "\\" && inString) {
      escaped += c;
      owner.push(i);
      escape = true;
    } else if (c === '"') {
      escaped += c;
      owner.push(i);
      inString = !inString;
    } else if (inString && c === "\n") {
      escaped += "\\n";
      owner.push(i, i);
    } else if (inString && c === "\r") {
      escaped += "\\r";
      owner.push(i, i);
    } else if (inString && c === "\t") {
      escaped += "\\t";
      owner.push(i, i);
    } else if (inString && code >= 0 && code <= 0x1f) continue;
    else {
      escaped += c;
      owner.push(i);
    }
  }
  owner[escaped.length] = raw.length;

  const rawAttempt = attemptJsonParse(raw);
  if (rawAttempt.parsed) return { parsed: rawAttempt.parsed };
  if (escaped === raw) {
    return { parsed: null, error: rawAttempt.error, errorPosition: rawAttempt.errorPosition };
  }
  const escapedAttempt = attemptJsonParse(escaped);
  if (escapedAttempt.parsed) return { parsed: escapedAttempt.parsed };
  // Report the attempt that made the most progress into the candidate,
  // comparing on raw coordinates so the excerpt window stays consistent.
  const translatedPosition =
    escapedAttempt.errorPosition === undefined
      ? undefined
      : (owner[Math.max(0, Math.min(escapedAttempt.errorPosition, escaped.length))] ?? raw.length);
  const rawProgress = rawAttempt.errorPosition ?? -1;
  const escapedProgress = translatedPosition ?? -1;
  if (escapedProgress > rawProgress) {
    const error =
      translatedPosition !== undefined && escapedAttempt.error
        ? escapedAttempt.error.replace(/at position \d+/i, `at position ${translatedPosition}`)
        : escapedAttempt.error;
    return { parsed: null, error, errorPosition: translatedPosition };
  }
  return { parsed: null, error: rawAttempt.error, errorPosition: rawAttempt.errorPosition };
}

export function parseAgentResponseWithStatus(
  text: string,
  minSeverity: Severity = "INFO",
  allowedFindingIds?: ReadonlySet<number>,
  existingFindingKeys?: ReadonlySet<string>,
  resolvedFindings?: ResolvedFinding[],
  provenance?: Pick<OutputOptions, "commitId" | "batchMarker">,
): ParsedAgentResponse {
  // Build candidates sorted by source position. We return the **last** valid
  // candidate — this handles models that reason in prose before emitting the
  // final review (the production incident pattern).
  //
  // As an additional guard, among valid candidates we prefer ones with
  // non-empty comments over ones with empty comments. This prevents a trailing
  // "here's the structure: {summary, comments:[]}" example in prose from
  // stealing the win from the real review (comments.every() is vacuously true
  // for []).
  const candidates: Candidate[] = [
    { content: text.trim(), index: 0, source: "full-text" },
    ...extractAllFencedBlocks(text),
    ...extractAllJsonObjects(text),
  ];
  candidates.sort((a, b) => a.index - b.index);

  // No early return: last-wins requires a full scan.
  let resultWithComments: ReviewResult | null = null;
  let resultAny: ReviewResult | null = null;
  let rejectionReason: ParsedAgentResponse["rejectionReason"] = "malformed JSON";
  // Best parse failure for the malformed-JSON diagnostic: furthest progress
  // wins, so a near-valid review beats wrapper prose that fails at offset 0.
  let bestFailure:
    | {
        error?: string;
        errorPosition?: number;
        source: Candidate["source"];
        index: number;
        length: number;
      }
    | undefined;
  const sourcePriority: Record<Candidate["source"], number> = {
    "full-text": 0,
    "json-object": 1,
    "fenced-block": 2,
  };

  for (const { content, index, source } of candidates) {
    const attempt = tryParseJSONDetailed(content);
    const parsed = attempt.parsed;
    // Lenient parse for local/SSH display only: this parser never feeds the CI
    // posting path, which requires the submit_review schema where `side` is
    // mandatory. A missing side therefore defaults here but is never guessed
    // for anything that gets posted.
    const comments =
      parsed && Array.isArray(parsed.comments)
        ? withDefaultCommentSide(parsed.comments)
        : undefined;
    const commentsValid = comments !== undefined && comments.every(isReviewComment);
    // Empty candidates carry no signal; skipping them keeps an empty fence
    // from outranking a position-less full-text failure.
    if (!parsed && content.length > 0) {
      const progress = attempt.errorPosition ?? -1;
      const current = bestFailure ? (bestFailure.errorPosition ?? -1) : -2;
      if (
        progress > current ||
        (progress === current &&
          (bestFailure === undefined ||
            sourcePriority[source] > sourcePriority[bestFailure.source] ||
            (sourcePriority[source] === sourcePriority[bestFailure.source] &&
              index >= bestFailure.index)))
      ) {
        bestFailure = {
          error: attempt.error,
          errorPosition: attempt.errorPosition,
          source,
          index,
          length: content.length,
        };
      }
    }
    if (parsed) {
      rejectionReason =
        typeof parsed.summary !== "string"
          ? "invalid summary"
          : !commentsValid
            ? "invalid comments"
            : parsed.finding_updates !== undefined &&
                (!Array.isArray(parsed.finding_updates) ||
                  !parsed.finding_updates.every(
                    (u) => findingUpdateRejection(u, allowedFindingIds).update !== undefined,
                  ))
              ? "invalid finding_updates"
              : rejectionReason;
    }
    const rawUpdates =
      parsed && Array.isArray(parsed.finding_updates) ? parsed.finding_updates : [];
    const updatesValid = rawUpdates.every(
      (u) => findingUpdateRejection(u, allowedFindingIds).update !== undefined,
    );
    if (parsed && typeof parsed.summary === "string" && commentsValid && updatesValid) {
      const diff = typeof parsed.diff === "string" ? parsed.diff : undefined;
      const prSummary = typeof parsed.pr_summary === "string" ? parsed.pr_summary : undefined;
      const prDiagram = typeof parsed.pr_diagram === "string" ? parsed.pr_diagram : undefined;
      const review = normalizeReviewResult(
        {
          summary: parsed.summary,
          comments: comments as ReviewComment[],
          finding_updates: rawUpdates as FindingUpdate[],
          ...(prSummary !== undefined ? { pr_summary: prSummary } : {}),
          ...(prDiagram !== undefined ? { pr_diagram: prDiagram } : {}),
          ...(diff !== undefined ? { diff } : {}),
        },
        { minSeverity, allowedFindingIds, existingFindingKeys, resolvedFindings, ...provenance },
        false,
      );
      resultAny = review;
      // Base the preference on what the model emitted, not on what remains
      // after minSeverity filtering. A genuine review whose findings are all
      // below the configured threshold must still beat an earlier draft.
      if (comments.length > 0) resultWithComments = review;
    }
  }

  // Prefer the last review with comments; fall back to last review overall.
  const result = resultWithComments ?? resultAny;
  if (result) return { result, parsed: true };

  if (rejectionReason !== "malformed JSON") {
    return { result: { summary: text, comments: [] }, parsed: false, rejectionReason };
  }
  if (!bestFailure) {
    const fullText = candidates.find((candidate) => candidate.source === "full-text");
    return {
      result: { summary: text, comments: [] },
      parsed: false,
      rejectionReason,
      rejectionDetail: {
        candidateSource: fullText ? "full-text" : "none",
        candidateIndex: fullText?.index ?? 0,
        candidateLength: fullText?.content.length ?? 0,
        candidateCount: candidates.length,
      },
    };
  }
  const failingContent =
    candidates.find(
      (candidate) =>
        candidate.source === bestFailure.source &&
        candidate.index === bestFailure.index &&
        candidate.content.length === bestFailure.length,
    )?.content ?? "";
  const rejectionDetail: FallbackParseDiagnostic = {
    candidateSource: bestFailure.source,
    candidateIndex: bestFailure.index,
    candidateLength: bestFailure.length,
    candidateCount: candidates.length,
    ...(bestFailure.error ? { error: bestFailure.error } : {}),
    ...(bestFailure.errorPosition !== undefined
      ? { errorPosition: bestFailure.errorPosition }
      : {}),
    excerpt: sanitizeDiagnosticExcerpt(failingContent, bestFailure.errorPosition),
  };
  return {
    result: { summary: text, comments: [] },
    parsed: false,
    rejectionReason,
    rejectionDetail,
  };
}

/** Stable identity used to avoid reposting the same finding in a batch. */
export function normalizeFinding(
  comment: Pick<ReviewComment, "file" | "line" | "side" | "body">,
): string {
  // Suggestion code is opaque to finding metadata decoders.
  const bodyWithoutSuggestions = stripGitHubSuggestions(comment.body);
  const storedBody = decodeBodyFindingMarkers(bodyWithoutSuggestions)[0]?.body;
  const body = removeAiFixFooter(
    (storedBody ?? bodyWithoutSuggestions).replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, ""),
  )
    .split(AI_FIX_FOOTER)
    .join("")
    .trim()
    .replace(/^[🔴🟡🔵]\s*/u, "")
    .trim()
    .replace(/^(`{3,})suggestion[ \t]*\n[\s\S]*?^\1(?!`)[ \t]*$/gm, "")
    .trim()
    .replace(/\n\s*\n+/g, "\n");
  return [comment.file, comment.line, comment.side, body].join("\0");
}

/** Normalizes visible finding prose for resilient historical identity matching. */
function normalizedFindingBody(body: string): string {
  return removeAiFixFooter(
    stripGitHubSuggestions(body.replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, "")),
  )
    .split(AI_FIX_FOOTER)
    .join("")
    .replace(/^[🔴🟡🔵]\s*/u, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function stripGitHubSuggestions(body: string): string {
  return body.replace(/^(`{3,})suggestion[^\r\n]*\r?\n[\s\S]*?^\1(?!`)[ \t]*\r?$/gm, "");
}

/** Checks the file, side, and normalized prose identity of two findings. */
function hasMatchingFindingIdentity(
  candidate: ReviewComment,
  historical: ResolvedFinding,
): boolean {
  if (historical.file !== candidate.file || historical.side !== candidate.side) return false;
  const candidateBody = normalizedFindingBody(candidate.body);
  const historicalBody = normalizedFindingBody(historical.originalBody);
  if (candidateBody === historicalBody) return true;
  const left = new Set(candidateBody.split(/\s+/).filter(Boolean));
  const right = new Set(historicalBody.split(/\s+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return false;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.max(left.size, right.size) >= 0.6;
}

/** Validates that a cited historical ID belongs to the candidate finding. */
function hasCompatibleHistoricalLink(
  candidate: ReviewComment,
  historical: ResolvedFinding,
): boolean {
  if (historical.file !== candidate.file || historical.side !== candidate.side) return false;
  return historical.line === candidate.line || hasMatchingFindingIdentity(candidate, historical);
}

/** Returns whether a review contains a finding requiring an explicit fix. */
function hasActionableFindings(comments: ReviewComment[]): boolean {
  return comments.some((comment) => comment.severity === "WARN" || comment.severity === "CRITICAL");
}

/** Adds the fix instruction only to actionable individual findings. */
function appendFindingFooter(comment: ReviewComment, body: string): string {
  const metadata = body.match(/^(?:(?:<!--\s*pi-reviewer\s*:[\s\S]*?-->\n?)*)/)?.[0] ?? "";
  const findingBody = normalizeAiFixBody(body.slice(metadata.length));
  const visibleBody = renderFindingSummary(comment, findingBody, { includeLocation: false });
  const fixit =
    comment.severity === "WARN" || comment.severity === "CRITICAL"
      ? `\n\n${renderAiFixPrompt(comment, findingBody)}`
      : "";
  return `${metadata}${visibleBody}${fixit}`;
}

function appendGitHubSuggestion(comment: ReviewComment, body: string): string {
  if (comment.side !== "RIGHT" || typeof comment.suggestion !== "string") return body;
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(comment.suggestion.matchAll(/`+/g), ([run]) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${body}\n\n${fence}suggestion\n${comment.suggestion}\n${fence}`;
}

/** Keep model-controlled text from becoming metadata when it is shown in a review body. */
function sanitizeVisibleReviewText(text: string): string {
  return neutralizeDetailsTags(text.replace(/<!--\s*pi-reviewer\s*:/gi, "<!-- pi-reviewer :"));
}

type ReRaiseProvenanceOptions = Pick<OutputOptions, "commitId" | "batchMarker">;

/**
 * Hidden provenance comment for a validated re-raise. Generated at posting
 * time from server-validated fields so it stays byte-exact in every posting
 * path (inline, moved-to-body, and issue-comment fallback); `-->` is escaped
 * so model-controlled evidence cannot terminate the comment early.
 */
function reRaiseMetadata(comment: ReviewComment, options: ReRaiseProvenanceOptions): string {
  const provenance = comment.reRaiseProvenance;
  if (!provenance) return "";
  const json = escapeHtmlCommentText(
    JSON.stringify({
      historicalFindingId: provenance.historicalFindingId,
      reason: provenance.reason,
      evidence: provenance.evidence,
      newFindingId: normalizeFinding(comment),
      targetSha: options.commitId,
      batch: options.batchMarker,
    }),
  );
  return `<!-- pi-reviewer:re-raise:v1 ${json} -->\n`;
}

export function parseAgentResponse(text: string, minSeverity: Severity = "INFO"): ReviewResult {
  return parseAgentResponseWithStatus(text, minSeverity).result;
}

function formatForGitHub(
  result: ReviewResult,
  provenance: ReRaiseProvenanceOptions &
    Pick<
      OutputOptions,
      "repo" | "baseCommitId" | "evidence" | "summaryEnabled" | "isFirstReview" | "skippedDiff"
    >,
): string {
  const lines = ["## Pi Reviewer", ""];
  // Footer advertises regeneration, so it renders iff the block does (see buildReviewBody).
  const showSummary = shouldRenderPrSummary(result, provenance);
  if (showSummary)
    lines.push(
      renderPrSummary(
        result.pr_summary!,
        result.pr_diagram,
        prSummaryRangeLabel(provenance.baseCommitId, provenance.commitId),
      ),
      "",
    );
  lines.push(sanitizeVisibleReviewText(result.summary));

  // Harness-owned overflow notice lives in the findings summary (never the PR
  // overview): skipped coverage must survive even a model that says nothing.
  if (provenance.skippedDiff && provenance.skippedDiff.files.length > 0)
    lines.push("", renderSkippedDiffNotice(provenance.skippedDiff));

  const actionable = result.comments.filter(
    (comment) => comment.severity === "WARN" || comment.severity === "CRITICAL",
  );
  const prompt = renderAiFixPromptList(
    actionable.map((comment) => ({
      context: comment,
      body: sanitizeVisibleReviewText(comment.body),
    })),
  );
  if (prompt) lines.push("", prompt);

  if (result.comments.length > 0) {
    lines.push("", "### Inline Comments");
    for (const comment of result.comments) {
      const findingBody = normalizeAiFixBody(comment.body);
      const visibleBody = `${reRaiseMetadata(comment, provenance)}${renderFindingSummary({ ...comment, repository: provenance.repo, commitId: provenance.commitId, baseCommitId: provenance.baseCommitId }, findingBody)}`;
      lines.push(
        "",
        encodeBodyFindingMarker({
          findingId: bodyFindingId(normalizeFinding(comment)),
          file: comment.file,
          line: comment.line,
          side: comment.side,
          severity: comment.severity,
          body: `${reRaiseMetadata(comment, provenance)}${findingBody}`,
        }),
        visibleBody,
      );
    }
  }

  const sources = renderExternalSources(
    `${result.summary}\n${result.comments.map((comment) => comment.body).join("\n")}`,
    provenance.evidence,
  );
  if (sources) lines.push("", sources);
  if (showSummary) lines.push("", COMMAND_HINT_FOOTER);

  const body = lines.join("\n");
  return body;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type PrSummaryGate = Pick<OutputOptions, "summaryEnabled" | "isFirstReview">;

/** Server-rendered discoverability footer for the first review only. Never model-generated. */
export const COMMAND_HINT_FOOTER =
  "<sub><code>/pi-review</code> re-reviews · <code>/pi-summary</code> regenerates the summary</sub>";

/** Whether the collapsible PR summary block belongs in this review body. */
function shouldRenderPrSummary(result: ReviewResult, options: PrSummaryGate): boolean {
  return Boolean(options.summaryEnabled && options.isFirstReview && result.pr_summary?.trim());
}

/** Short `base..head` label for the summary toggle, matching lifecycle replies. */
export function prSummaryRangeLabel(baseCommitId?: string, commitId?: string): string {
  const base = (baseCommitId ?? "").slice(0, 7);
  const head = (commitId ?? "").slice(0, 7);
  return base && head ? `${base}..${head}` : "";
}

const MERMAID_FIRST_LINE_ALLOWLIST =
  /^(flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram)\b/;

/**
 * Validates untrusted Mermaid source for the summary block. Returns the source
 * unchanged when it is a supported diagram type without fence escapes or
 * lifecycle-marker text; otherwise returns undefined so the caller keeps the
 * prose and drops the diagram (warn-only, never fatal).
 */
function validateMermaidSource(source: string): string | undefined {
  if (source.length > PR_DIAGRAM_MAX_LENGTH) {
    console.warn("[pi-reviewer] dropped PR summary diagram: exceeds size cap");
    return undefined;
  }
  if (/`{3,}/.test(source)) {
    console.warn("[pi-reviewer] dropped PR summary diagram: contains a code fence");
    return undefined;
  }
  // HTML comments open with `<!--`: that sequence (or lifecycle-marker text)
  // could smuggle metadata into decoders, so it is rejected. A lone `-->`
  // without its opener is inert text — and `-->` arrows are core Mermaid
  // syntax — so only the opener is refused. details/summary tags would break
  // the upsert/strip block matching, so they are refused as well.
  if (
    /pi-reviewer:/i.test(source) ||
    source.includes("<!--") ||
    /<\/?(details|summary)[\s>/]/i.test(source)
  ) {
    console.warn("[pi-reviewer] dropped PR summary diagram: contains markup");
    return undefined;
  }
  const firstLine = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine || !MERMAID_FIRST_LINE_ALLOWLIST.test(firstLine)) {
    console.warn("[pi-reviewer] dropped PR summary diagram: unsupported diagram type");
    return undefined;
  }
  return source;
}

/**
 * Renders the collapsible PR summary block. The prose is sanitized here (in
 * addition to normalization) so every posting path — including summary
 * regeneration — stays injection-safe; the wrapper is added after sanitizing
 * so model-emitted details/summary tags cannot break out of it.
 */
export function renderPrSummary(
  prSummary: string,
  prDiagram: string | undefined,
  rangeLabel: string,
): string {
  const lines = [
    "<details>",
    `<summary>Summary${rangeLabel ? ` · ${rangeLabel}` : ""}</summary>`,
    "",
    sanitizeVisibleReviewText(prSummary),
  ];
  const diagram = prDiagram?.trim() ? validateMermaidSource(prDiagram) : undefined;
  if (diagram) lines.push("", "```mermaid", diagram, "```");
  lines.push("", "</details>");
  return lines.join("\n");
}

/**
 * Matches the server-rendered PR summary block. Anchored on the exact wrapper
 * this module generates: model prose can never contain `details`/`summary`
 * tags (neutralized before wrapping), so the first match is always our block.
 */
export const PR_SUMMARY_BLOCK_PATTERN =
  /<details>\n<summary>Summary(?: · [^\n<]*)?<\/summary>\n\n[\s\S]*?\n<\/details>/;

/** Removes the rendered PR summary block so historic overviews never pollute finding context. */
export function stripPrSummaryBlock(body: string): string {
  return body
    .replace(PR_SUMMARY_BLOCK_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Replaces the rendered summary block in place, or inserts it immediately
 * after the batch-marker line when the body has none (marker-only and
 * pre-feature reviews). Lifecycle markers are never touched; callers assert
 * the round-trip.
 */
export function upsertPrSummaryBlock(
  reviewBody: string,
  prSummary: string,
  prDiagram: string | undefined,
  rangeLabel: string,
): string {
  const block = renderPrSummary(prSummary, prDiagram, rangeLabel);
  if (PR_SUMMARY_BLOCK_PATTERN.test(reviewBody))
    return reviewBody.replace(PR_SUMMARY_BLOCK_PATTERN, block);
  const marker = reviewBody.match(/<!-- pi-reviewer:batch:v1 [^>]+ -->\n?/);
  if (marker?.index !== undefined) {
    const at = marker.index + marker[0].length;
    const tail = reviewBody.slice(at).replace(/^\n+/, "");
    return `${reviewBody.slice(0, at)}\n${block}${tail ? `\n\n${tail}` : ""}`.trimEnd();
  }
  return `${block}\n\n${reviewBody}`.trimEnd();
}

function renderExternalSources(
  text: string,
  evidence?: readonly SearchCitation[],
): string | undefined {
  if (!evidence || evidence.length === 0) return undefined;
  const ids = [...text.matchAll(/\[(?:web|ai):\d+\]/g)].map((match) => match[0].slice(1, -1));
  const selected = [...new Set(ids)]
    .map((id) => evidence.find((entry) => entry.id === id))
    .filter((entry): entry is SearchCitation => {
      if (!entry?.url) return false;
      try {
        const url = new URL(entry.url);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    })
    .slice(0, 10);
  if (selected.length === 0) return undefined;
  const items = selected.map(
    (entry) =>
      `- <a href="${escapeHtml(entry.url!)}">${escapeHtml(entry.title ?? "External source")}</a> — ${escapeHtml(entry.provider)}`,
  );
  return `<details>\n<summary>External sources</summary>\n\n${items.join("\n")}\n\n</details>`;
}

/**
 * Build the review body: the summary plus a clearly-marked section listing
 * comments that could not be attached to a diff line. GitHub shows the body as
 * the review's main text, so moved comments stay visible to the author.
 */
function buildReviewBody(
  result: ReviewResult,
  moved: ReviewComment[],
  allComments: ReviewComment[],
  provenance: ReRaiseProvenanceOptions &
    Pick<
      OutputOptions,
      "repo" | "baseCommitId" | "evidence" | "summaryEnabled" | "isFirstReview" | "skippedDiff"
    >,
): string {
  const lines: string[] = [];
  // The footer advertises summary regeneration, so it renders if and only if
  // the block renders: a consumed slot with no summary must not promise one.
  const showSummary = shouldRenderPrSummary(result, provenance);
  if (showSummary)
    lines.push(
      renderPrSummary(
        result.pr_summary!,
        result.pr_diagram,
        prSummaryRangeLabel(provenance.baseCommitId, provenance.commitId),
      ),
      "",
    );
  lines.push(sanitizeVisibleReviewText(result.summary));
  if (provenance.skippedDiff && provenance.skippedDiff.files.length > 0)
    lines.push("", renderSkippedDiffNotice(provenance.skippedDiff));
  const actionable = allComments.filter(
    (comment) => comment.severity === "WARN" || comment.severity === "CRITICAL",
  );
  const prompt = renderAiFixPromptList(
    actionable.map((comment) => ({
      context: comment,
      body: sanitizeVisibleReviewText(comment.body),
    })),
  );
  if (prompt) lines.push("", prompt);
  if (moved.length > 0) {
    lines.push("", "### Comments Not Attached to the Diff", "");
    lines.push(
      "These comments could not be attached to a specific diff line, so the reported location is approximate — the line is not part of the diff:",
    );
    for (const comment of moved) {
      const findingBody = sanitizeVisibleReviewText(normalizeAiFixBody(comment.body));
      const visibleBody = `${reRaiseMetadata(comment, provenance)}${renderFindingSummary({ ...comment, repository: provenance.repo, commitId: provenance.commitId, baseCommitId: provenance.baseCommitId }, findingBody)}${comment.severity === "WARN" || comment.severity === "CRITICAL" ? `\n\n${renderAiFixPrompt(comment, findingBody)}` : ""}`;
      const findingId = bodyFindingId(normalizeFinding(comment));
      lines.push(
        "",
        encodeBodyFindingMarker({
          findingId,
          file: comment.file,
          line: comment.line,
          side: comment.side,
          severity: comment.severity,
          body: `${reRaiseMetadata(comment, provenance)}${findingBody}`,
        }),
        `> ${SEVERITY_EMOJI[comment.severity]} Location could not be verified in this diff`,
        visibleBody,
      );
    }
  }
  const sources = renderExternalSources(
    `${result.summary}\n${allComments.map((comment) => comment.body).join("\n")}`,
    provenance.evidence,
  );
  if (sources) lines.push("", sources);
  if (showSummary) lines.push("", COMMAND_HINT_FOOTER);
  const body = lines.join("\n");
  return body;
}

export function formatForTerminal(result: ReviewResult): string {
  const lines = ["== Review Summary ==", result.summary];

  if (result.comments.length > 0) {
    lines.push("", "== Inline Comments ==");
    for (const comment of result.comments) {
      const visibleBody = sanitizeVisibleReviewText(comment.body);
      lines.push(
        `${SEVERITY_EMOJI[comment.severity]} ${comment.file}:${comment.line} (${comment.side})`,
        visibleBody.replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, "").trim(),
        "",
      );
    }

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  const body = lines.join("\n");
  return hasActionableFindings(result.comments) ? appendAiFixFooter(body) : body;
}

/**
 * Acknowledge the PR without posting a review body: leave a thumbs-up when the
 * review has nothing left to report, and record the reviewed range with the
 * batch marker. The reaction is a function of state, so the caller decides it —
 * a review with open findings must not be greeted with a thumbs-up.
 */
async function acknowledgeWithoutReview(options: OutputOptions, react: boolean): Promise<void> {
  if (!options.githubToken || typeof options.prNumber !== "number" || !options.repo) return;
  const client = new GitHubClient(options.githubToken);
  const repo = options.repo;
  const prNumber = options.prNumber;
  // The acknowledgement claims "the reviewer looked at this commit", so head
  // staleness is verified whenever a commit is pinned — whether or not a batch
  // marker will be written.
  if (options.commitId) {
    const current = await client.getPullRequest(repo, prNumber);
    if (current.head.sha !== options.commitId)
      throw new Error(
        "PR head changed while the review was running; refusing to post a stale review",
      );
  }
  if (!react) {
    console.log("[pi-reviewer] open findings remain — recording the range without a reaction");
  } else {
    try {
      const identity = await client.getUser();
      const reactions = await client.listReactions(repo, prNumber);
      if (
        !reactions.some(
          (reaction) => reaction.content === "+1" && reaction.user?.login === identity.login,
        )
      ) {
        await client.createReaction(repo, prNumber);
        console.log("[pi-reviewer] no findings — left a thumbs-up reaction on the PR");
      } else {
        console.log("[pi-reviewer] no findings — thumbs-up reaction already exists on the PR");
      }
    } catch (error) {
      console.warn(
        `[pi-reviewer] could not leave a thumbs-up reaction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (options.batchMarker && options.commitId) {
    try {
      const markerReview = await client.createReview(
        repo,
        prNumber,
        options.batchMarker,
        options.commitId,
        [],
      );
      if (markerReview.id) {
        const finalized = options.batchMarker.replace(
          /("reviewId"\s*:\s*)0/,
          `$1${markerReview.id}`,
        );
        if (finalized !== options.batchMarker)
          await client
            .updateReview(repo, prNumber, markerReview.id, finalized)
            .catch((error) =>
              console.warn(
                `[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
      }
    } catch (error) {
      console.warn(
        `[pi-reviewer] could not create batch marker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function sendOutput(options: OutputOptions): Promise<OutputMetadata> {
  if (options.none) {
    if (options.target === "comment") {
      if (!options.githubToken) throw new Error("GITHUB_TOKEN is required to post a comment");
      if (typeof options.prNumber !== "number")
        throw new Error("PR number is required to post a comment");
      if (!options.repo) throw new Error("Repository (owner/repo) is required to post a comment");
      if (options.skippedDiff && options.skippedDiff.files.length > 0) {
        // The model saw a truncated diff, so its "nothing to report" is not
        // an all-clear: post the harness-owned notice instead of silently
        // reacting, and record the range without a thumbs-up.
        const repo = options.repo;
        const prNumber = options.prNumber;
        const noticeBody = [options.batchMarker, renderSkippedDiffNotice(options.skippedDiff)]
          .filter(Boolean)
          .join("\n\n");
        if (options.commitId) {
          const client = new GitHubClient(options.githubToken);
          const posted = await client.createReview(
            repo,
            prNumber,
            noticeBody,
            options.commitId,
            [],
          );
          // Finalize the marker with the real review id, like every other
          // posting path: an unfinalized "reviewId":0 would break later
          // batch-range matching against this review.
          if (posted?.id && options.batchMarker) {
            const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${posted.id}`);
            if (finalized !== options.batchMarker)
              await client.updateReview(
                repo,
                prNumber,
                posted.id,
                [finalized, noticeBody].join("\n\n"),
              );
          }
        } else {
          await (
            await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.githubToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ body: noticeBody }),
            })
          ).text();
        }
        await acknowledgeWithoutReview({ ...options, batchMarker: undefined }, false);
      } else {
        await acknowledgeWithoutReview(options, (options.existingFindings?.length ?? 0) === 0);
      }
    } else {
      console.log("[pi-reviewer] no findings to report");
    }
    return { commentIds: [], fallback: false };
  }

  const structuredResult = options.structuredResult;
  if (structuredResult === undefined) {
    throw new Error("Agent output was not a valid structured review: invalid summary");
  }
  const rejectionReason = structuredResultRejection(structuredResult);
  if (rejectionReason) {
    console.warn(`[pi-reviewer] rejected structured result: ${rejectionReason}`);
    throw new Error(`Agent output was not a valid structured review: ${rejectionReason}`);
  }
  const result = normalizeReviewResult(structuredResult, options, true);

  if (options.target === "terminal") {
    console.log(formatForTerminal(result));
    return { commentIds: [], fallback: false };
  }

  if (options.target === "comment") {
    if (!options.githubToken) {
      throw new Error("GITHUB_TOKEN is required to post a comment");
    }

    if (typeof options.prNumber !== "number") {
      throw new Error("PR number is required to post a comment");
    }

    if (!options.repo) {
      throw new Error("Repository (owner/repo) is required to post a comment");
    }

    const headers = {
      Authorization: `Bearer ${options.githubToken}`,
      "Content-Type": "application/json",
    };

    // Split comments into inline (positionable on the diff) and moved (kept in
    // the review body). Without a diff we can't validate positions, so every
    // comment is treated as inline (local/SSH callers, which never pass a diff).
    const unique = new Map<string, ReviewComment>();
    for (const comment of result.comments) unique.set(normalizeFinding(comment), comment);
    const comments = [...unique.values()];
    let inline = comments;
    let moved: ReviewComment[] = [];
    if (options.diff) {
      const positions = parseDiffPositions(options.diff);
      ({ inline, moved } = partitionComments(comments, positions));
      if (moved.length > 0) {
        console.log(
          `[pi-reviewer] ${moved.length} comment(s) not positionable on the diff — moved to review body`,
        );
      }
    }

    // Keep suggestion fences in inline payloads; review bodies carry lifecycle metadata.
    const inlineComments = inline.map((comment) => ({
      path: comment.file,
      line: comment.line,
      side: comment.side,
      body: `<!-- pi-reviewer:finding:v1 -->\n${appendGitHubSuggestion(comment, appendFindingFooter(comment, `${reRaiseMetadata(comment, options)}${sanitizeVisibleReviewText(comment.body)}`))}`,
    }));

    const body = [options.batchMarker, buildReviewBody(result, moved, comments, options)]
      .filter(Boolean)
      .join("\n\n");

    // A review with nothing to report — no new comments and nothing left
    // outstanding — is acknowledged with a thumbs-up instead of a body. The
    // reaction is a function of state, not of which action the model declared,
    // so a model that writes a "nothing to flag" summary still gets one. The
    // emit-once overview is the one body a findings-free review still publishes,
    // so the acknowledgement stands down for that run. A body is still posted
    // when files were skipped: a thumbs-up must never claim unreviewed files
    // were covered.
    let outstandingFindings = new Set<number>(options.existingFindings?.map((f) => f.commentId));
    // Only reconcile when the model actually supplied updates: with none, the
    // outstanding set is unchanged and the call would be pure overhead.
    if (
      result.comments.length === 0 &&
      options.existingFindings?.length &&
      options.commitId &&
      result.finding_updates?.length
    ) {
      outstandingFindings = await reconcileFindingUpdates({
        token: options.githubToken,
        repo: options.repo,
        prNumber: options.prNumber,
        targetSha: options.commitId,
        updates: result.finding_updates ?? [],
        findings: options.existingFindings,
      });
    }
    const postsSummaryBody = Boolean(
      options.summaryEnabled && options.isFirstReview && result.pr_summary?.trim(),
    );
    if (
      result.comments.length === 0 &&
      outstandingFindings.size === 0 &&
      !postsSummaryBody &&
      !(options.skippedDiff && options.skippedDiff.files.length > 0)
    ) {
      await acknowledgeWithoutReview(options, true);
      return { commentIds: [], fallback: false };
    }

    if (options.commitId && options.batchMarker) {
      const current = await new GitHubClient(options.githubToken).getPullRequest(
        options.repo,
        options.prNumber,
      );
      if (current.head.sha !== options.commitId)
        throw new Error(
          "PR head changed while the review was running; refusing to post a stale batch",
        );
    }

    // Try PR Reviews API first (supports inline comments and a body).
    if (options.commitId) {
      console.log(
        `[pi-reviewer] posting review with ${inlineComments.length} inline comment(s)` +
          (moved.length > 0 ? ` and ${moved.length} comment(s) in body` : ""),
      );
      let reviewResponse = await fetch(
        `https://api.github.com/repos/${options.repo}/pulls/${options.prNumber}/reviews`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            commit_id: options.commitId,
            body,
            event: "COMMENT",
            comments: inlineComments,
          }),
        },
      );
      if (reviewResponse.ok) {
        console.log("[pi-reviewer] review posted with inline comments");
        if (options.batchMarker && options.githubToken && options.repo && options.prNumber) {
          const posted = (await reviewResponse
            .clone()
            .json()
            .catch(() => undefined)) as { id?: number } | undefined;
          if (posted?.id) {
            const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${posted.id}`);
            if (finalized !== options.batchMarker)
              await new GitHubClient(options.githubToken)
                .updateReview(
                  options.repo,
                  options.prNumber,
                  posted.id,
                  [finalized, buildReviewBody(result, moved, comments, options)].join("\n\n"),
                )
                .catch((error) =>
                  console.warn(
                    `[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                );
          }
        }
        if (
          result.finding_updates?.length &&
          options.existingFindings &&
          options.githubToken &&
          options.repo &&
          options.prNumber &&
          options.commitId
        ) {
          await reconcileFindingUpdates({
            token: options.githubToken,
            repo: options.repo,
            prNumber: options.prNumber,
            targetSha: options.commitId,
            updates: result.finding_updates,
            findings: options.existingFindings,
          });
        }
        if (comments.length > 0)
          await clearStaleThumbsUp(options.githubToken, options.repo, options.prNumber);
        const posted = await responseJson(reviewResponse);
        return {
          reviewId: posted?.id,
          commentIds: posted?.comments?.flatMap((c) => (c.id ? [c.id] : [])) ?? [],
          fallback: false,
        };
      }
      let errBody = await reviewResponse.text().catch(() => "");
      console.warn(
        `[pi-reviewer] inline comments rejected (${reviewResponse.status}) — ${errBody}`,
      );

      // A 422 means GitHub couldn't resolve at least one position we thought was
      // valid (e.g. a force-push changed the diff between resolution and post).
      // Retry once as a body-only review, moving every comment into the body.
      if (reviewResponse.status === 422) {
        const allMovedBody = [
          options.batchMarker,
          buildReviewBody(result, comments, comments, options),
        ]
          .filter(Boolean)
          .join("\n\n");
        reviewResponse = await fetch(
          `https://api.github.com/repos/${options.repo}/pulls/${options.prNumber}/reviews`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              commit_id: options.commitId,
              body: allMovedBody,
              event: "COMMENT",
              comments: [],
            }),
          },
        );
        if (reviewResponse.ok) {
          console.log("[pi-reviewer] review posted as body-only (inline positions rejected)");
          if (options.batchMarker && options.githubToken && options.repo && options.prNumber) {
            const posted = (await reviewResponse
              .clone()
              .json()
              .catch(() => undefined)) as { id?: number } | undefined;
            if (posted?.id) {
              const finalized = options.batchMarker.replace(
                /("reviewId"\s*:\s*)0/,
                `$1${posted.id}`,
              );
              if (finalized !== options.batchMarker)
                await new GitHubClient(options.githubToken)
                  .updateReview(
                    options.repo,
                    options.prNumber,
                    posted.id,
                    [finalized, allMovedBody].join("\n\n"),
                  )
                  .catch((error) =>
                    console.warn(
                      `[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  );
            }
          }
          if (
            result.finding_updates?.length &&
            options.existingFindings &&
            options.githubToken &&
            options.repo &&
            options.prNumber &&
            options.commitId
          )
            await reconcileFindingUpdates({
              token: options.githubToken,
              repo: options.repo,
              prNumber: options.prNumber,
              targetSha: options.commitId,
              updates: result.finding_updates,
              findings: options.existingFindings,
            });
          if (comments.length > 0)
            await clearStaleThumbsUp(options.githubToken, options.repo, options.prNumber);
          const posted = await responseJson(reviewResponse);
          return {
            reviewId: posted?.id,
            commentIds: posted?.comments?.flatMap((c) => (c.id ? [c.id] : [])) ?? [],
            fallback: true,
          };
        }
        errBody = await reviewResponse.text().catch(() => "");
        console.warn(
          `[pi-reviewer] body-only review rejected (${reviewResponse.status}) — ${errBody}`,
        );
      }
    }

    // Last-resort fallback: Issues Comments API (hard failures, no commitId, or
    // an all-unpositionable summary-only review).
    const issueResponse = await fetch(
      `https://api.github.com/repos/${options.repo}/issues/${options.prNumber}/comments`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          body: [options.batchMarker, formatForGitHub(result, options)]
            .filter(Boolean)
            .join("\n\n"),
        }),
      },
    );

    if (!issueResponse.ok) {
      const body = await issueResponse.text().catch(() => "(unreadable)");
      throw new Error(
        `Failed to post GitHub comment: ${issueResponse.status} ${issueResponse.statusText}\n${body}`,
      );
    }

    console.log("[pi-reviewer] review comment posted");
    if (comments.length > 0)
      await clearStaleThumbsUp(options.githubToken, options.repo, options.prNumber);
    const posted = await responseJson(issueResponse);
    return { commentIds: posted?.id ? [posted.id] : [], fallback: true };
  }

  const cwd = options.cwd ?? process.cwd();
  const filePath = path.join(cwd, "pi-review.md");
  await writeFile(filePath, formatForTerminal(result), "utf-8");
  console.log(`[pi-reviewer] review saved to ${filePath}`);
  return { commentIds: [], fallback: false };
}
