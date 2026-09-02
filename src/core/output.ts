import { writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDiffPositions, partitionComments } from "./diff-positions.js";
import { GitHubClient } from "../ci/github.js";
import { bodyFindingId, decodeBodyFindingMarkers, encodeBodyFindingMarker, updateBodyFindingMarker } from "../ci/batch.js";
import { AI_FIX_FOOTER, appendAiFixFooter } from "./ai-fix-footer.js";

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
  resolved_finding_id?: string;
  re_raise_reason?: "REINTRODUCED" | "MATERIALLY_CHANGED" | "CONTRADICTORY_EVIDENCE";
  re_raise_evidence?: string;
  /** Server-validated re-raise provenance attached by normalizeReviewResult; model-supplied values are always overwritten. */
  reRaiseProvenance?: { historicalFindingId: string; reason?: ReviewComment["re_raise_reason"]; evidence?: string };
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
  /** Raw diff included by the agent in SSH+UI mode */
  diff?: string;
  tokenUsage?: TokenUsage;
}

export interface FindingUpdate {
  comment_id: number;
  status: "RESOLVED" | "PARTIALLY_RESOLVED" | "STILL_OPEN";
  explanation: string;
}

export interface ParsedAgentResponse {
  result: ReviewResult;
  /** True only when the response contained a valid review-shaped JSON object. */
  parsed: boolean;
  /** Safe diagnostic for a rejected text fallback; never contains model content. */
  rejectionReason?: "malformed JSON" | "invalid summary" | "invalid comments" | "invalid finding_updates";
}

export interface OutputOptions {
  target: OutputTarget;
  content?: string;
  /** Schema-validated result from submit_review. When present, content is not parsed. */
  structuredResult?: ReviewResult;
  cwd?: string;
  githubToken?: string;
  prNumber?: number;
  repo?: string;
  commitId?: string;
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
  /** React to the pull request instead of posting a comment when no findings remain. */
  reactOnNoFindings?: boolean;
}
export interface ResolvedFinding { historicalFindingId: string; file?: string; line?: number; side?: string; originalBody: string; kind?: "inline" | "body"; }
export interface OutputMetadata { reviewId?: number; commentIds: number[]; fallback: boolean }
async function responseJson(response: Response): Promise<{ id?: number; comments?: Array<{ id?: number }> } | undefined> {
  if (typeof response.json !== "function") return undefined;
  try { return await response.json() as { id?: number; comments?: Array<{ id?: number }> }; } catch { return undefined; }
}

export interface ExistingFinding { commentId: number; threadId?: string; body?: string; reviewId?: number; issueCommentId?: number; bodyFinding?: boolean; reviewBody?: string; }

const FINDING_STATUSES = ["RESOLVED", "PARTIALLY_RESOLVED", "STILL_OPEN"] as const;

function findingUpdateRejection(update: unknown, allowedFindingIds?: ReadonlySet<number>): { update?: FindingUpdate; reason: string; commentId: unknown; status: unknown } {
  const value = update && typeof update === "object" ? update as Record<string, unknown> : {};
  const commentId = value.comment_id;
  const status = value.status;
  if (!Number.isInteger(commentId)) return { reason: "comment_id is not an integer", commentId, status };
  if (allowedFindingIds && !allowedFindingIds.has(commentId as number)) return { reason: "unknown active-finding ID", commentId, status };
  if (!FINDING_STATUSES.includes(status as typeof FINDING_STATUSES[number])) return { reason: "invalid status", commentId, status };
  if (typeof value.explanation !== "string") return { reason: "explanation is not a string", commentId, status };
  if (value.explanation.length > 2000) return { reason: "explanation exceeds 2000 characters", commentId, status };
  return { update: { comment_id: commentId as number, status: status as FindingUpdate["status"], explanation: value.explanation }, reason: "", commentId, status };
}

