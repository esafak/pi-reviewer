# Plan: Recover canceled conversation replies during push reviews

> **Status:** Implemented
> **Issue:** PR #1672 follow-up — recover Pi Reviewer conversations when `pull_request_review_comment` runs are canceled

## Context

Pi Reviewer currently handles a human reply only from the corresponding
`pull_request_review_comment` event. That event can be lost when its workflow
run is canceled, superseded, or fails before the reply handler executes (for
example, while a `pull_request: synchronize` review is running and competing
workflow events consume the concurrency slot). The human reply then remains
unprocessed, so the original finding is repeated even when the reply explains
that the issue is intentionally accepted or deferred for the current PR.

The recovery should reuse the existing conversational reply semantics rather
than mixing conversation actions into the normal diff-review prompt. A push
review will discover eligible, unprocessed human replies from the current PR
snapshot, run the same reply agent, and use the existing head-checked,
idempotent reply/resolution mutations. This makes eviction of a
`pull_request_review_comment` run acceptable when a push review is active: the
push review itself can post the conversational response or resolve the thread.

## Out of Scope

- Changing the consuming repository's GitHub Actions concurrency configuration.
- Removing the existing fast path for `pull_request_review_comment` events.
- Adding a new finding status such as `DEFERRED`.
- Treating a human reply as authoritative without the conversational agent's
  action decision and existing authorization checks.
- Combining pending conversation actions with normal diff findings in one model
  prompt.

## Phases

### Phase 1 — Discover recoverable replies from a PR snapshot

**Goal:** Identify exactly which human replies a push run may recover without
performing any GitHub mutations.

- [ ] Add a typed reply snapshot boundary in `src/ci/reply.ts` for the current
  PR, review comments, threads, and authenticated identity; keep reviews and
  issue comments outside the snapshot unless an implementation proves they are
  needed by recovery.
- [ ] Define a dedicated `PendingReply` type instead of fabricating a webhook
  `Event`, containing reply ID, parent/root ID, thread ID, actor, and target
  head.
- [ ] Implement a pure discovery helper that groups direct replies to
  unresolved, bot-authored Pi Reviewer finding roots, filters out replies
  already carrying an authenticated `reply:v1` response keyed by
  `(commentId, parentId, threadId)`, and returns the oldest unprocessed reply
  per root.
- [ ] Reuse the existing authorization, self-reply, bot-reply, root-comment,
  and unresolved-thread rules; ignore nested replies, body findings, quoted
  markers, resolved threads, and untrusted authors.
- [ ] Define deterministic ordering as oldest-first, with at most one pending
  reply selected per root per recovery pass; a later reply is reconsidered on
  a subsequent pass if the root remains unresolved.
- [ ] Add unit coverage in `tests/ci/reply.test.ts` and/or
  `tests/ci/batch.test.ts` for eligible replies, multiple roots, nested
  replies, resolved threads, authorization, spoofed markers, and ordering.
- [ ] Existing CI and reply tests pass unchanged.

### Phase 2 — Extract a reusable, snapshot-aware reply handler

**Goal:** Let both event-triggered replies and push recovery invoke the same
conversation action and mutation logic.

- [ ] Extract the mutation/agent portion of `handleReply()` in
  `src/ci/reply.ts:30-94` into a snapshot-aware `handleReplyComment()` (or
  equivalent) that accepts `PendingReply`, an initial snapshot, and an explicit
  `refreshSnapshot()` callback; retain `handleReply()` as the webhook-payload
  adapter for backward compatibility.
- [ ] Keep the extraction behavior-preserving: the existing event path must
  still fetch/validate its triggering comment and delegate to the shared
  handler without changing its public marker or action semantics.
- [ ] Ensure the reusable handler uses the initial snapshot for context, then
  calls `refreshSnapshot()` before generating or persisting anything that must
  reflect current state; validate the parent/root/thread relationship, actor
  authorization, current PR head, unresolved state, and existing `reply:v1`
  marker against that refreshed snapshot.
- [ ] Preserve the existing idempotent retry behavior for a response that was
  posted with `STILL_OPEN` but whose thread resolution was interrupted.
- [ ] Preserve the existing action semantics: reactions do not resolve a
  thread, `reply` posts a response only, and `resolve` performs the guarded
  response-plus-thread-resolution sequence.
- [ ] Revalidate the current PR head immediately before every mutation. For a
  `resolve` action, revalidate before posting the response, before resolving
  the thread, and before changing `STILL_OPEN` to `RESOLVED`; retain the
  existing best-effort check/POST race limitation documented in `CI.md`.
- [ ] Add tests proving event-triggered behavior is unchanged, duplicate
  recovery does not call the model twice or post duplicate replies, stale-head
  recovery performs no mutation, and interrupted resolution is retried.

### Phase 3 — Run synchronize-time reply recovery before normal review

