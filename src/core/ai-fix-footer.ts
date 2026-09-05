export const AI_FIX_FOOTER = "For each issue above, determine whether it is valid. If so, fix it iteratively with one reviewer agent until convergence.";

export interface AiFixContext {
  file: string;
  line: number;
  side?: string;
  severity?: string;
  repository?: string;
  commitId?: string;
  baseCommitId?: string;
}

export interface AiFixFinding {
  context: AiFixContext;
  body: string;
}

const AI_FIX_DETAILS = /<details>\s*<summary>Prompt to fix(?: all issues)? with AI<\/summary>[\s\S]*?<\/details>\s*$/;
const AI_FIX_CONTEXT = /^\*\*Context:\*\*[^\n]*\n\s*\n?/;
/**
 * JSON-Schema-compatible requirement for prose beyond whitespace and emoji.
 * JSON Schema regexes do not enable Unicode property escapes, so this uses
 * UTF-16 ranges for the emoji blocks and common BMP emoji characters.
 */
export const MEANINGFUL_PROSE_PATTERN = "^(?![\\s😀🧪\\u200D\\u20E3\\uFE0F\\uD83C-\\uD83E\\uDC00-\\uDFFF\\u00A9\\u00AE\\u203C\\u2049\\u2122\\u2139\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u27BF\\u2B00-\\u2BFF\\u3030\\u303D\\u3297\\u3299]+$)[\\s\\S]+$";
const MEANINGFUL_PROSE = new RegExp(MEANINGFUL_PROSE_PATTERN);

const SEVERITY_EMOJI: Record<string, string> = { CRITICAL: "🔴", WARN: "🟡", INFO: "🔵" };

/** Repairs line-break escapes emitted by models that double-encode JSON text. */
export function normalizeMarkdownText(text: string): string {
  if (/[\r\n]/.test(text)) return text;
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

function withoutSeverityEmoji(body: string): string {
  return body.trim().replace(/^[🔴🟡🔵]\s*/u, "").trim();
}

/** Checks the same canonical body rule used by normalizeAiFixBody. */
export function hasAiFixProse(body: string): boolean {
  return MEANINGFUL_PROSE.test(withoutSeverityEmoji(normalizeMarkdownText(body)));
}

/** Converts model prose into the canonical body used by all renderers. */
export function normalizeAiFixBody(body: string): string {
  const normalized = withoutSeverityEmoji(normalizeMarkdownText(body));
  if (!normalized) throw new Error("Finding body must contain non-empty prose");
  return normalized;
}

/** Returns the human-facing finding summary; it contains no Fixit markup. */
export function renderFindingSummary(context: AiFixContext, body: string, options: { includeLocation?: boolean } = {}): string {
  const emoji = SEVERITY_EMOJI[context.severity ?? ""] ?? "";
  const location = `${context.file}:${context.line}${context.side ? ` · ${context.side}` : ""}`;
  const revision = context.repository && context.commitId
    ? context.side === "LEFT"
      ? context.baseCommitId !== context.commitId ? context.baseCommitId : undefined
      : context.commitId
    : undefined;
  const href = context.repository && revision && context.line > 0
    ? `https://github.com/${context.repository}/blob/${revision}/${context.file.split("/").map(encodeURIComponent).join("/")}#L${context.line}`
    : undefined;
  const linkedLocation = href ? `[\`${location}\`](${href})` : `\`${location}\``;
  const normalizedBody = normalizeAiFixBody(body);
  if (options.includeLocation === false) return `${emoji ? `${emoji} ` : ""}${normalizedBody}`;
  return `${emoji ? `${emoji} ` : ""}**${linkedLocation}**\n\n${normalizedBody}`;
}

function stripPromptEnvelope(text: string): string {
  const hasEnvelope = /^<details>\s*<summary>Prompt to fix(?: all issues)? with AI<\/summary>/.test(text);
  let content = hasEnvelope
    ? text
      .replace(/^<details>\s*<summary>Prompt to fix(?: all issues)? with AI<\/summary>\s*/, "")
      .replace(/<\/details>\s*$/, "")
      .replace(AI_FIX_CONTEXT, "")
      .trim()
    : text.trim();

  if (hasEnvelope) {
    const fence = content.match(/^(`{3,})\n([\s\S]*?)\n\1\s*$/);
    if (fence) content = fence[2].trim();
    content = content.replace(/^(?:CRITICAL|WARN|INFO|REPLY):[^\n]*\n\s*/, "");
  }
  return content.replace(AI_FIX_FOOTER, "").trim();
}

/** Removes either the current details prompt or the legacy plain-text footer. */
export function removeAiFixFooter(body: string): string {
  const details = body.match(AI_FIX_DETAILS);
  if (details) {
    const prefix = body.slice(0, body.length - details[0].length);
    // New finding comments repeat the visible body before the dropdown. Keep
    // that body and discard the duplicate prompt; legacy comments have only
    // hidden metadata before the dropdown, so recover their body from it.
    const visiblePrefix = prefix.replace(/^(?:(?:<!--\s*pi-reviewer\s*:[\s\S]*?-->\n?)*)/, "").trim();
    if (visiblePrefix) return prefix.trimEnd();
    return `${prefix}${stripPromptEnvelope(details[0])}`.trimEnd();
  }
  return body.split(AI_FIX_FOOTER).join("").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Neutralizes details/summary tags in model-controlled text so they render as
 * literal text and cannot open or close the wrapper early. The zero-width
 * space keeps the visible text unchanged.
 */
export function neutralizeDetailsTags(text: string): string {
  return text.replace(/<(\/?)\s*(details|summary)(?:\s[^>]*)?[/]?>/gi, (tag) => tag.replace(/^</, "<\u200b"));
}

function cleanPromptBody(body: string): string {
  return neutralizeDetailsTags(normalizeAiFixBody(body));
}

function renderPromptDetails(prompt: string, summary = "Prompt to fix with AI"): string {
  const maxBackticks = Math.max(0, ...(prompt.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(Math.max(3, maxBackticks + 1));
  return [
    `<details>`,
    `<summary>${summary}</summary>`,
    ``,
    fence,
    prompt,
    fence,
    ``,
    `</details>`,
  ].join("\n");
}

function promptEntry(context: AiFixContext, body: string): string {
  const level = context.severity ? `${context.severity}: ` : "";
  return `${level}${context.file}:${context.line}\n\n${cleanPromptBody(body)}`;
}

/** Returns the copyable Fixit payload without its GitHub disclosure wrapper. */
export function renderAiFixPromptText(context: AiFixContext, body: string): string {
  return `${promptEntry(context, body)}\n\n${AI_FIX_FOOTER}`;
}

/** Renders a copyable, self-contained prompt for one actionable finding. */
export function renderAiFixPrompt(context: AiFixContext, body: string): string {
  return renderPromptDetails(renderAiFixPromptText(context, body));
}

/** Renders one copyable prompt containing all actionable findings. */
export function renderAiFixPromptList(issues: AiFixFinding[]): string {
  if (issues.length === 0) return "";
  const entries = issues.map(issue => promptEntry(issue.context, issue.body)).join("\n\n");
  return renderPromptDetails(`${entries}\n\n${AI_FIX_FOOTER}`, "Prompt to fix all issues with AI");
}

/** Appends the shared fix instruction without duplicating an existing footer. */
export function appendAiFixFooter(body: string): string {
  const normalized = body.trimEnd();
  return normalized.endsWith(AI_FIX_FOOTER) ? normalized : `${normalized}\n\n${AI_FIX_FOOTER}`;
}
