# Plan: Review PR commit batches and maintain review threads

> **Status:** Draft
> **Issue:** TBD

## Context

The current GitHub Action reviews the current PR diff, but it has no durable
notion of which review batch was processed and cannot reconcile the agent's
own inline findings when later code addresses them.

The desired unit is a **PR event batch**, not an individual commit:

- When a PR opens, review all changes currently in the PR as one review, even
  if the PR already contains many commits.
- When a later push contains many commits, review the changes since the last
  successfully reviewed PR head as one review.
- Post only newly introduced findings for that batch.
- Mark prior findings as `RESOLVED`, `PARTIALLY_RESOLVED`, or `STILL_OPEN`.
- For resolved findings, reply briefly in the original thread and then resolve
  it automatically.

Each invocation remains a fresh agent process. `sessionId` is not required and
does not restore messages. Prior GitHub review summaries and inline threads
provide semantic continuity. Stable prompt prefixes may receive provider-side
automatic caching, but no cache hit is required for correctness.

## Out of Scope

- One LLM review per commit. Multiple commits in one PR event are one batch.
- Restoring or continuing provider-side conversation state with `sessionId`.
- Persisting full pi transcripts in Actions caches, artifacts, branches,
  comments, or an external database.
- Reviewing code before a PR event exists.
- Running provider-keyed reviews for fork PRs.
- Automatically changing human-authored review threads.
- A commentless reviewer mode; remove the unused `post-comment` input instead.

## Phases

### Phase 1 — Add GitHub batch state and event primitives

**Goal:** Identify review batches and prior agent-owned threads from GitHub
using authenticated, testable API boundaries.

- [ ] Add a small `src/ci/github.ts` client over `fetch` with authenticated
  REST/GraphQL requests, page/cursor pagination, status/error handling, and
  response types for PR metadata, reviews, review comments, and review
  threads.
- [ ] Support listing PR reviews/comments and PR head/base metadata, creating
  a review, replying to a top-level review comment, resolving a review thread,
  and querying nested thread/comment connections with cursor pagination.
- [ ] Resolve the authenticated action identity from the token (`GET /user`)
  and require that identity, not a marker alone, for all agent-thread and
  batch-marker mutations. Support `github-actions[bot]` and custom App tokens.
- [ ] Define a hidden, versioned batch marker containing `fromSha`, `toSha`,
  batch kind (`opened`, `synchronize`, or `manual`), and the authenticated
  action identity. Define a separate status-reply marker containing the source
  finding ID and target head SHA.
- [ ] Parse `pull_request`, `issue_comment`, and `workflow_dispatch` payloads
  into normalized PR number, current head, event kind, command, optional
  target head, and actor data. Reject non-PR comments, unsupported commands,
  fork/deleted heads, and unauthorized `/pi-review` callers.
- [ ] For `opened`, select the PR merge-base-to-head range as one batch. For
  `synchronize`, select the unreviewed range from the latest authenticated
  batch's `toSha` to the current head; use the event's before/after SHAs only as
  a consistency check; on mismatch, log it and use the authenticated-marker
  range. If no authenticated marker exists, use the full PR range. For
  manual/comment runs, recompute the same unreviewed range or perform
  reconciliation-only when no new range exists. A manual/comment run against
  a draft PR is a no-op when draft reviews are disabled. `reopened` and
  `ready_for_review` use the same recompute-or-reconciliation-only policy.
- [ ] Ensure a newer current head subsumes missed/coalesced synchronize events:
  the next run reviews the complete range since the latest successful batch,
  rather than trusting that every Actions event received its own runner.
- [ ] Define force-push handling: detect when the latest marked `toSha` is not
  an ancestor of the current head, then start a fresh batch at the PR
  merge-base and current head. A new marker supersedes the stale range for
  future selection, while all prior active findings remain available for
  reconciliation. Order candidate markers by authenticated review creation
  order/review ID, not by commit timestamp.