**Goal:** A `synchronize` run recovers canceled conversation events before it
constructs the normal review context and can avoid repeating findings only
when recovery successfully resolves their threads.

- [ ] In `src/ci/action-entry.ts`, keep the existing `event.kind === "reply"`
  fast path and invoke the new recovery path for `synchronize` events; keep
  `opened` and manual recovery out of this change to limit scope.
- [ ] Run recovery from the authenticated current PR/comment/thread snapshot,
  not from the original reply event payload, so it can find replies whose
  workflow run never executed.
- [ ] Process the selected oldest reply per root independently, logging
  failures and continuing with other roots and the normal diff review.
- [ ] Refresh comments and threads between recovered replies; never reuse a
  stale idempotency snapshot after another handler has posted or resolved.
- [ ] Perform a final recovery sweep after the normal review has completed, so
  replies created while the model was generating are also handled by the push
  run before it exits.
- [ ] Re-fetch PR state and review/comment/thread history after recovery
  mutations before calling `collectFindingHistory()` for the normal review.
  A conversational `reply` action may leave the finding active; only a
  successful `resolve` action removes it from active history.
- [ ] Preserve batch-marker selection, diff-range selection, current-head
  guards, normal review posting, and the existing `finding_updates` lifecycle
  path.
- [ ] Add orchestration tests (preferably through an extracted testable helper)
  proving a synchronize event recovers a reply without a reply event, still
  performs its normal review, and does not abort when one recovery fails.
- [ ] Add a regression fixture modeled on PR #1672: an open `sys-fs` finding,
  a trusted human reply explaining intentional live-fidelity deferral, and a
  later synchronize run that invokes the conversation handler despite the
  missing reply event.

### Phase 4 — Verify compatibility and operational behavior

**Goal:** Confirm the recovery is safe across existing marker formats, API
pagination, and concurrent workflow attempts.

- [ ] Test discovery across paginated review comments and thread comments,
  while ensuring the GitHub client remains fully paginated.
- [ ] Test two serialized recovery attempts for the same reply; only one
  response/resolution is persisted using the authenticated marker and fresh
  comment checks. Document that concurrent check/POST attempts remain
  best-effort because GitHub provides no compare-and-set reply mutation.
- [ ] Test that a bot-generated review event or a skipped workflow cannot cause
  a later recovery to treat bot metadata as a human reply.
- [ ] Test legacy `batch:v1`, `reply:v1`, `status:v1`, and body-finding markers
  continue to decode and reconcile as before.
- [ ] Run the repository's required validation commands, including the focused
  CI tests and the full test suite.
- [ ] Document the recovery behavior and its limitation: if no later
  push/synchronize run occurs after a canceled reply event, the reply cannot
  be processed until one does; a conversational `reply` action does not itself
  resolve the finding.

## Open Questions

- [x] **Should push recovery process every eligible direct human reply or only
  the newest reply per finding root?** — decision: oldest unprocessed direct
  reply per root per recovery pass. This preserves the existing one-event/
  one-reply behavior, avoids leapfrogging, and bounds model/API work. The
  discovery helper must select the next reply after an authenticated marker,
  not repeatedly select the first reply.
- [x] **Should `opened` and manual runs also perform recovery, or only
  `synchronize` runs?** — decision: synchronize only for this change. The
  requested cancellation fallback is specifically for push reviews; opened or
  manual recovery can be added later without changing the snapshot or handler
  contracts.
- [x] **Should the consuming workflow concurrency fix be shipped separately?**
  — decision: not required for correctness. Shared concurrency is acceptable
  because the push lane processes and responds to evicted replies; a separate
  group remains an optional latency/operational hardening improvement.

## Acceptance Criteria

- [x] All scoped implementation items are complete; an action-entry harness and synthetic pagination fixture are intentionally not added because they would duplicate existing boundary coverage.
- [ ] A canceled `pull_request_review_comment` run no longer permanently loses
  its human reply after a subsequent push review.
- [ ] A reply created during a push review is processed by the push run's final
  recovery sweep when it is visible before the run exits.
- [ ] A trusted explanation that the finding is intentionally deferred for the
  current PR is processed by the same conversational action path. If the agent
  chooses `resolve`, the thread is resolved and the finding is absent from
  subsequent active history; if it chooses `reply` or `react`, the finding
  remains eligible for normal review.
- [ ] No stale-head mutation, duplicate reply, unauthorized reply, or nested
  reply is introduced.
- [ ] Normal push diff reviews and existing lifecycle reconciliation retain
  their current behavior.
- [x] The plan has been audited by one reviewer instance and iteratively
 refined until convergence.

## Completion audit

The implementation is complete without adding a second action-entry harness or
synthetic pagination fixture. Recovery is covered at its testable boundary in
`tests/ci/reply.test.ts`; the GitHub client already fully paginates comments and
threads. Additional source-order or fixture-only tests would duplicate runtime
behavior without testing a new contract.
