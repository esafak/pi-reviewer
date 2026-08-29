import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDiffPositions, partitionComments } from "./diff-positions.js";
const SEVERITY_RANK = { INFO: 0, WARN: 1, CRITICAL: 2 };
const SEVERITY_EMOJI = { CRITICAL: "🔴", WARN: "🟡", INFO: "🔵" };
export function extractAssistantText(message) {
    const msg = message;
    if (msg?.role !== "assistant")
        return "";
    if (typeof msg.content === "string")
        return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part === "object" && "type" in part && part.type === "text") {
                return part.text ?? "";
            }
            return "";
        })
            .join("")
            .trim();
    }
    return "";
}
export function extractLastAssistantText(messages) {
    if (!Array.isArray(messages))
        return "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const text = extractAssistantText(messages[i]);
        if (text)
            return text;
    }
    return "";
}
function normalizeSeverity(value) {
    if (value === "CRITICAL" || value === "WARN" || value === "INFO")
        return value;
    return "INFO";
}
function isReviewComment(value) {
    if (!value || typeof value !== "object")
        return false;
    const comment = value;
    return (typeof comment.file === "string" &&
        typeof comment.line === "number" &&
        Number.isFinite(comment.line) &&
        (comment.side === "LEFT" || comment.side === "RIGHT") &&
        typeof comment.body === "string");
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
function extractAllFencedBlocks(text) {
    const blocks = [];
    const re = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m;
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
function extractAllJsonObjects(text) {
    const objects = [];
    let depth = 0, start = -1, inString = false, escape = false;
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
        if (inString)
            continue;
        if (c === "{") {
            if (depth === 0)
                start = i;
            depth++;
        }
        else if (c === "}") {
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
function tryParseJSON(raw) {
    let escaped = "";
    let inString = false;
    let escape = false;
    for (const c of raw) {
        const code = c.charCodeAt(0);
        if (escape) {
            escaped += c;
            escape = false;
        }
        else if (c === "\\" && inString) {
            escaped += c;
            escape = true;
        }
        else if (c === '"') {
            escaped += c;
            inString = !inString;
        }
        else if (inString && c === "\n")
            escaped += "\\n";
        else if (inString && c === "\r")
            escaped += "\\r";
        else if (inString && c === "\t")
            escaped += "\\t";
        else if (inString && code >= 0 && code <= 0x1f)
            continue;
        else
            escaped += c;
    }
    for (const candidate of [raw, escaped]) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                return parsed;
        }
        catch {
            // not valid JSON
        }
    }
    return null;
}
export function parseAgentResponseWithStatus(text, minSeverity = "INFO") {
    // Build candidates sorted by source position. We return the **last** valid
    // candidate — this handles models that reason in prose before emitting the
    // final review (the production incident pattern).
    //
    // As an additional guard, among valid candidates we prefer ones with
    // non-empty comments over ones with empty comments. This prevents a trailing
    // "here's the structure: {summary, comments:[]}" example in prose from
    // stealing the win from the real review (comments.every() is vacuously true
    // for []).
    const candidates = [
        { content: text.trim(), index: 0 },
        ...extractAllFencedBlocks(text),
        ...extractAllJsonObjects(text),
    ];
    candidates.sort((a, b) => a.index - b.index);
    // No early return: last-wins requires a full scan.
    let resultWithComments = null;
    let resultAny = null;
    for (const { content } of candidates) {
        const parsed = tryParseJSON(content);
        if (parsed &&
            typeof parsed.summary === "string" &&
            Array.isArray(parsed.comments) &&
            parsed.comments.every(isReviewComment)) {
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
            if (parsed.comments.length > 0)
                resultWithComments = review;
        }
    }
    // Prefer the last review with comments; fall back to last review overall.
    const result = resultWithComments ?? resultAny;
    if (result)
        return { result, parsed: true };
    return { result: { summary: text, comments: [] }, parsed: false };
}
export function parseAgentResponse(text, minSeverity = "INFO") {
    return parseAgentResponseWithStatus(text, minSeverity).result;
}
function formatForGitHub(result) {
    const lines = ["## Pi Reviewer", "", result.summary];
    if (result.comments.length > 0) {
        lines.push("", "### Inline Comments");
        for (const comment of result.comments) {
            lines.push("", `${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side}`, comment.body);
        }
    }
    return lines.join("\n");
}
/**
 * Build the review body: the summary plus a clearly-marked section listing
 * comments that could not be attached to a diff line. GitHub shows the body as
 * the review's main text, so moved comments stay visible to the author.
 */
function buildReviewBody(summary, moved) {
    if (moved.length === 0)
        return summary;
    const lines = [summary, "", "### Comments Not Attached to the Diff", ""];
    lines.push("These comments could not be attached to a specific diff line, so the reported location is approximate — the line is not part of the diff:");
    for (const comment of moved) {
        lines.push("", `> ${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side} — location could not be verified`, comment.body);
    }
    return lines.join("\n");
}
export function formatForTerminal(result) {
    const lines = ["== Review Summary ==", result.summary];
    if (result.comments.length > 0) {
        lines.push("", "== Inline Comments ==");
        for (const comment of result.comments) {
            lines.push(`${SEVERITY_EMOJI[comment.severity]} ${comment.file}:${comment.line} (${comment.side})`, comment.body, "");
        }
        while (lines[lines.length - 1] === "") {
            lines.pop();
        }
    }
    return lines.join("\n");
}
export async function sendOutput(options) {
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
            throw new Error("Agent output was not a valid structured review; refusing to post raw model output");
        }
        const headers = {
            Authorization: `Bearer ${options.githubToken}`,
            "Content-Type": "application/json",
        };
        // Split comments into inline (positionable on the diff) and moved (kept in
        // the review body). Without a diff we can't validate positions, so every
        // comment is treated as inline (local/SSH callers, which never pass a diff).
        let inline = result.comments;
        let moved = [];
        if (options.diff) {
            const positions = parseDiffPositions(options.diff);
            ({ inline, moved } = partitionComments(result.comments, positions));
            if (moved.length > 0) {
                console.log(`[pi-reviewer] ${moved.length} comment(s) not positionable on the diff — moved to review body`);
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
            console.log(`[pi-reviewer] posting review with ${inlineComments.length} inline comment(s)` +
                (moved.length > 0 ? ` and ${moved.length} comment(s) in body` : ""));
            let reviewResponse = await fetch(`https://api.github.com/repos/${options.repo}/pulls/${options.prNumber}/reviews`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    commit_id: options.commitId,
                    body,
                    event: "COMMENT",
                    comments: inlineComments,
                }),
            });
            if (reviewResponse.ok) {
                console.log("[pi-reviewer] review posted with inline comments");
                return;
            }
            let errBody = await reviewResponse.text().catch(() => "");
            console.warn(`[pi-reviewer] inline comments rejected (${reviewResponse.status}) — ${errBody}`);
            // A 422 means GitHub couldn't resolve at least one position we thought was
            // valid (e.g. a force-push changed the diff between resolution and post).
            // Retry once as a body-only review, moving every comment into the body.
            if (reviewResponse.status === 422) {
                const allMovedBody = buildReviewBody(result.summary, result.comments);
                reviewResponse = await fetch(`https://api.github.com/repos/${options.repo}/pulls/${options.prNumber}/reviews`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        commit_id: options.commitId,
                        body: allMovedBody,
                        event: "COMMENT",
                        comments: [],
                    }),
                });
                if (reviewResponse.ok) {
                    console.log("[pi-reviewer] review posted as body-only (inline positions rejected)");
                    return;
                }
                errBody = await reviewResponse.text().catch(() => "");
                console.warn(`[pi-reviewer] body-only review rejected (${reviewResponse.status}) — ${errBody}`);
            }
        }
        // Last-resort fallback: Issues Comments API (hard failures, no commitId, or
        // an all-unpositionable summary-only review).
        const issueResponse = await fetch(`https://api.github.com/repos/${options.repo}/issues/${options.prNumber}/comments`, {
            method: "POST",
            headers,
            body: JSON.stringify({ body: formatForGitHub(result) }),
        });
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
