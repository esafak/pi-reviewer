import type { ContextFile, ContextResult } from "./context.js";

export type MinSeverity = "CRITICAL" | "WARN" | "INFO";
export interface ActiveFindingContext { commentId: number; threadId?: string; reviewId?: number; bodyFinding?: boolean; reviewBody?: string; file?: string; line?: number; side?: string; body: string; sourceBatch?: string; latestStatus?: string }

const SEVERITY_RULE: Record<MinSeverity, string | null> = {
  INFO: null,
  WARN: "- Only report CRITICAL and WARN issues — skip INFO",
  CRITICAL: "- Only report CRITICAL issues — skip WARN and INFO",
};

function mergeContent(files: ContextFile[]): string {
  return files.map(f => f.content).join("\n\n");
}

// ── Shared base ───────────────────────────────────────────────────────────────

function buildSharedBase(minSeverity: MinSeverity): string[] {
  const severityRule = SEVERITY_RULE[minSeverity];
  return [
    "You are a code reviewer. Review the following PR diff carefully.",
    "",
    "<severity_tiers>",
    "- 🔴 CRITICAL: bugs causing runtime failures, security vulnerabilities, data loss risks",
    "- 🟡 WARN: type errors, missing error handling, logic issues, test gaps",
    "- 🔵 INFO: style, naming, performance hints, suggestions",
    "</severity_tiers>",
    "",
    "<rules>",
    "- Only flag what is actually wrong in the diff — no hypotheticals",
    "- If nothing is wrong, say so clearly",
    ...(severityRule ? [severityRule] : []),
    "</rules>",
  ];
}

// ── System prompts ────────────────────────────────────────────────────────────

/**
 * JSON system prompt — used by local mode and SSH+UI.
 * Agent must return a structured JSON ReviewResult.
 * Conventions and review rules are injected from context when available.
 */
export function buildJSONSystemPrompt(
  context: ContextResult | string,
  minSeverity: MinSeverity = "INFO",
  contextFiles?: ContextFile[],
  activeFindings: ActiveFindingContext[] = [],
  priorSummary?: string,
): string {
  const base = [
    ...buildSharedBase(minSeverity),
    "- Do not repeat what the project conventions already enforce",
    "",
    "If a submit_review tool is available, prefer calling it to submit your review as structured data instead of emitting JSON text.",
    "Return only a JSON object matching this schema exactly (no markdown fences, no extra text, no extra fields — do not include the diff or any other field):",
    "<output_format>",
    "{",
    '  "summary": "Overall review in **Markdown**. Use bullet points, `code spans`, and **bold** for clarity.",',
    '  "comments": [',
    '    { "file": "src/auth.ts", "line": 42, "side": "RIGHT", "severity": "CRITICAL", "body": "Inline comment in Markdown." }',
    "  ]",
    '  ,"finding_updates": [{ "comment_id": 123, "status": "RESOLVED", "explanation": "The null check now handles this path." }]',
    "}",
    "</output_format>",
    "",
    "Field rules:",
    "- summary: overall review written in Markdown",
    "- comments: inline comments attached to specific diff lines (may be empty [])",
    "- finding_updates: optional array for existing findings only; comment_id must match an active finding supplied below",
    "- PARTIALLY_RESOLVED explanations must state both what changed and what remains unresolved",
    "- file: relative path from repo root",
    "- line: line number of a changed or context line within a diff hunk (only lines shown in the diff can receive comments — never pick an arbitrary line outside the diff)",
    '- side: "RIGHT" for added/context lines, "LEFT" for removed lines',
    '- severity: "CRITICAL" | "WARN" | "INFO"',
    "- body: inline comment text, may use Markdown",
    "- finding_updates: optional updates to existing findings supplied below. Use RESOLVED only when fully addressed, PARTIALLY_RESOLVED when some concern remains, and STILL_OPEN when unchanged.",
  ].join("\n");

  const conventionsStr = typeof context === "string" ? context : mergeContent(context.conventions);
  const reviewRulesStr = typeof context === "string" ? "" : mergeContent(context.reviewRules);

  const sections: string[] = [base];
  if (conventionsStr.trim()) sections.push(`<conventions>\n${conventionsStr}\n</conventions>`);
  if (reviewRulesStr.trim()) sections.push(`<review_rules>\n${reviewRulesStr}\n</review_rules>`);
  if (contextFiles && contextFiles.length > 0) sections.push(contextFiles.map(f => f.content).join("\n\n"));
  if (activeFindings.length > 0) {
    const findings = activeFindings.slice(0, 50).sort((a, b) => a.commentId - b.commentId).map(f => JSON.stringify({ comment_id: f.commentId, thread_id: f.threadId, file: f.file, line: f.line, side: f.side, body: f.body.slice(0, 2000), source_batch: f.sourceBatch, latest_status: f.latestStatus })).join("\n");
    sections.push(`<active_findings>\n${findings}\n</active_findings>\nDo not repost these findings in comments; report their changes in finding_updates using the supplied comment_id.`);
  }
  if (priorSummary?.trim()) sections.push(`<previous_review_summary>\n${priorSummary.slice(0, 8000)}\n</previous_review_summary>`);

  return sections.join("\n\n");
}

