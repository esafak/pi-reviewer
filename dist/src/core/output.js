import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDiffPositions, partitionComments } from "./diff-positions.js";
import { GitHubClient } from "../ci/github.js";
import { bodyFindingId, decodeBodyFindingMarkers, encodeBodyFindingMarker, updateBodyFindingMarker } from "../ci/batch.js";
const SEVERITY_RANK = { INFO: 0, WARN: 1, CRITICAL: 2 };
const SEVERITY_EMOJI = { CRITICAL: "🔴", WARN: "🟡", INFO: "🔵" };
async function responseJson(response) {
    if (typeof response.json !== "function")
        return undefined;
    try {
        return await response.json();
    }
    catch {
        return undefined;
    }
}
const FINDING_STATUSES = ["RESOLVED", "PARTIALLY_RESOLVED", "STILL_OPEN"];
function findingUpdateRejection(update, allowedFindingIds) {
    const value = update && typeof update === "object" ? update : {};
    const commentId = value.comment_id;
    const status = value.status;
    if (!Number.isInteger(commentId))
        return { reason: "comment_id is not an integer", commentId, status };
    if (allowedFindingIds && !allowedFindingIds.has(commentId))
        return { reason: "unknown active-finding ID", commentId, status };
    if (!FINDING_STATUSES.includes(status))
        return { reason: "invalid status", commentId, status };
    if (typeof value.explanation !== "string")
        return { reason: "explanation is not a string", commentId, status };
    if (value.explanation.length > 2000)
        return { reason: "explanation exceeds 2000 characters", commentId, status };
    return { update: { comment_id: commentId, status: status, explanation: value.explanation }, reason: "", commentId, status };
}
function formatDiagnosticValue(value, kind) {
    if (kind === "comment_id" && typeof value === "number" && Number.isFinite(value))
        return String(value);
    if (kind === "status" && typeof value === "string" && FINDING_STATUSES.includes(value))
        return value;
    return "invalid";
}
function structuredResultRejection(value) {
    if (!value || typeof value !== "object")
        return "invalid summary";
    const result = value;
    if (typeof result.summary !== "string")
        return "invalid summary";
    if (!Array.isArray(result.comments) || !result.comments.every(isReviewComment))
        return "invalid comments";
    if (result.finding_updates !== undefined && !Array.isArray(result.finding_updates))
        return "invalid finding_updates";
    return undefined;
}
/** Normalize tool output while isolating contextual finding validation from the review itself. */
function normalizeReviewResult(result, options, warnInvalidUpdates) {
    const minRank = SEVERITY_RANK[options.minSeverity ?? "INFO"];
    const comments = result.comments
        .map((comment) => ({ ...comment, severity: normalizeSeverity(comment.severity) }))
        .filter((comment) => SEVERITY_RANK[comment.severity] >= minRank)
        .filter((comment) => !options.existingFindingKeys?.has(normalizeFinding(comment)))
        .map((comment) => {
        const emoji = SEVERITY_EMOJI[comment.severity];
        const prefix = ["🔴 ", "🟡 ", "🔵 "].find((value) => comment.body.startsWith(value));
        const body = prefix ? comment.body.slice(prefix.length) : comment.body;
        return { ...comment, body: `${emoji} ${body}` };
    });
    const updates = [];
    for (const candidate of result.finding_updates ?? []) {
        const checked = findingUpdateRejection(candidate, options.allowedFindingIds);
        if (checked.update)
            updates.push(checked.update);
        else if (warnInvalidUpdates) {
            console.warn(`[pi-reviewer] dropped finding update comment_id=${formatDiagnosticValue(checked.commentId, "comment_id")}${checked.status === undefined ? "" : ` status=${formatDiagnosticValue(checked.status, "status")}`} reason=${checked.reason}`);
        }
    }
    return { summary: result.summary, comments, ...(updates.length ? { finding_updates: updates } : {}), ...(result.diff !== undefined ? { diff: result.diff } : {}) };
}
/** Applies model-approved transitions independently so a failed mutation can be retried safely. */
export async function reconcileFindingUpdates(options) {
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
        }
        catch {
            return false;
        }
    };
    const bodyUpdates = new Map();
    for (const update of options.updates) {
        const finding = known.get(update.comment_id);
        if (!finding)
            continue;
        if (update.status === "STILL_OPEN")
            continue;
        if (finding.bodyFinding && finding.reviewId && finding.reviewBody !== undefined) {
            const group = bodyUpdates.get(finding.reviewId) ?? { finding, updates: [] };
            group.updates.push(update);
            bodyUpdates.set(finding.reviewId, group);
            continue;
        }
    }
    for (const [reviewId, group] of bodyUpdates) {
        let updatedBody;
        try {
            const freshReview = await client.getReview(options.repo, options.prNumber, reviewId);
            if (typeof freshReview.body !== "string") {
                console.warn(`[pi-reviewer] could not update body review ${reviewId}: fetched review has no body`);
                continue;
            }
            updatedBody = freshReview.body;
        }
        catch (error) {
            console.warn(`[pi-reviewer] could not fetch body review ${reviewId}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        const changedFindingIds = new Set();
        for (const update of group.updates) {
            const currentMarker = decodeBodyFindingMarkers(updatedBody).find(marker => marker.findingId === update.comment_id);
            if (currentMarker?.targetSha === options.targetSha && currentMarker.status === update.status && currentMarker.explanation === update.explanation) {
                if (update.status === "RESOLVED")
                    outstanding.delete(update.comment_id);
                continue;
            }
            const nextBody = updateBodyFindingMarker(updatedBody, update.comment_id, update.status, options.targetSha, update.explanation);
            if (nextBody !== updatedBody) {
                updatedBody = nextBody;
                changedFindingIds.add(update.comment_id);
            }
        }
        if (updatedBody === group.finding.reviewBody || !await isTargetHeadCurrent())
            continue;
        try {
            await client.updateReview(options.repo, options.prNumber, reviewId, updatedBody);
            for (const update of group.updates) {
                if (update.status === "RESOLVED" && changedFindingIds.has(update.comment_id))
                    outstanding.delete(update.comment_id);
            }
        }
        catch (error) {
            console.warn(`[pi-reviewer] could not update body review ${reviewId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const update of options.updates) {
        const finding = known.get(update.comment_id);
        if (!finding || update.status === "STILL_OPEN")
            continue;
        if (finding.bodyFinding && finding.reviewId && finding.reviewBody !== undefined)
            continue;
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
        }
        catch (error) {
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
            catch (error) {
                console.warn(`[pi-reviewer] could not resolve finding ${finding.commentId}; will retry resolution: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
        }
        if (update.status === "RESOLVED")
            outstanding.delete(finding.commentId);
    }
    return outstanding;
}
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
export function parseAgentResponseWithStatus(text, minSeverity = "INFO", allowedFindingIds, existingFindingKeys) {
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
    let rejectionReason = "malformed JSON";
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
        if (parsed &&
            typeof parsed.summary === "string" &&
            Array.isArray(parsed.comments) &&
            parsed.comments.every(isReviewComment) && updatesValid) {
            const diff = typeof parsed.diff === "string" ? parsed.diff : undefined;
            const review = normalizeReviewResult({ summary: parsed.summary, comments: parsed.comments, finding_updates: rawUpdates, ...(diff !== undefined ? { diff } : {}) }, { minSeverity, allowedFindingIds, existingFindingKeys }, false);
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
    return { result: { summary: text, comments: [] }, parsed: false, rejectionReason };
}
/** Stable identity used to avoid reposting the same finding in a batch. */
export function normalizeFinding(comment) {
    const storedBody = decodeBodyFindingMarkers(comment.body)[0]?.body;
    const body = (storedBody ?? comment.body).replace(/<!--\s*pi-reviewer\s*:\s*[\s\S]*?-->/g, "").trim().replace(/^[🔴🟡🔵]\s*/u, "").trim().replace(/\n\s*\n+/g, "\n");
    return [comment.file, comment.line, comment.side, body].join("\0");
}
/** Keep model-controlled text from becoming metadata when it is shown in a review body. */
function sanitizeVisibleReviewText(text) {
    return text.replace(/<!--\s*pi-reviewer\s*:/gi, "<!-- pi-reviewer :");
}
export function parseAgentResponse(text, minSeverity = "INFO") {
    return parseAgentResponseWithStatus(text, minSeverity).result;
}
function formatForGitHub(result) {
    const lines = ["## Pi Reviewer", "", sanitizeVisibleReviewText(result.summary)];
    if (result.comments.length > 0) {
        lines.push("", "### Inline Comments");
        for (const comment of result.comments) {
            lines.push("", `${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side}`, sanitizeVisibleReviewText(comment.body));
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
        return sanitizeVisibleReviewText(summary);
    const lines = [sanitizeVisibleReviewText(summary), "", "### Comments Not Attached to the Diff", ""];
    lines.push("These comments could not be attached to a specific diff line, so the reported location is approximate — the line is not part of the diff:");
    for (const comment of moved) {
        const visibleBody = sanitizeVisibleReviewText(comment.body);
        const findingId = bodyFindingId(normalizeFinding(comment));
        lines.push("", encodeBodyFindingMarker({ findingId, file: comment.file, line: comment.line, side: comment.side, severity: comment.severity, body: visibleBody }), `> ${SEVERITY_EMOJI[comment.severity]} **\`${comment.file}:${comment.line}\`** · ${comment.side} — location could not be verified`, visibleBody);
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
    let parsedResponse;
    if (options.structuredResult !== undefined) {
        const rejectionReason = structuredResultRejection(options.structuredResult);
        if (rejectionReason) {
            console.warn(`[pi-reviewer] rejected structured result: ${rejectionReason}`);
            throw new Error(`Agent output was not a valid structured review: ${rejectionReason}`);
        }
        parsedResponse = { result: normalizeReviewResult(options.structuredResult, options, true), parsed: true };
    }
    else {
        parsedResponse = parseAgentResponseWithStatus(options.content ?? "", options.minSeverity, options.allowedFindingIds, options.existingFindingKeys);
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
            throw new Error("Agent output was not a valid structured review; refusing to post raw model output");
        }
        const headers = {
            Authorization: `Bearer ${options.githubToken}`,
            "Content-Type": "application/json",
        };
        // Split comments into inline (positionable on the diff) and moved (kept in
        // the review body). Without a diff we can't validate positions, so every
        // comment is treated as inline (local/SSH callers, which never pass a diff).
        const unique = new Map();
        for (const comment of result.comments)
            unique.set(normalizeFinding(comment), comment);
        const comments = [...unique.values()];
        let inline = comments;
        let moved = [];
        if (options.diff) {
            const positions = parseDiffPositions(options.diff);
            ({ inline, moved } = partitionComments(comments, positions));
            if (moved.length > 0) {
                console.log(`[pi-reviewer] ${moved.length} comment(s) not positionable on the diff — moved to review body`);
            }
        }
        const inlineComments = inline.map((comment) => ({
            path: comment.file,
            line: comment.line,
            side: comment.side,
            body: `<!-- pi-reviewer:finding:v1 -->\n${comment.body}`,
        }));
        const body = [options.batchMarker, buildReviewBody(result.summary, moved)].filter(Boolean).join("\n\n");
        if (options.commitId && (options.batchMarker || (options.reactOnNoFindings && result.comments.length === 0))) {
            const current = await new GitHubClient(options.githubToken).getPullRequest(options.repo, options.prNumber);
            if (current.head.sha !== options.commitId)
                throw new Error("PR head changed while the review was running; refusing to post a stale batch");
        }
        let outstandingFindings = new Set(options.existingFindings?.map(f => f.commentId));
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
                }
                else {
                    console.log("[pi-reviewer] no findings — thumbs-up reaction already exists on the PR");
                }
                reactionSucceeded = true;
            }
            catch (error) {
                console.warn(`[pi-reviewer] could not leave a thumbs-up reaction: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!reactionSucceeded) {
                console.warn("[pi-reviewer] falling back to the normal no-findings comment");
            }
            else {
                // Keep the authenticated batch marker without adding visible review text.
                // Reactions have no metadata, so the hidden review marker remains the
                // durable range state used by the lifecycle reconciler.
                let markerCreated = true;
                if (options.batchMarker && options.commitId) {
                    try {
                        const markerReview = await client.createReview(options.repo, options.prNumber, options.batchMarker, options.commitId, []);
                        if (markerReview.id) {
                            const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${markerReview.id}`);
                            if (finalized !== options.batchMarker)
                                await client.updateReview(options.repo, options.prNumber, markerReview.id, finalized).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
                        }
                    }
                    catch (error) {
                        markerCreated = false;
                        console.warn(`[pi-reviewer] could not create batch marker: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                if (markerCreated)
                    return { commentIds: [], fallback: false };
                console.warn("[pi-reviewer] falling back to the normal no-findings comment");
            }
        }
        // Try PR Reviews API first (supports inline comments and a body).
        if (options.commitId) {
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
                if (options.batchMarker && options.githubToken && options.repo && options.prNumber) {
                    const posted = await reviewResponse.clone().json().catch(() => undefined);
                    if (posted?.id) {
                        const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${posted.id}`);
                        if (finalized !== options.batchMarker)
                            await new GitHubClient(options.githubToken).updateReview(options.repo, options.prNumber, posted.id, [finalized, buildReviewBody(result.summary, moved)].join("\n\n")).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
                    }
                }
                if (!findingUpdatesReconciled && result.finding_updates?.length && options.existingFindings && options.githubToken && options.repo && options.prNumber && options.commitId) {
                    await reconcileFindingUpdates({ token: options.githubToken, repo: options.repo, prNumber: options.prNumber, targetSha: options.commitId, updates: result.finding_updates, findings: options.existingFindings });
                }
                const posted = await responseJson(reviewResponse);
                return { reviewId: posted?.id, commentIds: posted?.comments?.flatMap(c => c.id ? [c.id] : []) ?? [], fallback: false };
            }
            let errBody = await reviewResponse.text().catch(() => "");
            console.warn(`[pi-reviewer] inline comments rejected (${reviewResponse.status}) — ${errBody}`);
            // A 422 means GitHub couldn't resolve at least one position we thought was
            // valid (e.g. a force-push changed the diff between resolution and post).
            // Retry once as a body-only review, moving every comment into the body.
            if (reviewResponse.status === 422) {
                const allMovedBody = [options.batchMarker, buildReviewBody(result.summary, comments)].filter(Boolean).join("\n\n");
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
                    if (options.batchMarker && options.githubToken && options.repo && options.prNumber) {
                        const posted = await reviewResponse.clone().json().catch(() => undefined);
                        if (posted?.id) {
                            const finalized = options.batchMarker.replace(/("reviewId"\s*:\s*)0/, `$1${posted.id}`);
                            if (finalized !== options.batchMarker)
                                await new GitHubClient(options.githubToken).updateReview(options.repo, options.prNumber, posted.id, [finalized, allMovedBody].join("\n\n")).catch(error => console.warn(`[pi-reviewer] could not finalize batch marker: ${error instanceof Error ? error.message : String(error)}`));
                        }
                    }
                    if (!findingUpdatesReconciled && result.finding_updates?.length && options.existingFindings && options.githubToken && options.repo && options.prNumber && options.commitId)
                        await reconcileFindingUpdates({ token: options.githubToken, repo: options.repo, prNumber: options.prNumber, targetSha: options.commitId, updates: result.finding_updates, findings: options.existingFindings });
                    const posted = await responseJson(reviewResponse);
                    return { reviewId: posted?.id, commentIds: posted?.comments?.flatMap(c => c.id ? [c.id] : []) ?? [], fallback: true };
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
            body: JSON.stringify({ body: [options.batchMarker, formatForGitHub(result)].filter(Boolean).join("\n\n") }),
        });
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
