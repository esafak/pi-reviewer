export type BatchKind = "opened" | "synchronize" | "manual";
export type EventKind = BatchKind | "reply";
export interface BatchMarker { version: 1; fromSha: string; toSha: string; kind: BatchKind; actor: string; reviewId: number }
export interface FindingUpdate { comment_id: number; status: "RESOLVED" | "PARTIALLY_RESOLVED" | "STILL_OPEN"; explanation: string }
export type BodyFindingStatus = "ACTIVE" | "PARTIALLY_RESOLVED" | "RESOLVED";
export interface BodyFinding {
  findingId: number;
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: "CRITICAL" | "WARN" | "INFO";
  body: string;
  status: BodyFindingStatus;
  targetSha?: string;
  explanation?: string;
}
const marker = /<!-- pi-reviewer:batch:v1 (\{[^\n]*\}) -->/;
const bodyFindingMarker = /<!-- pi-reviewer:body-finding:v1 (\{[^\n]*\}) -->/g;
export function encodeBatchMarker(value: Omit<BatchMarker, "version">) { return `<!-- pi-reviewer:batch:v1 ${JSON.stringify({ version: 1, ...value })} -->`; }
export function decodeBatchMarker(body: string | null | undefined): BatchMarker | undefined { const match = body?.match(marker); if (!match) return undefined; try { const value = JSON.parse(match[1]); return value.version === 1 && typeof value.fromSha === "string" && typeof value.toSha === "string" && typeof value.actor === "string" && typeof value.reviewId === "number" ? value : undefined; } catch { return undefined; } }
export function bodyFindingId(identity: string): number {
  // A positive, deterministic ID is required because body findings have no
  // GitHub comment ID.  48 bits fit exactly in a JavaScript safe integer.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(identity)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return Number(hash & 0x0000ffffffffffffn) || 1;
}
export function encodeBodyFindingMarker(value: Omit<BodyFinding, "status"> & { status?: BodyFindingStatus }): string {
  const json = JSON.stringify({ version: 1, status: "ACTIVE", ...value }).replace(/-->/g, "--\\u003e");
  return `<!-- pi-reviewer:body-finding:v1 ${json} -->`;
}
function isBodyFinding(value: unknown): value is BodyFinding {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Number.isSafeInteger(v.findingId) && (v.findingId as number) > 0 && typeof v.file === "string" && Number.isInteger(v.line) && (v.side === "LEFT" || v.side === "RIGHT") && ["CRITICAL", "WARN", "INFO"].includes(v.severity as string) && typeof v.body === "string" && ["ACTIVE", "PARTIALLY_RESOLVED", "RESOLVED"].includes(v.status as string);
}
export function decodeBodyFindingMarkers(body: string | null | undefined): BodyFinding[] {
  if (!body) return [];
  bodyFindingMarker.lastIndex = 0;
  const findings: BodyFinding[] = [];
  for (const match of body.matchAll(bodyFindingMarker)) {
    try { const value = JSON.parse(match[1]); if (isBodyFinding(value)) findings.push(value); } catch { /* ignore malformed hidden metadata */ }
  }
  return findings;
}
export function updateBodyFindingMarker(body: string, findingId: number, status: Exclude<BodyFindingStatus, "ACTIVE">, targetSha: string, explanation: string): string {
  bodyFindingMarker.lastIndex = 0;
  return body.replace(bodyFindingMarker, (raw, json: string) => {
    try {
      const value = JSON.parse(json);
      if (!isBodyFinding(value) || value.findingId !== findingId) return raw;
      return encodeBodyFindingMarker({ ...value, status, targetSha, explanation });
    } catch { return raw; }
  });
}
export function reconstructBodyFindings(reviews: Array<{ id: number; body?: string | null; user?: { login?: string } }>, login: string) {
  return reviews.flatMap(review => decodeBodyFindingMarkers(review.body).filter(f => review.user?.login === login && f.status !== "RESOLVED").map(f => ({ commentId: f.findingId, reviewId: review.id, bodyFinding: true, reviewBody: review.body ?? "", file: f.file, line: f.line, side: f.side, body: f.body, sourceBatch: undefined, latestStatus: f.status === "PARTIALLY_RESOLVED" ? "PARTIALLY_RESOLVED" : undefined })));
}
export function selectAuthenticatedBatchMarkers(reviews: Array<{ id: number; body?: string | null; user?: { login?: string } }>, login: string) { return reviews.filter(r => r.user?.login === login).map(r => decodeBatchMarker(r.body)).filter((m): m is BatchMarker => m !== undefined && m.actor === login); }
export function selectBatchRange(mergeBase: string, head: string, latest?: BatchMarker, isAncestor?: (from: string, to: string) => boolean) { if (!latest || (isAncestor && !isAncestor(latest.toSha, head))) return { fromSha: mergeBase, toSha: head, fresh: true }; return { fromSha: latest.toSha, toSha: head, fresh: latest.toSha !== head }; }
export function isSafePullRequestNumber(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function safeNumber(value: unknown): number | undefined {
  try {
    const number = typeof value === "number" ? value : Number(value);
    return isSafePullRequestNumber(number) ? number : undefined;
  } catch {
    return undefined;
  }
}
export interface Event { kind: EventKind; pr?: number; headSha?: string; beforeSha?: string; afterSha?: string; targetHead?: string; command?: string; draft: boolean; fork: boolean; commentId?: number; parentCommentId?: number; actor?: { login?: string; association?: string; type?: string } }
export function normalizeEvent(payload: unknown): Event { const p = (payload ?? {}) as Record<string, any>; const pr = p.pull_request; if (p.action === "created" && p.comment && pr) return { kind: "reply", pr: safeNumber(pr.number), headSha: pr.head?.sha, commentId: safeNumber(p.comment.id), parentCommentId: safeNumber(p.comment.in_reply_to_id), draft: Boolean(pr.draft), fork: !pr.head?.repo || !pr.base?.repo || pr.head.repo.full_name !== pr.base.repo.full_name, actor: { login: p.comment.user?.login ?? p.sender?.login, association: p.comment.author_association, type: p.comment.user?.type ?? p.sender?.type } }; if (pr) { if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action)) throw new Error(`Unsupported pull_request action: ${String(p.action)}`); return { kind: p.action === "opened" ? "opened" : "synchronize", pr: safeNumber(pr.number), headSha: pr.head?.sha, beforeSha: p.before, afterSha: p.after, draft: Boolean(pr.draft), fork: !pr.head?.repo || !pr.base?.repo || pr.head.repo.full_name !== pr.base.repo.full_name, actor: { login: p.sender?.login, type: p.sender?.type } }; } const issue = p.issue; if (issue?.pull_request) return { kind: "manual", pr: safeNumber(issue.number), command: p.comment?.body?.trim(), draft: Boolean(issue.draft), fork: false, actor: { login: p.comment?.user?.login, association: p.comment?.author_association, type: p.comment?.user?.type } }; const inputs = p.inputs ?? {}; return { kind: "manual", pr: safeNumber(inputs["pr-number"] ?? inputs.pr_number), targetHead: inputs["target-head"], draft: false, fork: false }; }
export function isEventHeadConsistent(event: Event, head: string) { return !event.afterSha || event.afterSha === head; }
export function isEventRangeConsistent(event: Event, fromSha: string, head: string) { return isEventHeadConsistent(event, head) && (!event.beforeSha || event.beforeSha === fromSha); }
export function isAuthorizedReviewCommand(event: Event) { return event.command === "/pi-review" && event.actor?.type !== "Bot" && ["OWNER", "MEMBER", "COLLABORATOR"].includes(event.actor?.association ?? ""); }
export function isAuthorizedReply(event: Event) { return event.kind === "reply" && event.actor?.type !== "Bot" && ["OWNER", "MEMBER", "COLLABORATOR"].includes(event.actor?.association ?? ""); }

export const replyMarker = (commentId: number, parentId: number, threadId: string) => `<!-- pi-reviewer:reply:v1 ${JSON.stringify({ version: 1, commentId, parentId, threadId })} -->`;
export function decodeReplyMarker(body: string | null | undefined): { version: 1; commentId: number; parentId: number; threadId: string } | undefined {
  const match = body?.match(/<!-- pi-reviewer:reply:v1 (\{[^\n]*\}) -->/); if (!match) return undefined;
  try { const v = JSON.parse(match[1]); return v.version === 1 && Number.isSafeInteger(v.commentId) && Number.isSafeInteger(v.parentId) && typeof v.threadId === "string" ? v : undefined; } catch { return undefined; }
}
export function isPiReviewerRootComment(comment: { body?: string | null; in_reply_to_id?: number }): boolean {
  return comment.in_reply_to_id == null && comment.body?.includes("<!-- pi-reviewer:finding:v1 -->") === true && !comment.body.includes("pi-reviewer:status:v1");
}