- [ ] Add unit tests for REST/cursor pagination, event normalization, actor
  permission checks, marker authenticity, opened batches with many commits,
  synchronize batches with many commits, coalesced events, no-op reruns,
  no-marker adoption, force-push/non-ancestor handling, before/after mismatch
  fallback, and custom App identity.
- [ ] Existing tests still pass: `mise exec -- vp run test`.

### Phase 2 — Resolve batch diffs and prior findings

**Goal:** Give one agent invocation the exact batch diff and sufficient active
review context without replaying an unavailable full transcript.

- [ ] Extend diff resolution to produce one exact `fromSha..toSha` diff per
  batch; use the PR merge-base with the current head for an opened or
  no-marker batch, and use the last successfully marked head with the current
  head for later pushes. Do not invoke the model once per commit.
- [ ] Check out the current PR head with `fetch-depth: 0` and use a temporary
  worktree or equivalent SHA-addressed read-only context when the selected
  review head (`toSha`) differs from the checked-out working tree.
- [ ] Retrieve all authenticated action-owned top-level inline findings that
  are unresolved or partially resolved, including their root comment, latest
  action status reply, thread ID, source batch, path/line/side, and current
  thread state.
- [ ] Include only the latest relevant prior review summary as lightweight
  continuity context. Exclude fully resolved history from the main prompt;
  bound active findings, replies, summary length, and total prompt size with
  deterministic ordering/truncation.
- [ ] If the current head changes during processing, stop before posting a
  stale batch and let the next run recompute the range from the latest marker.
- [ ] Define the no-marker adoption behavior explicitly: the first upgraded
  run, a draft-to-ready run without a marker, or a workflow installed after a
  PR was opened may review the full current PR range once. This is a review
  after a PR event exists, not a review run before the PR.
- [ ] Define safe fallback behavior when GitHub rejects a historical inline
  position: retry the same batch as a body-only review with its batch marker,
  never silently discard the finding.
- [ ] Add tests for exact opened/base-to-head and synchronize/from-to diffs,
  multi-commit batches, prior active/partial/resolved findings, bounded prompt
  context, no-marker adoption, head changes, force-pushes, and body-only
  fallback.

### Phase 3 — Add structured finding status output

**Goal:** Distinguish new findings from updates to prior findings in a stable
CI-only result contract.

- [ ] Add an optional `finding_updates` array with `{ comment_id, status,
  explanation }`, where status is `RESOLVED`, `PARTIALLY_RESOLVED`, or
  `STILL_OPEN`; accept only comment IDs supplied in the prompt and bind them to
  validated thread IDs.
- [ ] Update the `submit_review` tool schema and text parser to validate update
  IDs/statuses, reject unknown IDs, bound explanations, and preserve legacy
  `{ summary, comments }` responses.
- [ ] Specify that `comments` contains only issues introduced by the current
  batch; existing issues must use `finding_updates` and must not be reposted.
  Partial updates must state what changed and what remains. Still-open updates
  must not create repeated replies.
- [ ] Add a deterministic duplicate guard using normalized `(file, line, side,
  body)` values: trim, collapse blank lines, and strip a leading severity emoji.
- [ ] Preserve severity filtering and diff-position validation for new findings.
- [ ] Add prompt/parser/schema tests for new, still-open, partial, and fully
  resolved findings; unknown IDs; legacy results; duplicate normalization; and
  minimum-severity filtering.

### Phase 4 — Post one review per batch and reconcile threads

**Goal:** Publish one durable review per selected batch, then apply validated
status transitions safely and idempotently.

- [ ] Refactor the GitHub output path to return posted review/comment metadata.
- [ ] Always create one commit-anchored GitHub review for a batch, including a
  no-new-issues review, with its hidden batch marker and concise summary.
  Position new findings against the batch diff; retain the existing 422
  body-only fallback.
- [ ] Mark new inline comments with the authenticated action marker and map
  returned/follow-up comment IDs to the result without relying only on array
  order.
