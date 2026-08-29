import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseThinkingLevel, review } from "./review.js";
import { GitHubClient } from "./github.js";
import { decodeBatchMarker, encodeBatchMarker, isAuthorizedReviewCommand, isEventRangeConsistent, normalizeEvent, selectAuthenticatedBatchMarkers, selectBatchRange } from "./batch.js";

async function readEvent(): Promise<unknown> {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file) return undefined;
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; }
}
function ancestor(from: string, to: string, cwd = process.cwd()): boolean { try { execFileSync("git", ["merge-base", "--is-ancestor", from, to], { cwd, stdio: "ignore" }); return true; } catch { return false; } }

const payload = await readEvent();
const event = normalizeEvent(payload);
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) { console.error("[pi-reviewer] this action requires GITHUB_REPOSITORY and GITHUB_TOKEN"); process.exit(1); }
if (typeof event.pr !== "number") { console.log("[pi-reviewer] ignoring event without a pull request"); process.exit(0); }
if (event.fork) { console.log("[pi-reviewer] fork PRs are not reviewed because secrets are unavailable"); process.exit(0); }
if (event.command && !isAuthorizedReviewCommand(event)) { console.log("[pi-reviewer] ignoring unauthorized comment"); process.exit(0); }

const github = new GitHubClient(token);
const pr = await github.getPullRequest(repo, event.pr);
if (event.kind === "manual" && event.command !== "/pi-review" && process.env.GITHUB_EVENT_NAME === "issue_comment") { process.exit(0); }
if (pr.draft && process.env.REVIEW_DRAFTS !== "true") { console.log("[pi-reviewer] draft PR reviews are disabled"); process.exit(0); }
const identity = await github.getUser();
const reviews = await github.listReviews(repo, event.pr);
// GitHub returns reviews in chronological order. Preserve that order because a
// failed marker finalization leaves reviewId at 0 and must not sort behind old
// finalized markers.
const marked = selectAuthenticatedBatchMarkers(reviews, identity.login);
const latest = marked.at(-1);
const priorSummary = latest ? reviews.find(r => r.id === latest.reviewId)?.body?.replace(/<!-- pi-reviewer:batch:v1 [^>]+ -->/, "").trim() : undefined;
const batchByReview = new Map(reviews.map(r => [r.id, decodeBatchMarker(r.body)]));
const [comments, threads] = await Promise.all([github.listComments(repo, event.pr), github.listThreads(repo, event.pr)]);
const threadByComment = new Map(threads.flatMap(t => t.comments.nodes.map(c => [c.id, { id: t.id, resolved: t.isResolved }] as const)));
const activeFindings = comments.filter(c => c.user?.login === identity.login && c.id > 0 && c.body.includes("<!-- pi-reviewer:finding:v1 -->") && !c.body.includes("pi-reviewer:status:v1") && !threadByComment.get(c.id)?.resolved).map(c => { const batch = c.pull_request_review_id ? batchByReview.get(c.pull_request_review_id) : undefined; const replies = comments.filter(reply => reply.in_reply_to_id === c.id).sort((a, b) => a.id - b.id); return { commentId: c.id, threadId: threadByComment.get(c.id)?.id, file: c.path, line: c.line, side: c.side, body: c.body, sourceBatch: batch ? `${batch.fromSha}..${batch.toSha}` : undefined, latestStatus: replies.at(-1)?.body.match(/status:v1 \{[^}]*"status":"([^"]+)/)?.[1] }; });
const head = event.targetHead ?? pr.head.sha;
if (pr.head.repo?.full_name !== repo) { console.log("[pi-reviewer] fork or deleted-head PRs are not reviewed"); process.exit(0); }
if (event.targetHead && !ancestor(head, pr.head.sha)) { throw new Error("workflow target-head must be an ancestor of the current PR head"); }
let mergeBase = pr.base.sha;
try { mergeBase = execFileSync("git", ["merge-base", pr.base.sha, head], { cwd: process.cwd(), encoding: "utf8" }).trim() || mergeBase; } catch { console.warn("[pi-reviewer] could not compute merge-base; using PR base SHA"); }
const range = selectBatchRange(mergeBase, head, latest, ancestor);
if (!isEventRangeConsistent(event, latest?.toSha ?? mergeBase, head)) console.warn(`[pi-reviewer] event SHAs differ from authenticated PR state; using authenticated marker range`);
if (!range.fresh && event.kind !== "manual") { console.log("[pi-reviewer] current head was already reviewed"); process.exit(0); }
const minSeverityRaw = process.env.MIN_SEVERITY?.toUpperCase();
const minSeverity = minSeverityRaw === "CRITICAL" || minSeverityRaw === "WARN" || minSeverityRaw === "INFO" ? minSeverityRaw : undefined;
const marker = encodeBatchMarker({ fromSha: range.fromSha, toSha: range.toSha, kind: event.kind, actor: identity.login, reviewId: 0 });
console.log(`[pi-reviewer] reviewing PR #${event.pr}: ${range.fromSha}..${range.toSha}`);
const worktree = await mkdtemp(path.join(tmpdir(), "pi-reviewer-") );
try {
  execFileSync("git", ["worktree", "add", "--detach", worktree, head], { cwd: process.cwd(), stdio: "ignore" });
  await review({ cwd: worktree, pr: event.pr, commitId: head, fromSha: range.fresh ? range.fromSha : head, allowEmptyDiff: !range.fresh, batchMarker: range.fresh ? marker : undefined, activeFindings, priorSummary, output: "comment", minSeverity, thinking: parseThinkingLevel(process.env.PI_REVIEWER_THINKING), githubToken: token, repo });
} finally {
  try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: process.cwd(), stdio: "ignore" }); } catch { await rm(worktree, { recursive: true, force: true }); }
}
