const marker = /<!-- pi-reviewer:batch:v1 (\{[^\n]*\}) -->/;
export function encodeBatchMarker(value) { return `<!-- pi-reviewer:batch:v1 ${JSON.stringify({ version: 1, ...value })} -->`; }
export function decodeBatchMarker(body) { const match = body?.match(marker); if (!match)
    return undefined; try {
    const value = JSON.parse(match[1]);
    return value.version === 1 && typeof value.fromSha === "string" && typeof value.toSha === "string" && typeof value.actor === "string" && typeof value.reviewId === "number" ? value : undefined;
}
catch {
    return undefined;
} }
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