- [ ] For `RESOLVED`, post exactly one marked reply such as `Resolved in
  <short SHA>: <explanation>`, then call `resolveReviewThread`. For
  `PARTIALLY_RESOLVED`, post at most one marked explanatory reply and leave the
  thread open. For `STILL_OPEN`, perform no mutation.
- [ ] If reply succeeds but resolution fails, retry only the resolution
  mutation; if reply fails, leave the finding active for a later batch or an
  explicit recovery run. Never resolve human-authored threads.
- [ ] Treat the batch marker as review-post completion, not proof that every
  thread reconciliation succeeded. Make reply and resolution operations
  independently retryable.
- [ ] Add mocked API integration tests for one review covering many commits,
  new inline findings, partial updates, total resolution, still-open findings,
  duplicate reruns, spoofed markers, custom App identity, reply failure,
  resolve failure, and body-only fallback.
- [ ] Existing output tests still pass.

### Phase 5 — Generate suitable GitHub workflows and document behavior

**Goal:** Trigger batch reviews for PR events without unsafe or redundant
execution.

- [ ] Generate triggers for `pull_request` `opened`, `synchronize`,
  `reopened`, and `ready_for_review`, plus `issue_comment.created` and
  `workflow_dispatch`. A PR open with many commits produces one review, not
  one review per commit.
- [ ] Add a `review-drafts` initialization option, defaulting to `false`.
  When disabled, draft `opened`/`synchronize` events are no-ops and
  `ready_for_review` reviews the accumulated PR range once; `/pi-review` and
  manual dispatch also remain no-ops for drafts. When enabled, draft events
  use the normal batch behavior.
- [ ] Restrict `/pi-review` to PRs, the exact supported command, non-bot
  authors with `OWNER`, `MEMBER`, or `COLLABORATOR` association, and internal
  PR heads. Prevent bot replies from recursively triggering runs.
- [ ] Add workflow dispatch PR-number and optional target-head inputs. Validate
  a target belongs to the current PR head ancestry before reviewing it.
- [ ] Use exact internal PR-head checkout with `fetch-depth: 0`; never execute
  checked-out PR code. Add a repository/PR concurrency group with
  `cancel-in-progress: false`, while relying on latest-marker range recompute
  because GitHub retains only one pending concurrency run.
- [ ] Remove the unused `post-comment` input from `action.yml`, `CI.md`, and
  generated documentation. Add event-aware action-entry behavior while
  retaining the current pull-request path.
- [ ] Update `src/ci/init.ts`, `action.yml`, `CI.md`, README CI usage, and
  init/action-entry tests, including workflow snapshots and trusted internal
  PR/fork behavior.
- [ ] Document that the durable state is authenticated GitHub batch markers
  and review threads, not an LLM session or Actions cache; explain batching,
  draft policy, partial/total status handling, retries, manual dispatch, and
  fork limits.
- [ ] Run `mise exec -- vp run test`, `mise exec -- vp run build`, and
  `mise run lint`.

## Open Questions

- None blocking. The selected behavior is one review per PR event batch:
  `opened` reviews the current PR range once, and each later push reviews the
  accumulated range since the latest successful batch marker once.

## Acceptance Criteria

- [ ] A PR opened with N commits receives exactly one batch review covering its
  base-to-head changes.
- [ ] A push containing N commits receives exactly one review covering the
  changes since the latest successfully reviewed head.
- [ ] Coalesced or retried workflow events do not lose changes or create
  duplicate batch reviews.
- [ ] New issues become new inline comments when positionable; existing issues
  are not reposted.
- [ ] Fully addressed findings receive one brief reply and are then resolved.
- [ ] Partially addressed findings receive one explanatory reply and remain
  open; still-open findings receive no repeated reply.
- [ ] Human-authored threads and spoofed markers are never mutated.
- [ ] The workflow supports lifecycle, manual, and `/pi-review` triggers while
  excluding fork PRs and unauthorized callers from secret-bearing execution.
- [ ] No session ID, transcript replay, Actions cache, or provider cache hit is
  required for correctness.
- [ ] All phases pass their tests and the finished plan has been audited by the
  reviewer agent for correctness and completeness.
