const marker = /<!-- pi-reviewer:batch:v1 (\{[^\n]*\}) -->/;
const bodyFindingMarker = /<!-- pi-reviewer:body-finding:v1 (\{[^\n]*\}) -->/g;
export function encodeBatchMarker(value) { return `<!-- pi-reviewer:batch:v1 ${JSON.stringify({ version: 1, ...value })} -->`; }
export function decodeBatchMarker(body) { const match = body?.match(marker); if (!match)
    return undefined; try {
    const value = JSON.parse(match[1]);
    return value.version === 1 && typeof value.fromSha === "string" && typeof value.toSha === "string" && typeof value.actor === "string" && typeof value.reviewId === "number" ? value : undefined;
}
catch {
    return undefined;
} }
export function bodyFindingId(identity) {
    // A positive, deterministic ID is required because body findings have no
    // GitHub comment ID.  48 bits fit exactly in a JavaScript safe integer.
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(identity))
        hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    return Number(hash & 0x0000ffffffffffffn) || 1;
}
export function encodeBodyFindingMarker(value) {
    const json = JSON.stringify({ version: 1, status: "ACTIVE", ...value }).replace(/-->/g, "--\\u003e");
    return `<!-- pi-reviewer:body-finding:v1 ${json} -->`;
}
function isBodyFinding(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return v.version === 1 && Number.isSafeInteger(v.findingId) && v.findingId > 0 && typeof v.file === "string" && Number.isInteger(v.line) && (v.side === "LEFT" || v.side === "RIGHT") && ["CRITICAL", "WARN", "INFO"].includes(v.severity) && typeof v.body === "string" && ["ACTIVE", "PARTIALLY_RESOLVED", "RESOLVED"].includes(v.status);
}
export function decodeBodyFindingMarkers(body) {
    if (!body)
        return [];
    bodyFindingMarker.lastIndex = 0;
    const findings = [];
    for (const match of body.matchAll(bodyFindingMarker)) {
        try {
            const value = JSON.parse(match[1]);
            if (isBodyFinding(value))
                findings.push(value);
        }
        catch { /* ignore malformed hidden metadata */ }
    }
    return findings;
}
export function updateBodyFindingMarker(body, findingId, status, targetSha, explanation) {
    bodyFindingMarker.lastIndex = 0;
    return body.replace(bodyFindingMarker, (raw, json) => {
        try {
            const value = JSON.parse(json);
            if (!isBodyFinding(value) || value.findingId !== findingId)
                return raw;
            return encodeBodyFindingMarker({ ...value, status, targetSha, explanation });
        }
        catch {
            return raw;
        }
    });
}
export function reconstructBodyFindings(reviews, login) {
    return reviews.flatMap(review => decodeBodyFindingMarkers(review.body).filter(f => review.user?.login === login && f.status !== "RESOLVED").map(f => ({ commentId: f.findingId, reviewId: review.id, bodyFinding: true, reviewBody: review.body ?? "", file: f.file, line: f.line, side: f.side, body: f.body, sourceBatch: undefined, latestStatus: f.status === "PARTIALLY_RESOLVED" ? "PARTIALLY_RESOLVED" : undefined })));
}
export function selectAuthenticatedBatchMarkers(reviews, login) { return reviews.filter(r => r.user?.login === login).map(r => decodeBatchMarker(r.body)).filter((m) => m !== undefined && m.actor === login); }
export function selectBatchRange(mergeBase, head, latest, isAncestor) { if (!latest || (isAncestor && !isAncestor(latest.toSha, head)))
    return { fromSha: mergeBase, toSha: head, fresh: true }; return { fromSha: latest.toSha, toSha: head, fresh: latest.toSha !== head }; }
export function normalizeEvent(payload) { const p = (payload ?? {}); const pr = p.pull_request; if (pr) {
    if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action))
        throw new Error(`Unsupported pull_request action: ${String(p.action)}`);
    return { kind: p.action === "opened" ? "opened" : "synchronize", pr: pr.number, headSha: pr.head?.sha, beforeSha: p.before, afterSha: p.after, draft: Boolean(pr.draft), fork: !pr.head?.repo || !pr.base?.repo || pr.head.repo.full_name !== pr.base.repo.full_name, actor: { login: p.sender?.login, type: p.sender?.type } };
} const issue = p.issue; if (issue?.pull_request)
    return { kind: "manual", pr: issue.number, command: p.comment?.body?.trim(), draft: Boolean(issue.draft), fork: false, actor: { login: p.comment?.user?.login, association: p.comment?.author_association, type: p.comment?.user?.type } }; const inputs = p.inputs ?? {}; const prNumber = Number(inputs["pr-number"] ?? inputs.pr_number); return { kind: "manual", pr: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : undefined, targetHead: inputs["target-head"], draft: false, fork: false }; }
export function isEventHeadConsistent(event, head) { return !event.afterSha || event.afterSha === head; }
export function isEventRangeConsistent(event, fromSha, head) { return isEventHeadConsistent(event, head) && (!event.beforeSha || event.beforeSha === fromSha); }
export function isAuthorizedReviewCommand(event) { return event.command === "/pi-review" && event.actor?.type !== "Bot" && ["OWNER", "MEMBER", "COLLABORATOR"].includes(event.actor?.association ?? ""); }
