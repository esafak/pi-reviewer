import { writeFile } from "node:fs/promises";
import path from "node:path";

import { parseDiffPositions, partitionComments } from "./diff-positions.js";

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
  /** Raw diff included by the agent in SSH+UI mode */
  diff?: string;
  tokenUsage?: TokenUsage;
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
  for (const c of raw) {
    const code = c.charCodeAt(0);
    if (c === "\n") escaped += "\\n";
    else if (c === "\r") escaped += "\\r";
    else if (c === "\t") escaped += "\\t";
    else if (code >= 0 && code <= 0x1f) continue;
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
    if (
      parsed &&
      typeof parsed.summary === "string" &&
      Array.isArray(parsed.comments) &&
      parsed.comments.every(isReviewComment)
    ) {
      const minRank = SEVERITY_RANK[minSeverity];
      const comments = parsed.comments
        .map((c) => ({ ...c, severity: normalizeSeverity(c.severity) }))
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank)
        .map((c) => {
          const emoji = SEVERITY_EMOJI[c.severity];
          const prefix = ["🔴 ", "🟡 ", "🔵 "].find((value) => c.body.startsWith(value));
          const body = prefix ? c.body.slice(prefix.length) : c.body;
          return { ...c, body: `${emoji} ${body}` };
        });
      const diff = typeof parsed.diff === "string" ? parsed.diff : undefined;
      const review = { summary: parsed.summary, comments, ...(diff !== undefined ? { diff } : {}) };
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

export async function sendOutput(options: OutputOptions): Promise<void> {
  const parsedResponse = parseAgentResponseWithStatus(options.content, options.minSeverity);
  const result = parsedResponse.result;

  if (options.target === "terminal") {
    console.log(formatForTerminal(result));
    return;
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
    let inline = result.comments;
    let moved: ReviewComment[] = [];
    if (options.diff) {
      const positions = parseDiffPositions(options.diff);
      ({ inline, moved } = partitionComments(result.comments, positions));
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
      body: comment.body,
    }));

    const body = buildReviewBody(result.summary, moved);

    // Try PR Reviews API first (supports inline comments and a body).
    if ((inlineComments.length > 0 || moved.length > 0) && options.commitId) {
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
        return;
      }
      let errBody = await reviewResponse.text().catch(() => "");
      console.warn(
        `[pi-reviewer] inline comments rejected (${reviewResponse.status}) — ${errBody}`
      );

      // A 422 means GitHub couldn't resolve at least one position we thought was
      // valid (e.g. a force-push changed the diff between resolution and post).
      // Retry once as a body-only review, moving every comment into the body.
      if (reviewResponse.status === 422) {
        const allMovedBody = buildReviewBody(result.summary, result.comments);
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
          return;
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
        body: JSON.stringify({ body: formatForGitHub(result) }),
      }
    );

    if (!issueResponse.ok) {
      const body = await issueResponse.text().catch(() => "(unreadable)");
      throw new Error(`Failed to post GitHub comment: ${issueResponse.status} ${issueResponse.statusText}\n${body}`);
    }

    console.log("[pi-reviewer] review comment posted");
    return;
  }

  const cwd = options.cwd ?? process.cwd();
  const filePath = path.join(cwd, "pi-review.md");
  await writeFile(filePath, formatForTerminal(result), "utf-8");
  console.log(`[pi-reviewer] review saved to ${filePath}`);
}
