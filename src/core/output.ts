import { writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDiffPositions, partitionComments } from "./diff-positions.js";
import { GitHubClient } from "../ci/github.js";

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
}

export interface OutputOptions {
  target: OutputTarget;
  content: string;
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
}
export interface OutputMetadata { reviewId?: number; commentIds: number[]; fallback: boolean }
async function responseJson(response: Response): Promise<{ id?: number; comments?: Array<{ id?: number }> } | undefined> {
  if (typeof response.json !== "function") return undefined;
  try { return await response.json() as { id?: number; comments?: Array<{ id?: number }> }; } catch { return undefined; }
}

export interface ExistingFinding { commentId: number; threadId?: string; body?: string; }

/** Applies model-approved transitions independently so a failed mutation can be retried safely. */
export async function reconcileFindingUpdates(options: { token: string; repo: string; prNumber: number; targetSha: string; updates: FindingUpdate[]; findings: ExistingFinding[] }): Promise<void> {
  const client = new GitHubClient(options.token);
  const known = new Map(options.findings.map(f => [f.commentId, f]));
  const hasMutations = options.updates.some(update => update.status !== "STILL_OPEN");
  const identity = hasMutations ? await client.getUser() : undefined;
  if (identity) {
    const current = await client.getPullRequest(options.repo, options.prNumber);
    if (current.head.sha !== options.targetSha) {
      console.warn("[pi-reviewer] PR head changed before reconciliation; leaving lifecycle state unchanged");
      return;
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
  for (const update of options.updates) {
    const finding = known.get(update.comment_id);
    if (!finding) continue;
    if (update.status === "STILL_OPEN") continue;
    const body = `<!-- pi-reviewer:status:v1 ${JSON.stringify({ findingId: update.comment_id, targetSha: options.targetSha, status: update.status })} -->\n${update.status === "RESOLVED" ? `Resolved in ${options.targetSha.slice(0, 7)}` : "Partially addressed"}: ${update.explanation}`;
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
      catch (error) { console.warn(`[pi-reviewer] could not resolve finding ${finding.commentId}; will retry resolution: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
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

  for (const { content } of candidates) {
    const parsed = tryParseJSON(content);
    const rawUpdates = parsed && Array.isArray(parsed.finding_updates) ? parsed.finding_updates : [];
    const updatesValid = rawUpdates.every((u) => {
      if (!u || typeof u !== "object") return false;
      const value = u as Record<string, unknown>;
      return Number.isInteger(value.comment_id) && (!allowedFindingIds || allowedFindingIds.has(value.comment_id as number)) && ["RESOLVED", "PARTIALLY_RESOLVED", "STILL_OPEN"].includes(value.status as string) && typeof value.explanation === "string" && value.explanation.length <= 2000;
    });
    if (
      parsed &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.comments) &&
      parsed.comments.every(isReviewComment) && updatesValid
    ) {
      const minRank = SEVERITY_RANK[minSeverity];
      const comments = parsed.comments
        .map((c) => ({ ...c, severity: normalizeSeverity(c.severity) }))
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank)
        .filter((c) => !existingFindingKeys?.has(normalizeFinding(c)))
        .map((c) => {
          const emoji = SEVERITY_EMOJI[c.severity];
          const prefix = ["🔴 ", "🟡 ", "🔵 "].find((value) => c.body.startsWith(value));
          const body = prefix ? c.body.slice(prefix.length) : c.body;
          return { ...c, body: `${emoji} ${body}` };
        });
      const diff = typeof parsed.diff === "string" ? parsed.diff : undefined;
      const updates = Array.isArray(parsed.finding_updates)
        ? parsed.finding_updates.filter((u): u is FindingUpdate => {
            if (!u || typeof u !== "object") return false;
            const value = u as Record<string, unknown>;
            return Number.isInteger(value.comment_id) &&
              (!allowedFindingIds || allowedFindingIds.has(value.comment_id as number)) &&
              ["RESOLVED", "PARTIALLY_RESOLVED", "STILL_OPEN"].includes(value.status as string) &&
              typeof value.explanation === "string" && value.explanation.length <= 2000;
          })
        : [];
      const review = { summary: parsed.summary, comments, ...(updates.length ? { finding_updates: updates } : {}), ...(diff !== undefined ? { diff } : {}) };
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

  return { result: { summary: text, comments: [] }, parsed: false };
}

/** Stable identity used to avoid reposting the same finding in a batch. */
export function normalizeFinding(comment: Pick<ReviewComment, "file" | "line" | "side" | "body">): string {
  return [comment.file, comment.line, comment.side, comment.body.replace(/^[🔴🟡🔵]\s*/u, "").trim().replace(/\n\s*\n+/g, "\n")].join("\0");
}

export function parseAgentResponse(text: string, minSeverity: Severity = "INFO"): ReviewResult {
  return parseAgentResponseWithStatus(text, minSeverity).result;
}

function formatForGitHub(result: ReviewResult): string {
  const lines = ["## Pi Reviewer", "", result.summary];

  if (result.comments.length > 0) {
    lines.push("", "### Inline Comments");
    for (const comment of result.comments) {
      lines.push(
        "",
        `${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side}`,
        comment.body
      );
    }
  }

  return lines.join("\n");
}

/**
 * Build the review body: the summary plus a clearly-marked section listing
 * comments that could not be attached to a diff line. GitHub shows the body as
 * the review's main text, so moved comments stay visible to the author.
 */
function buildReviewBody(summary: string, moved: ReviewComment[]): string {
  if (moved.length === 0) return summary;
  const lines = [summary, "", "### Comments Not Attached to the Diff", ""];
  lines.push("These comments could not be attached to a specific diff line, so the reported location is approximate — the line is not part of the diff:");
  for (const comment of moved) {
    lines.push(
      "",
      `> ${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side} — location could not be verified`,
      comment.body
    );
  }
  return lines.join("\n");
}

export function formatForTerminal(result: ReviewResult): string {
  const lines = ["== Review Summary ==", result.summary];

  if (result.comments.length > 0) {
    lines.push("", "== Inline Comments ==");
    for (const comment of result.comments) {
      lines.push(
        `${SEVERITY_EMOJI[comment.severity]} ${comment.file}:${comment.line} (${comment.side})`,
        comment.body,
        ""
      );
    }

    while (lines[lines.length - 1] === "") {
      lines.pop();
    }
  }

  return lines.join("\n");
}

export async function sendOutput(options: OutputOptions): Promise<OutputMetadata> {
  const parsedResponse = parseAgentResponseWithStatus(options.content, options.minSeverity, options.allowedFindingIds, options.existingFindingKeys);
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
      body: `<!-- pi-reviewer:finding:v1 -->\n${comment.body}`,
    }));

    const body = [options.batchMarker, buildReviewBody(result.summary, moved)].filter(Boolean).join("\n\n");

    if (options.batchMarker && options.githubToken && options.repo && options.prNumber && options.commitId) {
      const current = await new GitHubClient(options.githubToken).getPullRequest(options.repo, options.prNumber);
      if (current.head.sha !== options.commitId) throw new Error("PR head changed while the review was running; refusing to post a stale batch");
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
            if (finalized !== options.batchMarker) await new GitHubClient(options.githubToken).updateReview(options.repo, options.prNumber, posted.id, [finalized, buildReviewBody(result.summary, moved)].join("\n\n")).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
          }
        }
        if (result.finding_updates?.length && options.existingFindings && options.githubToken && options.repo && options.prNumber && options.commitId) {
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
         const allMovedBody = [options.batchMarker, buildReviewBody(result.summary, comments)].filter(Boolean).join("\n\n");
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
          if (result.finding_updates?.length && options.existingFindings && options.githubToken && options.repo && options.prNumber && options.commitId) await reconcileFindingUpdates({ token: options.githubToken, repo: options.repo, prNumber: options.prNumber, targetSha: options.commitId, updates: result.finding_updates, findings: options.existingFindings });
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
        body: JSON.stringify({ body: [options.batchMarker, formatForGitHub(result)].filter(Boolean).join("\n\n") }),
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