function formatDiagnosticValue(value: unknown, kind: "comment_id" | "status"): string {
  if (kind === "comment_id" && typeof value === "number" && Number.isFinite(value)) return String(value);
  if (kind === "status" && typeof value === "string" && FINDING_STATUSES.includes(value as typeof FINDING_STATUSES[number])) return value;
  return "invalid";
}

function structuredResultRejection(value: unknown): "invalid summary" | "invalid comments" | "invalid finding_updates" | undefined {
  if (!value || typeof value !== "object") return "invalid summary";
  const result = value as Record<string, unknown>;
  if (typeof result.summary !== "string") return "invalid summary";
  if (!Array.isArray(result.comments) || !result.comments.every(isReviewComment)) return "invalid comments";
  if (result.finding_updates !== undefined && !Array.isArray(result.finding_updates)) return "invalid finding_updates";
  return undefined;
}

/** Normalize tool output while isolating contextual finding validation from the review itself. */
function normalizeReviewResult(result: ReviewResult, options: Pick<OutputOptions, "minSeverity" | "allowedFindingIds" | "existingFindingKeys" | "resolvedFindings" | "commitId" | "batchMarker">, warnInvalidUpdates: boolean): ReviewResult {
  const minRank = SEVERITY_RANK[options.minSeverity ?? "INFO"];
  const comments = result.comments
    .map((comment) => ({ ...comment, severity: normalizeSeverity(comment.severity) }))
    .filter((comment) => SEVERITY_RANK[comment.severity] >= minRank)
    .filter((comment) => !options.existingFindingKeys?.has(normalizeFinding(comment)))
    .filter((comment) => {
      const history = options.resolvedFindings ?? [];
      if (comment.resolved_finding_id && !history.some(f => f.historicalFindingId === comment.resolved_finding_id)) {
        console.warn("[pi-reviewer] dropped re-raise: unknown historical finding ID");
        return false;
      }
      const cited = comment.resolved_finding_id ? history.find(f => f.historicalFindingId === comment.resolved_finding_id) : undefined;
      if (cited && !hasCompatibleHistoricalLink(comment, cited)) {
        console.warn("[pi-reviewer] dropped re-raise: historical finding does not match candidate");
        return false;
      }
      const match = cited
        ?? history.find(f => hasMatchingFindingIdentity(comment, f));
      if (!match) return true;
      // Identity matches without an explicit historical link stay suppressed,
      // so the ID equality check below is what enforces the provenance link.
      const valid = comment.resolved_finding_id === match.historicalFindingId && ["REINTRODUCED", "MATERIALLY_CHANGED", "CONTRADICTORY_EVIDENCE"].includes(comment.re_raise_reason ?? "") && typeof comment.re_raise_evidence === "string" && comment.re_raise_evidence.trim().length > 0 && comment.re_raise_evidence.length <= 2000;
      if (!valid) console.warn("[pi-reviewer] dropped re-raise: invalid provenance");
      return valid;
    })
    .map((comment) => {
      const emoji = SEVERITY_EMOJI[comment.severity];
      const prefix = ["🔴 ", "🟡 ", "🔵 "].find((value) => comment.body.startsWith(value));
      const body = prefix ? comment.body.slice(prefix.length) : comment.body;
      // Provenance is derived only from fields validated by the filter above;
      // reassigning the key here also drops any model-supplied value.
      const historical = (options.resolvedFindings ?? []).find(f => f.historicalFindingId === comment.resolved_finding_id);
      const reRaiseProvenance = historical ? { historicalFindingId: historical.historicalFindingId, reason: comment.re_raise_reason, evidence: comment.re_raise_evidence } : undefined;
      return { ...comment, body: `${emoji} ${body}`, reRaiseProvenance };
    });
  const updates: FindingUpdate[] = [];
  for (const candidate of result.finding_updates ?? []) {
    const checked = findingUpdateRejection(candidate, options.allowedFindingIds);
    if (checked.update) updates.push(checked.update);
    else if (warnInvalidUpdates) {
      console.warn(`[pi-reviewer] dropped finding update comment_id=${formatDiagnosticValue(checked.commentId, "comment_id")}${checked.status === undefined ? "" : ` status=${formatDiagnosticValue(checked.status, "status")}`} reason=${checked.reason}`);
    }
  }
  return { summary: result.summary, comments, ...(updates.length ? { finding_updates: updates } : {}), ...(result.diff !== undefined ? { diff: result.diff } : {}) };
}