/**
 * Markdown system prompt — used by SSH-only mode.
 * Agent writes a human-readable markdown review and saves it to pi-review.md.
 */
export function buildMarkdownSystemPrompt(minSeverity: MinSeverity = "INFO", context?: ContextResult | string, contextFiles?: ContextFile[]): string {
  const base = [
    ...buildSharedBase(minSeverity),
    "",
    "Write your review as Markdown with:",
    "- A summary section with bullet points for each issue",
    "- An inline comments section listing file, line, and comment for each specific finding",
    "",
    "After writing your review, save it to pi-review.md in the project root using the Write tool.",
  ].join("\n");

  const conventionsStr = context ? (typeof context === "string" ? context : mergeContent(context.conventions)) : "";
  const reviewRulesStr = context ? (typeof context === "string" ? "" : mergeContent(context.reviewRules)) : "";
  const sections: string[] = [base];
  if (conventionsStr.trim()) sections.push(`<conventions>\n${conventionsStr}\n</conventions>`);
  if (reviewRulesStr.trim()) sections.push(`<review_rules>\n${reviewRulesStr}\n</review_rules>`);
  if (contextFiles && contextFiles.length > 0) sections.push(contextFiles.map(f => f.content).join("\n\n"));
  return sections.join("\n\n");
}

// ── User prompts ──────────────────────────────────────────────────────────────

/** Local mode — diff only, conventions already in system prompt. */
export function buildUserPrompt(diff: string, skippedFiles?: string[]): string {
  const parts = [`Review this diff:\n<diff>\n${diff}\n</diff>`];
  if (skippedFiles && skippedFiles.length > 0) {
    parts.push(
      `<skipped_files>\n${skippedFiles.map((f) => `- ${f}`).join("\n")}\n</skipped_files>\nThe above files were not included because the diff exceeded the size limit. Mention them explicitly in your summary as not reviewed.`
    );
  }
  return parts.join("\n\n");
}

/**
 * SSH mode (both SSH-only and SSH+UI).
 * Agent runs the given diff command, reads project conventions, then reviews.
 */
export function buildSSHUserPrompt(diffCommand: string): string {
  const ts = new Date().toISOString();
  return [
    `<request id="${ts}">`,
    "  <step index=\"1\">",
    "    Run this command to get the current diff. Always re-execute — never reuse output from a previous review.",
    `    <command>${diffCommand}</command>`,
    "  </step>",
    "  <step index=\"2\">",
    "    Review the diff according to the system prompt instructions.",
    "  </step>",
    "</request>",
  ].join("\n");
}