/** Applies model-approved transitions independently so a failed mutation can be retried safely. */
export async function reconcileFindingUpdates(options: { token: string; repo: string; prNumber: number; targetSha: string; updates: FindingUpdate[]; findings: ExistingFinding[] }): Promise<Set<number>> {
  const client = new GitHubClient(options.token);
  const known = new Map(options.findings.map(f => [f.commentId, f]));
  const outstanding = new Set(options.findings.map(f => f.commentId));
  const hasMutations = options.updates.some(update => update.status !== "STILL_OPEN");
  const identity = hasMutations ? await client.getUser() : undefined;
  if (identity) {
    const current = await client.getPullRequest(options.repo, options.prNumber);
    if (current.head.sha !== options.targetSha) {
      console.warn("[pi-reviewer] PR head changed before reconciliation; leaving lifecycle state unchanged");
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
    if (finding.bodyFinding && (finding.reviewId || finding.issueCommentId) && finding.reviewBody !== undefined) {
      const key = finding.reviewId ? `review:${finding.reviewId}` : `issue:${finding.issueCommentId}`;
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
        ? await client.request<{ body?: string }>(`/repos/${options.repo}/issues/comments/${group.finding.issueCommentId}`)
        : await client.getReview(options.repo, options.prNumber, Number(reviewKey.slice("review:".length)));
      if (typeof freshReview.body !== "string") {
        console.warn(`[pi-reviewer] could not update body source ${reviewKey}: fetched source has no body`);
        continue;
      }
      updatedBody = freshReview.body;
    } catch (error) {
      console.warn(`[pi-reviewer] could not fetch body source ${reviewKey}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const changedFindingIds = new Set<number>();
    for (const update of group.updates) {
      const currentMarker = decodeBodyFindingMarkers(updatedBody).find(marker => marker.findingId === update.comment_id);
      if (currentMarker?.targetSha === options.targetSha && currentMarker.status === update.status && currentMarker.explanation === update.explanation) {
        if (update.status === "RESOLVED") outstanding.delete(update.comment_id);
        continue;
      }
      const nextBody = updateBodyFindingMarker(updatedBody, update.comment_id, update.status, options.targetSha, update.explanation);
      if (nextBody !== updatedBody) {
        updatedBody = nextBody;
        changedFindingIds.add(update.comment_id);
      }
    }
    if (updatedBody === group.finding.reviewBody || !await isTargetHeadCurrent()) continue;
    try {
      if (group.finding.issueCommentId) await client.updateIssueComment(options.repo, options.prNumber, group.finding.issueCommentId, updatedBody);
      else await client.updateReview(options.repo, options.prNumber, Number(reviewKey.slice("review:".length)), updatedBody);
      for (const update of group.updates) {
        if (update.status === "RESOLVED" && changedFindingIds.has(update.comment_id)) outstanding.delete(update.comment_id);
      }
    } catch (error) {
      console.warn(`[pi-reviewer] could not update body source ${reviewKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const update of options.updates) {
    const finding = known.get(update.comment_id);
    if (!finding || update.status === "STILL_OPEN") continue;
    if (finding.bodyFinding && (finding.reviewId || finding.issueCommentId) && finding.reviewBody !== undefined) continue;
    const linkedSha = options.targetSha.slice(0, 7);
    const body = `<!-- pi-reviewer:status:v1 ${JSON.stringify({ findingId: update.comment_id, targetSha: options.targetSha, status: update.status })} -->\n${update.status === "RESOLVED" ? `Resolved by ${linkedSha}` : `Partially addressed by ${linkedSha}`}: ${update.explanation}`;
    const alreadyReplied = priorReplies.some(reply => reply.user?.login === identity?.login && reply.in_reply_to_id === finding.commentId && reply.body.includes(`"targetSha":"${options.targetSha}"`) && reply.body.includes(`"status":"${update.status}"`));
    try {
      if (!alreadyReplied) {
        // Recheck after loading all replies and immediately before persisting
        // lifecycle state; the initial guard can be separated from this point
        // by a slow paginated API response.
        if (!await isTargetHeadCurrent()) {
          console.warn(`[pi-reviewer] PR head changed before replying to finding ${finding.commentId}; leaving lifecycle state unchanged`);
          continue;
        }
        await client.reply(options.repo, options.prNumber, finding.commentId, body);
      }
    } catch (error) {
      console.warn(`[pi-reviewer] could not reply to finding ${finding.commentId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (update.status === "RESOLVED" && finding.threadId) {
      try {
        // Revalidate immediately before the destructive mutation. The review
        // may have taken long enough for the PR head to advance since the
        // initial post-time guard.
        if (!await isTargetHeadCurrent()) {
          console.warn(`[pi-reviewer] PR head changed before resolving finding ${finding.commentId}; leaving thread open`);
          continue;
        }
        await client.resolveThread(finding.threadId);
      }
      catch (error) { console.warn(`[pi-reviewer] could not resolve finding ${finding.commentId}; will retry resolution: ${error instanceof Error ? error.message : String(error)}`); continue; }
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
        if (part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text") {
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
    typeof comment.body === "string"
  );
}

/** A candidate substring tagged with its start index in the original text. */
interface Candidate {
  content: string;
  index: number;
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
    blocks.push({ content: m[1].trim(), index: m.index });
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
  let depth = 0, start = -1, inString = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === "\\" && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push({ content: text.slice(start, i + 1), index: start });
          start = -1;
        }
      }
    }
  }
  return objects;
}

function tryParseJSON(raw: string): Record<string, unknown> | null {
  let escaped = "";
  let inString = false;
  let escape = false;
  for (const c of raw) {
    const code = c.charCodeAt(0);
    if (escape) {
      escaped += c;
      escape = false;
    } else if (c === "\\" && inString) {
      escaped += c;
      escape = true;
    } else if (c === '"') {
      escaped += c;
      inString = !inString;
    } else if (inString && c === "\n") escaped += "\\n";
    else if (inString && c === "\r") escaped += "\\r";
    else if (inString && c === "\t") escaped += "\\t";
    else if (inString && code >= 0 && code <= 0x1f) continue;
    else escaped += c;
  }

  for (const candidate of [raw, escaped]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not valid JSON
    }
  }
  return null;
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
    { content: text.trim(), index: 0 },
    ...extractAllFencedBlocks(text),
    ...extractAllJsonObjects(text),
  ];
  candidates.sort((a, b) => a.index - b.index);

  // No early return: last-wins requires a full scan.
  let resultWithComments: ReviewResult | null = null;
  let resultAny: ReviewResult | null = null;
  let rejectionReason: ParsedAgentResponse["rejectionReason"] = "malformed JSON";

  for (const { content } of candidates) {
    const parsed = tryParseJSON(content);
    if (parsed) {
      rejectionReason = typeof parsed.summary !== "string"
        ? "invalid summary"
        : !Array.isArray(parsed.comments) || !parsed.comments.every(isReviewComment)
          ? "invalid comments"
          : (parsed.finding_updates !== undefined && (!Array.isArray(parsed.finding_updates) || !parsed.finding_updates.every((u) => findingUpdateRejection(u, allowedFindingIds).update !== undefined)))
            ? "invalid finding_updates"
            : rejectionReason;
    }
    const rawUpdates = parsed && Array.isArray(parsed.finding_updates) ? parsed.finding_updates : [];
    const updatesValid = rawUpdates.every((u) => findingUpdateRejection(u, allowedFindingIds).update !== undefined);
    if (
      parsed &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.comments) &&
      parsed.comments.every(isReviewComment) && updatesValid
    ) {
      const diff = typeof parsed.diff === "string" ? parsed.diff : undefined;
      const review = normalizeReviewResult({ summary: parsed.summary, comments: parsed.comments as ReviewComment[], finding_updates: rawUpdates as FindingUpdate[], ...(diff !== undefined ? { diff } : {}) }, { minSeverity, allowedFindingIds, existingFindingKeys, resolvedFindings, ...provenance }, false);
      resultAny = review;
      // Base the preference on what the model emitted, not on what remains
      // after minSeverity filtering. A genuine review whose findings are all
      // below the configured threshold must still beat an earlier draft.
      if (parsed.comments.length > 0) resultWithComments = review;
    }
  }

  // Prefer the last review with comments; fall back to last review overall.
  const result = resultWithComments ?? resultAny;
  if (result) return { result, parsed: true };

  return { result: { summary: text, comments: [] }, parsed: false, rejectionReason };
}

/** Stable identity used to avoid reposting the same finding in a batch. */
export function normalizeFinding(comment: Pick<ReviewComment, "file" | "line" | "side" | "body">): string {
  const storedBody = decodeBodyFindingMarkers(comment.body)[0]?.body;
  const body = (storedBody ?? comment.body).replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, "").replace(AI_FIX_FOOTER, "").trim().replace(/^[🔴🟡🔵]\s*/u, "").trim().replace(/\n\s*\n+/g, "\n");
  return [comment.file, comment.line, comment.side, body].join("\0");
}

/** Normalizes visible finding prose for resilient historical identity matching. */
function normalizedFindingBody(body: string): string {
  return body.replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, "").replace(AI_FIX_FOOTER, "").replace(/^[🔴🟡🔵]\s*/u, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Checks the file, side, and normalized prose identity of two findings. */
function hasMatchingFindingIdentity(candidate: ReviewComment, historical: ResolvedFinding): boolean {
  if (historical.file !== candidate.file || historical.side !== candidate.side) return false;
  const candidateBody = normalizedFindingBody(candidate.body);
  const historicalBody = normalizedFindingBody(historical.originalBody);
  if (candidateBody === historicalBody) return true;
  const left = new Set(candidateBody.split(/\s+/).filter(Boolean));
  const right = new Set(historicalBody.split(/\s+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return false;
  const overlap = [...left].filter(token => right.has(token)).length;
  return overlap / Math.max(left.size, right.size) >= 0.6;
}

/** Validates that a cited historical ID belongs to the candidate finding. */
function hasCompatibleHistoricalLink(candidate: ReviewComment, historical: ResolvedFinding): boolean {
  if (historical.file !== candidate.file || historical.side !== candidate.side) return false;
  return historical.line === candidate.line || hasMatchingFindingIdentity(candidate, historical);
}

/** Returns whether a review contains a finding requiring an explicit fix. */
function hasActionableFindings(comments: ReviewComment[]): boolean {
  return comments.some(comment => comment.severity === "WARN" || comment.severity === "CRITICAL");
}

/** Adds the fix instruction only to actionable individual findings. */
function appendFindingFooter(comment: ReviewComment, body: string): string {
  return comment.severity === "WARN" || comment.severity === "CRITICAL" ? appendAiFixFooter(body) : body;
}

/** Keep model-controlled text from becoming metadata when it is shown in a review body. */
function sanitizeVisibleReviewText(text: string): string {
  return text.replace(/<!--\s*pi-reviewer\s*:/gi, "<!-- pi-reviewer :");
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
  const json = JSON.stringify({ historicalFindingId: provenance.historicalFindingId, reason: provenance.reason, evidence: provenance.evidence, newFindingId: normalizeFinding(comment), targetSha: options.commitId, batch: options.batchMarker }).replace(/-->/g, "--\\u003e");
  return `<!-- pi-reviewer:re-raise:v1 ${json} -->\n`;
}

export function parseAgentResponse(text: string, minSeverity: Severity = "INFO"): ReviewResult {
  return parseAgentResponseWithStatus(text, minSeverity).result;
}

function formatForGitHub(result: ReviewResult, provenance: ReRaiseProvenanceOptions): string {
  const lines = ["## Pi Reviewer", "", sanitizeVisibleReviewText(result.summary)];

  if (result.comments.length > 0) {
    lines.push("", "### Inline Comments");
    for (const comment of result.comments) {
      const visibleBody = appendFindingFooter(comment, `${reRaiseMetadata(comment, provenance)}${sanitizeVisibleReviewText(comment.body)}`);
      lines.push(
        "",
        encodeBodyFindingMarker({ findingId: bodyFindingId(normalizeFinding(comment)), file: comment.file, line: comment.line, side: comment.side, severity: comment.severity, body: visibleBody }),
        `${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side}`,
        visibleBody
      );
    }
  }

  const body = lines.join("\n");
  return hasActionableFindings(result.comments) ? appendAiFixFooter(body) : body;
}

/**
 * Build the review body: the summary plus a clearly-marked section listing
 * comments that could not be attached to a diff line. GitHub shows the body as
 * the review's main text, so moved comments stay visible to the author.
 */
function buildReviewBody(summary: string, moved: ReviewComment[], provenance: ReRaiseProvenanceOptions, includeFooter: boolean): string {
  if (moved.length === 0) return includeFooter ? appendAiFixFooter(sanitizeVisibleReviewText(summary)) : sanitizeVisibleReviewText(summary);
  const lines = [sanitizeVisibleReviewText(summary), "", "### Comments Not Attached to the Diff", ""];
  lines.push("These comments could not be attached to a specific diff line, so the reported location is approximate — the line is not part of the diff:");
  for (const comment of moved) {
    const visibleBody = appendFindingFooter(comment, `${reRaiseMetadata(comment, provenance)}${sanitizeVisibleReviewText(comment.body)}`);
    const findingId = bodyFindingId(normalizeFinding(comment));
    lines.push(
      "",
      encodeBodyFindingMarker({ findingId, file: comment.file, line: comment.line, side: comment.side, severity: comment.severity, body: visibleBody }),
      `> ${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side} — location could not be verified`,
      visibleBody
    );
  }
  const body = lines.join("\n");
  return includeFooter ? appendAiFixFooter(body) : body;
}

export function formatForTerminal(result: ReviewResult): string {
  const lines = ["== Review Summary ==", result.summary];

  if (result.comments.length > 0) {
    lines.push("", "== Inline Comments ==");
    for (const comment of result.comments) {
      const visibleBody = appendFindingFooter(comment, sanitizeVisibleReviewText(comment.body));
      lines.push(
        `${SEVERITY_EMOJI[comment.severity]} ${comment.file}:${comment.line} (${comment.side})`,
        visibleBody.replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, "").trim(),
        ""
      );
    }

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  const body = lines.join("\n");
  return hasActionableFindings(result.comments) ? appendAiFixFooter(body) : body;
}

export async function sendOutput(options: OutputOptions): Promise<OutputMetadata> {
  let parsedResponse: ParsedAgentResponse;
  if (options.structuredResult !== undefined) {
    const rejectionReason = structuredResultRejection(options.structuredResult);
    if (rejectionReason) {
      console.warn(`[pi-reviewer] rejected structured result: ${rejectionReason}`);
      throw new Error(`Agent output was not a valid structured review: ${rejectionReason}`);
    }
    parsedResponse = { result: normalizeReviewResult(options.structuredResult, options, true), parsed: true };
  } else {
    parsedResponse = parseAgentResponseWithStatus(options.content ?? "", options.minSeverity, options.allowedFindingIds, options.existingFindingKeys, options.resolvedFindings, options);
  }
  const result = parsedResponse.result;

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

    if (!parsedResponse.parsed) {
      console.warn(`[pi-reviewer] rejected text fallback: ${parsedResponse.rejectionReason ?? "invalid structured review"}`);
      throw new Error(
        "Agent output was not a valid structured review; refusing to post raw model output",
      );
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
          `[pi-reviewer] ${moved.length} comment(s) not positionable on the diff — moved to review body`
        );
      }
    }

    const inlineComments = inline.map((comment) => ({
      path: comment.file,
      line: comment.line,
      side: comment.side,
      body: `<!-- pi-reviewer:finding:v1 -->\n${appendFindingFooter(comment, `${reRaiseMetadata(comment, options)}${sanitizeVisibleReviewText(comment.body)}`)}`,
    }));

    const body = [options.batchMarker, buildReviewBody(result.summary, moved, options, hasActionableFindings(result.comments))].filter(Boolean).join("\n\n");

    if (options.commitId && (options.batchMarker || (options.reactOnNoFindings && result.comments.length === 0))) {
      const current = await new GitHubClient(options.githubToken).getPullRequest(options.repo, options.prNumber);
      if (current.head.sha !== options.commitId) throw new Error("PR head changed while the review was running; refusing to post a stale batch");
    }

    let outstandingFindings = new Set<number>(options.existingFindings?.map(f => f.commentId));
    let findingUpdatesReconciled = false;
    if (options.reactOnNoFindings && result.comments.length === 0 && options.existingFindings && options.commitId) {
      outstandingFindings = await reconcileFindingUpdates({ token: options.githubToken, repo: options.repo, prNumber: options.prNumber, targetSha: options.commitId, updates: result.finding_updates ?? [], findings: options.existingFindings });
      findingUpdatesReconciled = true;
    }

    if (options.reactOnNoFindings && result.comments.length === 0 && outstandingFindings.size === 0) {
      const client = new GitHubClient(options.githubToken);
      let reactionSucceeded = false;
      try {
        const identity = await client.getUser();
        const reactions = await client.listReactions(options.repo, options.prNumber);
        if (!reactions.some(reaction => reaction.content === "+1" && reaction.user?.login === identity.login)) {
          await client.createReaction(options.repo, options.prNumber);
          console.log("[pi-reviewer] no findings — left a thumbs-up reaction on the PR");
        } else {
          console.log("[pi-reviewer] no findings — thumbs-up reaction already exists on the PR");
        }
        reactionSucceeded = true;
      } catch (error) {
        console.warn(`[pi-reviewer] could not leave a thumbs-up reaction: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!reactionSucceeded) {
        console.warn("[pi-reviewer] falling back to the normal no-findings comment");
      } else {
        // Keep the authenticated batch marker without adding visible review text.
        // Reactions have no metadata, so the hidden review marker remains the
        // durable range state used by the lifecycle reconciler.
        let markerCreated = true;
        if (options.batchMarker && options.commitId) {
          try {
            const markerReview = await client.createReview(options.repo, options.prNumber, options.batchMarker, options.commitId, []);
            if (markerReview.id) {
              const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${markerReview.id}`);
              if (finalized !== options.batchMarker) await client.updateReview(options.repo, options.prNumber, markerReview.id, finalized).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
            }
          } catch (error) {
            markerCreated = false;
            console.warn(`[pi-reviewer] could not create batch marker: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (markerCreated) return { commentIds: [], fallback: false };
        console.warn("[pi-reviewer] falling back to the normal no-findings comment");
      }
    }

    // Try PR Reviews API first (supports inline comments and a body).
    if (options.commitId) {
      console.log(
        `[pi-reviewer] posting review with ${inlineComments.length} inline comment(s)` +
          (moved.length > 0 ? ` and ${moved.length} comment(s) in body` : "")
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
        }
      );
      if (reviewResponse.ok) {
        console.log("[pi-reviewer] review posted with inline comments");
        if (options.batchMarker && options.githubToken && options.repo && options.prNumber) {
          const posted = await reviewResponse.clone().json().catch(() => undefined) as { id?: number } | undefined;
          if (posted?.id) {
            const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${posted.id}`);
            if (finalized !== options.batchMarker) await new GitHubClient(options.githubToken).updateReview(options.repo, options.prNumber, posted.id, [finalized, buildReviewBody(result.summary, moved, options, hasActionableFindings(result.comments))].join("\n\n")).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
        if (!findingUpdatesReconciled && result.finding_updates?.length && options.existingFindings && options.githubToken && options.repo && options.prNumber && options.commitId) {
          await reconcileFindingUpdates({ token: options.githubToken, repo: options.repo, prNumber: options.prNumber, targetSha: options.commitId, updates: result.finding_updates, findings: options.existingFindings });
        }
        const posted = await responseJson(reviewResponse);
        return { reviewId: posted?.id, commentIds: posted?.comments?.flatMap(c => c.id ? [c.id] : []) ?? [], fallback: false };
      }
      let errBody = await reviewResponse.text().catch(() => "");
      console.warn(
        `[pi-reviewer] inline comments rejected (${reviewResponse.status}) — ${errBody}`
      );

      // A 422 means GitHub couldn't resolve at least one position we thought was
      // valid (e.g. a force-push changed the diff between resolution and post).
      // Retry once as a body-only review, moving every comment into the body.
      if (reviewResponse.status === 422) {
        const allMovedBody = [options.batchMarker, buildReviewBody(result.summary, comments, options, hasActionableFindings(result.comments))].filter(Boolean).join("\n\n");
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
          }
        );
        if (reviewResponse.ok) {
          console.log("[pi-reviewer] review posted as body-only (inline positions rejected)");
          if (options.batchMarker && options.githubToken && options.repo && options.prNumber) {
            const posted = await reviewResponse.clone().json().catch(() => undefined) as { id?: number } | undefined;
            if (posted?.id) {
              const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${posted.id}`);
              if (finalized !== options.batchMarker) await new GitHubClient(options.githubToken).updateReview(options.repo, options.prNumber, posted.id, [finalized, allMovedBody].join("\n\n")).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
            }
          }
          if (!findingUpdatesReconciled && result.finding_updates?.length && options.existingFindings && options.githubToken && options.repo && options.prNumber && options.commitId) await reconcileFindingUpdates({ token: options.githubToken, repo: options.repo, prNumber: options.prNumber, targetSha: options.commitId, updates: result.finding_updates, findings: options.existingFindings });
          const posted = await responseJson(reviewResponse);
          return { reviewId: posted?.id, commentIds: posted?.comments?.flatMap(c => c.id ? [c.id] : []) ?? [], fallback: true };
        }
        errBody = await reviewResponse.text().catch(() => "");
        console.warn(
          `[pi-reviewer] body-only review rejected (${reviewResponse.status}) — ${errBody}`
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
        body: JSON.stringify({ body: [options.batchMarker, formatForGitHub(result, options)].filter(Boolean).join("\n\n") }),
      }
    );

    if (!issueResponse.ok) {
      const body = await issueResponse.text().catch(() => "(unreadable)");
      throw new Error(`Failed to post GitHub comment: ${issueResponse.status} ${issueResponse.statusText}\n${body}`);
    }

    console.log("[pi-reviewer] review comment posted");
    const posted = await responseJson(issueResponse);
    return { commentIds: posted?.id ? [posted.id] : [], fallback: true };
  }

  const cwd = options.cwd ?? process.cwd();
  const filePath = path.join(cwd, "pi-review.md");
  await writeFile(filePath, formatForTerminal(result), "utf-8");
  console.log(`[pi-reviewer] review saved to ${filePath}`);
  return { commentIds: [], fallback: false };
}
