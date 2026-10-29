# Plan: Stateless sharded review for oversize diffs

> **Status:** Signed off — all three phases implemented and reviewer-signed-off on `feature/large-diff-sharding` (Phase 1: planning pure functions; Phase 2: child-process fan-out + deterministic merge; Phase 3: `submit_shard`/`submit_overview` + in-process synth). No commit made per repo conventions — awaiting user approval to commit/PR.
> **Issue:** large diff handling refactor (discussion Oct 2026)

## Context

Single-pass review injects the whole diff into one agent run. The cap is
already pi-derived (`resolveMaxDiffChars`: `contextWindow*4 − nonDiffChars −
40k tool headroom − outputReserve`, clamped `[100k, 500k]`, unknown models →
100k; explicit flag/env/config values are returned verbatim and may exceed the
derived ceiling). If the noise-stripped diff fits, that path stays exactly as
is.

When it does not fit, `filterDiff` skip-and-continues whole-file sections in
diff order and lists the scattered skipped sections as `skippedFiles`
("not reviewed"). That is order-biased and drops arbitrarily large
single-file sections. Agentic reviewers (Qodo PR-Agent chunk + judge,
CodeRabbit parallel + merge) converge on the same fix: token-aware per-file
sharding with a map-reduce merge. We adopt that shape, stateless: no daemon,
no persisted index, no cache restore. Each CI run is cold. Read + LSP tools on
CI comment runs provide on-demand semantic reachability for covered languages
(comment-only per `resolveLspPlan`/`review.ts:738–744`; a language whose server
binary is missing gets no LSP coverage per `review.ts:839–851`), which is why
the disk-backed graph half of the research stays tabled. The merge is
deterministic and within-shard only: findings from different shards are never
cross-checked, so a contradiction visible only across two shards is not
detected.
Shards run as child processes (one OS process per shard): separate heaps,
separate env, separate sessions, separate LSP/MCP servers. The parent
orchestrates (fan-out, barrier, merge) and never shares mutable state with a
shard. pi-lsp is unchanged — each child runs the exact session setup
`review()` performs today, in its own process where the existing
`PI_AGENT_DIR`/`agentDir` discipline is already correct. In-process parallel
agents were rejected: `PI_AGENT_DIR` is process-global and read lazily, so
concurrent in-process sessions would cross-read trust config (verified by
reading the adapter and pi-lsp sources, not just asserted).

## Out of Scope

- Persistent indexes of any kind: `codebase-memory-mcp` daemon /
  `CBM_CACHE_DIR`, GitHub Actions cache for indexes, `diff-core`
  `.diffcore/cache` restore, cross-run shard caches.
- `diff-core` or `codebase-memory-mcp` as CI dependencies (binaries, install
  steps, `mcp-config-file` additions). Local spikes may use them for ordering
  experiments only.
- Lazy on-demand diff (inject file list, agent pulls hunks). Shards always
  inject their diff text.
- Flow-group / blast-radius sharding (AST/data-flow clustering, execution
  replay, Louvain, `CROSS_*` edges). Shard 1 holds the legacy-kept set (the
  exact skip-and-continue selection under the fit cap, in diff order) with the
  remainder packed in diff order into shards 2..5 (no size-desc reorder).
- Generic LLM refinement loops (including conditional cross-shard verification
  passes: the merge never re-runs the model on merged findings).
- Swapping the LSP backend (spiked `nikmmd/pi-lsp-adapter`: process-safe but
  its hardcoded 12-extension filetype map drops `.mts/.cts/.pyi/.md/.toml/
  .kt` coverage — an unacceptable review-coverage regression; revisit only
  if upstream adds configurable filetype overrides).
- Protocol Buffers / disk-flushed intermediates, cross-repo intelligence,
  docs/PDF/infra graph linking.
- Changes to `NOISE_PATTERNS`, explicit-cap precedence
  (flag > env > config), or the fit-path single-pass behavior. `resolveDiff`
  (`diff-resolver.ts:128–132`, currently exported but unreferenced from `src/`)
  stays untouched.
- Posting derived-size tables or shard internals in the review body.

## Shared types and log ids

- [ ] `SkippedReason = "shard_failed" | "shard_limit" | "oversize"`
  and `interface SkippedFile { path: string; reason: SkippedReason; cap: number }`
  defined once in `src/core/diff-filter.ts` (`output.ts` imports from there;
  direction stated so nobody moves it). `filterDiff` and its two legacy call
  sites (terminal/file, `summaryOnly`) keep today’s wording byte-identical
  (`Diff budget exceeded …`, `output.ts:155-190`): the single legacy
  constructor (`review.ts:1059-1066`) gains exactly one field,
  `kind: "budget"`, and nothing else changes in that arm. The existing notice
  literals gain the same tag-only edit (no wording or assertion changes):
  `tests/core/output.test.ts` (nine sites) and
  `tests/ci/review.test.ts:2387-2391`; verified by `vpr test
  tests/core/output.test.ts`, `vpr test tests/ci/review.test.ts`, and
  `vpr build` (the tag is required, so untagged literals would fail `tsc`).
  `planReview` keys a Record off the reason union. The posted notice becomes a
  discriminated union:
  `type SkippedDiffNotice = { kind: "budget"; files: string[]; cap: number;
  shortfall: number } | { kind: "sharded"; files: SkippedFile[] }`
  (legacy call sites pass `kind: "budget"`; the sharded path passes
  `kind: "sharded"`). Each `SkippedFile` carries its own `cap` (attempted
  shard’s cap; for `oversize` the file’s own section size per the Phase 1
  rule); the sharded variant keeps NO notice-level `cap` or `shortfall` — a
  single notice-level value cannot represent per-file reasons — and
  `renderSkippedDiffNotice` branches on `kind`: the `budget` arm renders
  byte-identical wording to today, the `sharded` arm gains three per-reason
  message variants, each capped by `MAX_LISTED_SKIPPED_FILES`.
  `reason: "shard_limit"` covers both the `MAX_SHARDS` cutoff and the
  deadline cut below ("we stopped starting shards" — stated explicitly so the
  "Shard limit …" wording is not misleading for a time cut).
- [ ] `interface DiffShard { diff: string; files: string[] }` (`diff` includes
  the `diff --git` headers since the concatenation feeds `parseDiffPositions`,
  which splits on those headers; `files` in diff order) and
  `type ReviewShardPlan = { kind: "single"; diff: string; warning?: string; skipped: SkippedFile[] } | { kind: "sharded"; shards: DiffShard[]; warning?: string; skipped: SkippedFile[] } | { kind: "unreviewable"; warning?: string; skipped: SkippedFile[] }`
  (named union; `warning`/`skipped` on all variants so the noise-exclusion
  warning survives either path; `single.skipped` is always empty — stated so
  the merge code does not read it as if single can skip; `unreviewable` means
  zero reviewable sections and maps to a coded hard error, never a string
  match).
- [ ] Parent↔child contract named once in new `src/ci/shard-protocol.ts`
  (one source of truth; parent and child both import it; validated with
  `unknown` + narrowing on every read, never `as` casts):
  `interface ShardRequest { index: number; total: number; cwd: string; shard: DiffShard; systemPrompt: string; userPrompt: string; model: string; thinkingLevel: ThinkingLevel; minSeverity: MinSeverity; debug: boolean; tools: { lspEntries: LspFileServer[]; lspEnabled: boolean; mcpConfig?: CiMcpConfig; mcpServerCwd?: string; citationOffset: number }; tracing: { artifactPath: string } | null } (null disables tracing regardless of debug)`
  (all plain JSON; code-exec is never in the contract — shards cannot run it).
  `interface ShardEnvelope { index: number; status: "ok" | "error"; decision: "review" | "none"; result?: unknown; evidence?: unknown; mcpFailures?: { identity: { server?: string; tool: string }; signal: { errorClass: string; detail?: string }; repoIds: string[]; unindexed: boolean }[]; error?: string }`
  (transport only; the parent validates `result` against the phase's tool schema
  and `evidence` as snapshot arrays before merging; `decision` mirrors the
  shard tool's action so the merge never re-derives it from presence/absence
  of fields — a captured `"none"` is distinct from "no decision captured".
  A missing envelope file (child killed before atomic write) maps to
  `shard_failed` exactly like invalid JSON or non-zero exit without output.)
  `cwd` is required (not `process.cwd()`): CI reviews run in a temporary
  PR worktree (`action-entry.ts` passes `cwd: worktree`), and a child that
  inherits the parent's cwd would read the base checkout while using
  LSP roots probed against the worktree — silently wrong, so the child
  passes `cwd` through as `options.cwd` and the spawn sets it as the
  child's working directory too. `lspEnabled` is explicit (not derived from
  `lspEntries.length`): it is true whenever `lsp-servers` is configured even
  with zero installed binaries, and that case must still create the extension
  session (which then throws if pi-lsp registers nothing) rather than
  silently taking the plain-`Agent` path.
- [ ] Closed shard-domain types named once in `src/core/shard-tool.ts` (one
  source of truth; schema, mapper, and reduce all reference them, never inline
  literals): `interface DigestEntry { file: string; what: string; risks: string[] }`
  and `interface ShardFinding { file: string; line: number; side: "LEFT" | "RIGHT"; severity: "CRITICAL" | "WARN" | "INFO"; body: string; suggestion?: string }`
  (the mapper's input shape: today's `ReviewComment` fields minus harness-owned
  identity and provenance — no `resolved_finding_id`, no `re_raise_*`, no
  `reRaiseProvenance`, which only exist post-merge).
  Pipeline order is fixed: merge → map to `ReviewComment` → optional reduce →
  `sendOutput` (the map step is the Phase 3 `ShardFinding → ReviewComment`
  mapper; `submit_review` already yields `ReviewComment`, so Phase 2's merge
  feeds `sendOutput` directly).
- [ ] Log ids (single home; phases extend, never rename; contents never
  logged — counts and char lengths only): `review.diff.warning`
  (noise-exclusion warning on the new path — the only operator-visible signal
  that noise was dropped, same as `review.ts:1078` today),
  `review.diff.sharded` (carries `maxShards`, `runs`, per-shard `cap`),
  `review.diff.budget` (per shard + derived-size totals + top-5 largest
  files), `review.diff.shard.oversize`, `review.shard.stray` (wrong-shard vs
  absent-from-diff counts kept distinct), `review.shard.overview_dropped`
  (Phase 2 only; deleted in Phase 3 when `submit_shard` loses the overview
  fields — removal noted at the phase boundary since the table rule is
  extend-never-rename),
  `review.shard.update_conflict`,
  `review.shard.digest_incomplete` (backfilled files; extra-file ignores count
  separately as `review.shard.digest_extra`),
  `review.shard.reduce.failed`, `review.mcp.failed` (with shard index).

## Phases

### Phase 1 — Add shard planning pure functions

**Goal:** Deterministic shard computation with no agent calls.

- [ ] `planReview(kept: string[], excluded: string[], fitCap: number, shardCap: number): ReviewShardPlan`
  in `src/core/diff-filter.ts`: the decision point for **posted (comment-target)
  reviews** (fit/sharded/unreviewable). Sharding is comment-target only:
  terminal/file targets retain the legacy `filterDiff` branch (they neither
  post nor need the merge), and the `summaryOnly` branch explicitly retains
  its existing `filterDiff` call (scatter-skip for regenerated overviews).
  The two legacy call sites are terminal/file and `summaryOnly`; `resolveDiff`
  in `diff-resolver.ts` stays untouched as a sibling API. No-session path: the
  extension session exists only when `needsExtensionSession`
  (`review.ts:1179`); in a comment run with `lsp-servers: none` and no MCP,
  each child runs the existing plain-`Agent` branch (unchanged code, one
  fresh agent per shard with its own `initialState` — nothing to share,
  nothing to `dispose`).

- [ ] Cap arithmetic: callers build **both** candidate prompts first —
  `fitPrompt` (today's full prompt) and `shardBasePrompt` (parameterized, no
  history, no `<pr_summary_policy>`, no `<code_exec_policy>` block, but WITH
  the same PR title/body context — stated, since the subset argument below
  depends on the shard prompt carrying everything the fit prompt carries
  except history and the two omitted blocks) — then
  `fitCap = resolveMaxDiffChars({ explicit: explicitMaxDiffChars, model: modelOpt, nonDiffChars: fitPrompt.length })`
  decides single-vs-sharded. `shardCap` uses the same call shape but with a
  history-bounded prompt size, NOT the bare base and NOT a fixed constant:
  `nonDiffChars = shardBasePrompt.length + <measured global history length>`,
  where the measured term is the rendered global history section — active
  findings + resolved findings + `priorSummary` + the re-raise rule block —
  produced by the extracted `buildHistorySection` on the unfiltered inputs
  (the same builder the per-shard prompts use, so the measurement is exact,
  not an estimate). Rationale, stated as a permanent comment: the actual
  per-shard prompt carries file-filtered history that the bare base lacks, so
  measuring the base alone would over-allocate diff budget past the context
  the cap exists to protect; measuring the *global* (unfiltered) history
  instead is safe because filtering can only shrink per-shard prompts, never
  grow them. Fit `diff` is `kept.join("")`. Test
  (`vpr test tests/core/diff-filter.test.ts -t "shard"`): asserts the fit path
  honours an explicit cap below the floor and above the ceiling.
- [ ] Invariant `shardCap >= fitCap` for identical model/explicit options.
  It holds structurally, not by measurement luck: `shardBasePrompt.length +
  measuredHistoryLength <= fitPrompt.length` (the measured term plus the base
  is bounded above by the full prompt, which additionally carries the summary
  policy) and `resolveMaxDiffChars` is monotonically non-increasing in
  `nonDiffChars` (before clamping, and clamping preserves the order), so the
  packed cap cannot come out below the fit cap. Phase 1 tests the
  monotonicity step and the bound construction
  (`vpr test tests/core/diff-filter.test.ts -t "shard"`); Phase 2 asserts the
  full inequality on a fixture with real prompts (built via the shared
  builder on both sides; `vpr test tests/ci/review.test.ts`), with a Phase 3
  re-check after the `submit_shard` field-rule block lands. A permanent comment records that
  this invariant PLUS the shard-1 reservation (shard 1 = legacy-kept set,
  which totals at most `fitCap` and therefore always fits one `shardCap`
  shard) is what makes the acceptance claim ("never fewer") true: the
  invariant alone only bounds sizes, the reservation turns the bound into a
  superset guarantee.
- [ ] `export const MAX_SHARDS = 5` lives in `src/core/diff-filter.ts`
  (defined once, beside the packing code that enforces it, with a permanent
  comment recording the cost rationale: 5 concurrent agents bound wall time
  to ~1 shard latency and tokens to ~5× single-pass; revisit on evidence).
  `planReview` reads it directly instead of taking a count parameter, so the
  cutoff cannot drift between planner and merger. Phase 2 references the
  constant; it does not redefine the policy.
- [ ] Pack with stable original indices; never splits a file. Shard 1 is the
  legacy-kept set: the exact `filterDiff` skip-and-continue selection under
  `fitCap`, in diff order. It totals at most `fitCap <= shardCap` (by the
  invariant above), so it always fits in one shard — the sharded path reviews
  a superset of today's kept files by construction, and at least as many
  files (pinned by the set- and count-repro regression tests in
  `describe("shard")`). Remaining sections pack greedily in diff order into
  shards 2..`MAX_SHARDS` (when the legacy set is empty there is no shard 1 and
  the remainder fills up to `MAX_SHARDS` shards: same code path, more capacity,
  no regression); the `MAX_SHARDS` cutoff drops the diff-order tail
  beyond the last shard as `shard_limit`. Shard 1 is therefore not necessarily
  a contiguous diff-order slice — stated so nobody "fixes" it back to strict
  contiguity and reintroduces the subset violation.
- [ ] Single section larger than the cap is **skipped with
  `reason: "oversize"`**; the logged `cap` for this reason is the file's own
  section size (the number that actually exceeded the budget), not any shard's
  packing cap. Zero
  reviewable sections with a *non-empty* candidate set returns
  `{ kind: "unreviewable" }` (tested via the discriminator, never message
  text) and the caller maps it to the coded hard error "no reviewable
  sections: every file exceeds the shard budget" — wording distinct from the
  all-shards-failed error below. An *empty* candidate set (empty diff, or a
  diff whose every section was noise-excluded — e.g. Renovate lockfile PRs)
  is NOT unreviewable: it returns `{ kind: "single", diff: "", warning:
  <noise warning>, skipped: [] }` and flows through the normal path to a
  `"none"` decision, exactly as today (`allowEmptyDiff` is passed at
  `review.ts:758`; the empty-diff `"none"` path lives in `output.ts:1600–
  1640`). Test (`vpr test tests/core/diff-filter.test.ts -t "shard"`):
  empty diff and all-noise diff take the single path;
  oversize-only diff takes `unreviewable`.
- [ ] Size signals derived from raw section text only (section char length;
  hunk `+`/`-` line counts excluding `+++`/`---` headers and `@@` markers;
  sections with no hunks (binary/rename) contribute zero, so top-5 logging
  never mis-ranks them; one test case pins each rule). Used for
  `review.diff.budget` totals/top-5 logging only. `extractDiffFiles`/
  `stripNoiseFiles` remain the single source of truth for the file set.
- [ ] `diff-filter.ts` returns structure only; shard header prompt text lives
  in `prompts.ts`/`prompt-builder.ts` (one source of truth). Header is
  `Shard i/N — review ONLY these files` + file count + skipped note.
- [ ] Full-filename log lines bounded (same 50-entry cap family as notices).
- [ ] New unit tests pass: `vpr test tests/core/diff-filter.test.ts`
  (new `describe("shard", …)` titles contain "shard" so `-t "shard"` is
  non-vacuous: diff-order packing, never-split, oversize-skipped,
  unreviewable discriminator, determinism, `planReview` union, reason union,
  monotonicity).
- [ ] Existing tests still pass: `vpr test`.

### Phase 2 — Fan out sharded child processes with deterministic merge

**Goal:** Oversize diffs fan out to N child-process shard runs (one OS
process each); parent collects envelopes and merges findings (findings only;
overview arrives in Phase 3).

- [ ] `review()` order: resolve raw diff → reuse `stripNoiseFiles` sections
  → build `fitPrompt` + `shardBasePrompt`, compute `fitCap`/`shardCap` →
  `planReview` → **select** the path's prompt (construction already done) →
  LSP root/probe (shared, read-only, once — independent of child processes,
  confirmed against `:775–893`) → fan out N child processes (or none:
  terminal/file and `summaryOnly` take the legacy `filterDiff` branch instead
  and never reach `planReview`). No session is created in the parent before the barrier on the
  sharded path (the synth's own post-barrier session is the only in-parent
  exception); each child builds its own exactly as `review()` does today.
  Fit path behaviour
  unchanged (one `Agent` run, unchanged prompt strings — proven by the
  golden-prompt test below; new cases are appended to
  `tests/ci/review.test.ts` (`vi.mock` factories for `diff-resolver.js` /
  `review-tool.js` returning the new exports) and `tests/core/output.test.ts`
  (notice tests: new sharded-arm cases appended; nine legacy literals gain the
  `kind: "budget"` tag-only edit per the Shared section)).
- [ ] Golden-prompt test created HERE (first phase to touch shared prompt
  code): `vpr test tests/ci/review.test.ts -t "golden"` with a fixture
  payload; compares the assembled `effectiveSystemPrompt` string, the
  `buildUserPrompt` output, and the count of `Agent` constructions/runs.
  Fit path must be byte-identical; Phase 3 keeps this test green without
  owning it.
- [ ] Shard runner: new `src/ci/shard-runner.ts` owns the review side of the
  process boundary — `runShardReview()` (moved verbatim out of `review()`, so
  the fit path and the child share one implementation; the child entrypoint
  `src/ci/shard-run.ts` is a thin wrapper that parses args, builds the
  runtime, calls it, converts verdicts, and writes the envelope). The
  parent-side spawn/collect/kill/barrier lives in new `src/ci/shard-fanout.ts`
  (leaf module: node builtins + diff-filter + shard-protocol only, no
  `review.js` import — which is what lets parent-side tests mock the spawn
  boundary with a plain sync `vi.mock` factory instead of
  `importOriginal`-through-a-cycle), with injectable spawn function, injectable
  clock, AND injectable env (explicit non-env credentials are forwarded;
  values never logged). Protocol tests
  (`vpr test tests/ci/shard-runner.test.ts`, new file, importing from
  `shard-fanout.js`) use a stub child (`node -e`, no model):
  spawn/collect/kill, invalid-JSON envelope → `shard_failed`, non-zero exit
  with no envelope → `shard_failed`, barrier cut with a stubbed clock
  (abandoned group actually killed — spawn a grandchild in the stub and
  assert no descendants survive `kill(-pid)`). Deferred MCP veto is a
  parent-side test (`vpr test tests/ci/review.test.ts` with stubbed children:
  shard 2 reports a required MCP failure → parent refuses to post,
  `review.mcp.failed` carries shard 2's attribution). There is no
  per-shard timeout knob: the
  single barrier deadline plus the SIGTERM → SIGKILL grace below are the only
  time bounds.
- [ ] Parent logs the plan before fan-out (`vpr test tests/ci/review.test.ts`):
  `review.diff.budget` per shard (cap, reviewed chars, headroom),
  `review.diff.sharded` with file counts, and the `review.diff.shard.oversize`
  warning naming each oversize-dropped file. The child never logs plan-level
  decisions (a child only sees its own shard); all budget accounting lives in
  the parent where the cap was computed.
- [ ] Merge/failure matrix (`vpr test tests/ci/review.test.ts`) with fixtures: no-session shard child
  runs the plain-`Agent` branch; stray comment dropped +
  `review.shard.stray` counts; same-`comment_id` updates resolve
  least-resolved with `review.shard.update_conflict`; one failed shard →
  `shard_failed`, files excluded from `buildCoverageLine`, run still posts.
- [ ] Shard user prompt builder: `buildShardUserPrompt(shard: DiffShard, skipped: SkippedFile[], index: number, total: number)`
  in `src/core/prompt-builder.ts` = header + shard diff + global skipped
  disclaimer (so the model knows files were withheld and never claims
  completeness). Covered by `vpr test tests/core/prompt-builder.test.ts`
  (header fields + skip note).
- [ ] Tool-section parameterization (parameterize tool-name/field-rule block
  for `submit_review` without history and without `<pr_summary_policy>`)
  lands **in this phase** so Phase 2 compiles and ships alone; Phase 3 adds
  only the `submit_shard` variant. "Without history" scopes the measurement
  base only (`shardBasePrompt` per the cap-arithmetic bullet): the per-shard
  prompt keeps the re-raise rule verbatim whenever its file-filtered history
  includes resolved findings (the rule is conditional on `resolvedFindings`,
  `prompt-builder.ts:146-150`; re-raises without the three fields are dropped
  at `sendOutput`, `output.ts:329+`). Shard runs are child processes, never
  in-process agents: the parent spawns at most `MAX_SHARDS` children and
  collects envelopes in index order; there is no shared transcript, no shared
  closure, no baseline to restore, and no `reset()` semantics anywhere.
  Each child builds its own session exactly as `review()` does today
  (own `agentDir`, own MCP adapter, own LSP set, own `session.dispose()`)
  when `needsExtensionSession`, else runs the existing plain-`Agent` branch
  — all inside its own OS process, so `PI_AGENT_DIR`, `MCP_OUTPUT_GUARD`,
  and every tool registry are process-private by construction. No-session
  path needs no new code: the child runs the same branch the fit path runs
  today. `forceSubmit` composition and submit-nudge retry counted per shard;
  "a retried shard counts once" means once toward
  `review.diff.sharded.runs`. Real invariant assertion
  lives here:
  `shardBasePrompt.length + measuredHistoryLength <= fitPrompt.length` ⇒
  `shardCap >= fitCap` (with the permanent comment from Phase 1; the bare-base
  comparison alone would be insufficient since it ignores history).
- [ ] Shard runner entrypoint `src/ci/shard-run.ts` (new file): reads one
  `ShardRequest` JSON file, runs the shard review by calling an extracted
  `runShardReview()` (refactored out of `review()` with NO behavior change on
  the fit path — the golden test covers the extraction; the boundary is:
  prompt assembly, plan, merge, and `sendOutput` stay in the parent, everything
  from session/extension setup through the agent loop and decision capture
  moves into `runShardReview`), writes one
  `ShardEnvelope` JSON to the output path with an atomic tmp+rename.
  `runShardReview` never calls `createCodeExecTools` regardless of env
  (`PI_REVIEWER_CODE_EXEC`) or target: the child inherits the step env and
  today's assembly (`review.ts:1004-1019`) would otherwise register `code_exec`
  for comment runs, so the verbatim extract must explicitly skip it (permanent
  comment: parallel shards must not mutate the shared tree). Its
  `review.tools.status` reports `code_exec` unavailable. The child
  inherits the parent's stdio (never piped, never captured): logs flow to the
  CI log interleaved like any other concurrent output, and the envelope file
  is the sole parent-child data channel, so child stdout content can never
  corrupt the protocol and no pipe can deadlock, by construction rather than
  by log-routing discipline (no `log.ts` changes required). Exits 0 when a decision was captured
  (including `"none"`) and
  non-zero on infra failure. Child invocation reuses the live runtime:
  `[process.execPath, ...process.execArgv, <shard-run.ts>, <inputPath>,
  <outputPath>]` — NOT `[argv[0], argv[1], ...]`: under tsx, `argv[1]` is the
  *parent script* (re-running it would re-run the whole review) and the loader
  lives in `execArgv` (`--require preflight + --import loader`), so dropping
  it breaks `.js`-specifier imports with `ERR_MODULE_NOT_FOUND` (both failure
  modes verified by direct probe; permanent comment citing them so nobody
  "simplifies" this back). No worktree or env mutation beyond what `review()`
  does today.
- [ ] Citation offsets: the search client accepts an optional `startAt`
  (the next citation id; default 1 preserves today's behavior, keeping
  `tests/ci/search.test.ts:353-357` (`web:1`, `web:2`) green and defining
  shard 0's range). One exported constant `CITATION_STRIDE = 10_000` lives
  next to the search caps and is imported by `review.ts` — no literal `10_000`
  anywhere else. The stride bound is asserted in exactly one place — next to
  the caps (`assert usage < CITATION_STRIDE`, with a comment citing the
  sharding use); the bound covers web + AI-search ids including the AI answer
  id (`client.ts:61, 71, 140-179`) against both limit sets
  (`search/config.ts:57-58` plus the AI-search limits below). The merge
  concatenates evidence snapshots and relies on disjointness by construction
  without re-checking ids (no prose parsing).
  Test (`vpr test tests/ci/search.test.ts`): two seeded clients produce disjoint
  id sets; merged concat keeps every id unique. Any tool found during
  implementation to mint citation ids joins the same mechanism, covered by
  the same test.
- [ ] Shard tool surface: shard agents get the shared base tools **minus
  code-exec** (`read`/`grep`/`find`/`ls` + LSP when enabled + search +
  registry + github-research + submit tool). Code-exec is disabled in shard
  runs by user decision (mutating the working tree under parallel shards is
  racy by construction); it stays enabled in fit-path reviews and in the
  Phase 3 synth. The shard `systemPrompt` likewise omits the
  `<code_exec_policy>` block that `review()` appends to `effectiveSystemPrompt`
  for comment runs today (the shard prompt assembly skips that block rather
  than appending-then-stripping it): telling the model to use a tool it does
  not have burns calls on unknown-tool errors. Test (`vpr test
  tests/ci/review.test.ts`): `code_exec` is absent from the shard tool set
  and present in the fit-path set, and the shard system prompt contains no
  code-exec policy text.
- [ ] LSP stack unchanged (pi-lsp stays): each child runs the existing
  session setup verbatim — same `writeTrustedLspConfig(agentDir)`,
  same `setAgentDir`/`restoreAgentDir` scoping, same probe/pick/roots flow —
  in its own process where that discipline is already correct. No adapter,
  no new dependency, no config-format migration, no trust-store seeding.
  Per-child LSP servers are separate processes on the same workspace
  (accepted 2×N cost on CI runners; correctness needs no sharing).
- [ ] Per-shard history section produced by an extracted `buildHistorySection(...)`
  from `buildJSONSystemPrompt` verbatim (same untrusted-context sentences,
  same `escapePromptMarkup`/`serializePromptRecord` treatment, same
  re-raise field rule); test (`vpr test tests/core/prompt-builder.test.ts`)
  asserts the shard-2 history section contains the
  same safety sentences as the fit path. Every shard built with
  `summaryEnabled: false`. Per-shard history bounded: filter
  `activeFindings`/`resolvedFindings` by shard file set (file-less entries
  kept) within existing limits; `priorSummary` (8k, not file-filterable)
  duplicated per shard and stated as such.
- [ ] Shard prompt (the `submit_review` variant only — removed in Phase 3
  whose tool has no `summary` field; asserted absent by
  `vpr test tests/core/prompt-builder.test.ts`) states `summary` is a one-line
  placeholder
  ("(shard i/N findings above; body composed at merge)") since the merge
  discards it — five shards must not burn output tokens on prose nobody reads.
  The placeholder is non-empty by construction, which is what keeps
  `submit_review`'s non-empty-`summary` validation (`review-tool.ts:169–171`)
  passing (stated so nobody "improves" it into an empty string).
- [ ] `MAX_SHARDS` is the Phase 1 constant (imported, not redefined; no new
  action input and no new env var). It also caps parallel fan-out width.
  One internal brake:
  `const SHARD_FANOUT_TIMEOUT_MS = 20 * 60 * 1000` (one constant, one comment:
  must stay below the consumer job timeout) plus
  `const SHARD_KILL_GRACE_MS = 10_000` (one constant: SIGTERM-to-SIGKILL delay,
  generous enough for LSP shutdown handshakes, short enough to bound the tail);
  `const startedAt = Date.now()` captured right after `planReview`; the
  fan-out barrier races child completions against the timeout. Children are
  spawned detached (`detached: true`) so each forms its own process group;
  abandonment is explicit, not a dropped promise: an unfinished child group
  gets SIGTERM via `kill(-pid)`, then SIGKILL after `SHARD_KILL_GRACE_MS` —
  killing the group, not just the parent, so per-shard LSP servers and MCP
  stdio children cannot outlive the barrier (a bare child-only kill would
  orphan them, and the stub test below would not catch it). Either way the
  abandoned files join `skipped` with reason `shard_limit` (one reason for
  every deadline cut, whether the child exited on its own or had to be
  killed).
  `review.diff.sharded` carries `maxShards`, `runs`, per-shard `cap`, plus an
  `abandoned` count (distinct from `runs`/`failed`). The barrier never
  interrupts `sendOutput` (posting is atomic; the `reviewId:0` rationale lives
  in the code comment beside the constant). Worst case stated in-code and in
  `CI.md`: one shard's worst case including its own retries + synth, with the
  caveat that 5 simultaneous requests share the provider's rate limits and
  per-key caps (the new failure mode parallelism introduces). `CI.md` gains
  the `timeout-minutes` recommendation for consumers. Test with a stubbed
  clock and stub children: shards unfinished at the barrier are killed and
  join `skipped` with reason `"shard_limit"` (`vpr test tests/ci/review.test.ts`, stubbed clock and stub children).
- [ ] Per-shard failure path: a shard that errors or ends without calling its
  submit tool (`submit_review` in Phase 2, `submit_shard` from Phase 3 — this
  bullet covers both phases; the nudge retry happens before abandonment, stated
  so the cost accounting holds) joins `skipped` with `reason: "shard_failed"`;
  its files are never counted as reviewed in `buildCoverageLine`,
  `review.diff.sharded.runs` records the failure, and the collect proceeds. Only
  the all-shards-failed case is a hard error "every shard failed" (never post
  an all-clear; wording distinct from the zero-shard error above).
- [ ] Merge is deterministic with no LLM: concat `comments[]`, dedupe by
  `normalizeFinding({ file, line, side, body })` (within-shard repeats only,
  stated in-code; `sendOutput` dedupes again), concat `finding_updates[]` by
  joining `comment_id` against `activeFindings`; same-`comment_id` conflicts
  (only reachable via file-less findings): least-resolved wins +
  `review.shard.update_conflict` warn. Decision rule, stated once so no
  implementation guesses: any shard with action `"review"` ⇒ merged
  `"review"`; all shards `"none"` ⇒ merged `"none"` (with `pr_summary` /
  `pr_diagram` cleared so a `none` decision never carries overview text).
  The merged decision then flows into the existing `skippedDiff` notice and
  `sendOutput` paths unchanged — including the all-skipped case, which posts
  the notice rather than erroring. Documented tradeoff: file-A finding
  resolved by a file-B change is invisible per-shard. Shard-stray (file in
  another shard) dropped with `review.shard.stray` warn — deliberate
  deviation from the unpositionable-to-body rule, documented in a permanent
  comment at the merge block in `src/ci/review.ts`; absent-from-diff comments
  logged separately as hallucinations. Each envelope carries its own decision;
  the parent merges by index (no shared closure, no shared heap at all) —
  covered by `vpr test tests/ci/review.test.ts`: shards 1 and 3 both reporting
  with both surviving.
- [ ] Interim overview policy (replaced in Phase 3): `submit_review` schema
  still accepts `pr_summary`/`diagram`, so the merge **ignores** any
  shard-emitted overview fields and logs the count via
  `review.shard.overview_dropped`. `sendOutput` receives merged comments +
  the harness-owned deterministic coverage line as `summary` (single producer:
  exported `buildCoverageLine` in `src/core/output.ts` — placed there because
  `output.ts` already owns posting/coverage notices while `prompts.ts` owns
  prompt literals; the function is a one-line template, not prompt policy —
  `Reviewed N files across M shards; K skipped (reasons) …`; Phase 3 asserts
  byte-identical output for the same input. `buildCoverageLine` is the
  sharded-path producer only — it never runs on the fit path, where `sendOutput`
  keeps posting the model's own `summary` (asserted by
  `vpr test tests/ci/review.test.ts -t "fit-vs-sharded"`: the same diff under
  vs over the cap produces model summary vs coverage line).
- [ ] `sendOutput` `diff` = concatenation of the **reviewed raw file
  sections** (never shard user prompts; `parseDiffPositions` is a per-file
  map so packing order is safe); `vpr test tests/ci/review.test.ts` asserts
  a shard-3 comment posts inline.
- [ ] `skippedDiff` discriminated union per Shared section (`kind: "budget"`
  legacy arm: same two `filterDiff` call sites, same wording, plus the
  `kind` tag per above; `kind: "sharded"` constructed in `review.ts`); three
  per-reason message variants on the sharded arm; `MAX_LISTED_SKIPPED_FILES`
  caps each. The four length gates in `output.ts` (`1225`, `1458`, `1610`,
  `1766`) branch on `kind` (budget arm: today's truthiness/length check
  verbatim; sharded arm: files length) — named here so the renderer change
  is not made alone.
- [ ] No shared mutable state (child processes make this structural, not
  disciplinary): the only things crossing the boundary are the `ShardRequest`
  file in and the `ShardEnvelope` file out. Consequences, each with a test
  (`vpr test tests/ci/review.test.ts` unless noted):
  `MCP_OUTPUT_GUARD`/`MCP_UI_DEBUG` are set inside each child as today (no
  parent-level save/restore dance — separate processes cannot race); every
  per-call map the in-process design shared (`mcpToolCalls`,
  `mcpToolCallArgs`, `registeredMcpTools`/`registeredLspTools`,
  `mcpOutputArtifacts`, `failedMcpCalls`) lives and dies inside its child,
  except that per-shard MCP failures ride home as computed verdicts
  (`{ identity, signal, repoIds, unindexed }` — computed in the child, never
  the raw result text: the untrusted tool-result excerpt that
  `isUnindexedRejection` matches on stays in-memory-only per the existing
  never-log-it rule) so the parent can still apply the whole-run veto with
  shard attribution in `review.mcp.failed` (fail-closed preserved, no
  pre-veto retry; a child never throws the veto itself — that would turn one
  shard's MCP failure into a dropped review instead of a vetoed one).
  citations stay globally unique by construction: the parent assigns
  `citationOffset = index × CITATION_STRIDE` and each child seeds its search
  client with it (per the single stride assertion next to the search config
  caps);
  the parent concatenates evidence snapshots (ids disjoint by construction,
  no prose parsing, no merge-time re-check). A shard whose *required* search
  fails is failed (`shard_failed`) — the run continues; there is no
  parent-side `hasRequiredFailure` check. Fan-out MCP cost stated in-code
  and in `CI.md`: N adapter instances × M configured servers spawned
  concurrently (auth/rate limits, memory); no width cap for V1 beyond
  `MAX_SHARDS` — documented, revisit on evidence. Thinking trace per shard:
  single channel — `request.tracing` only. Before session setup the child
  assigns `process.env.PI_REVIEWER_THINKING_ARTIFACT` from
  `request.tracing.artifactPath` (deletes the var when `tracing` is null, so
  no parent env leaks in), then writes through the existing mechanism
  unchanged, gated by the passed `debug` exactly as today (`review.ts:1426,
  1445`). The parent never sets the var in the child env directly (one writer,
  in the child). `action.yml`'s upload glob widens from the single file to
  `pi-reviewer-thinking*.jsonl` — without the glob change 5 of 6 traces would
  silently never upload. (`0o600` as today.)
- [ ] `dryRun` always prints the shard plan (index, file count, chars);
  full per-shard prompts flow through the existing dry-run `logger.info`
  calls (which land in the thinking-trace file when `debug` is on via
  `PI_REVIEWER_THINKING_ARTIFACT`, else the normal log sink) — no new
  gating, no `--debug` flag exists.
- [ ] `summaryOnly` stated honestly: single-pass cap-filtered diff (its
  retained `filterDiff` branch) with scattered sections dropped; potentially
  worse than the sharded incremental reviews it replaces; covered by
  `vpr test tests/ci/summary-command.test.ts`. Its `"budget"` wording now appears only
  in the summary-regeneration log, never in a posted body — stated so nobody
  "restores" it into the notice. Add one assertion (`vpr test
  tests/ci/review.test.ts`): a terminal-target oversize diff takes the legacy
  `filterDiff` branch (pins the comment-target-only scope boundary).
- [ ] Mocks updated: `tests/ci/review.test.ts` `vi.mock` factories for
  `diff-resolver.js` + `review-tool.js` return the new exports; the new
  `shard-protocol` module exports types and validation only (imported
  directly, never mocked); `tests/ci/review.test.ts` mocks
  `shard-fanout.js` (injectable spawn/env) so the parent-side merge/failure
  paths are deterministic without spawning real children, while
  `shard-runner.js` (`runShardReview`) runs REAL in fit tests — that is what
  makes the golden-prompt/one-`Agent`-run test meaningful instead of
  vacuous. (`shard-tool.js`
  is mocked only in Phase 3, where the module exists — a `vi.mock` of a
  nonexistent module fails, so Phase 2 must not reference it.)
- [ ] Docs: `CI.md:191` (whole-section-drop → sharding + fixed 5 + deadline
  rule + `timeout-minutes` recommendation), `docs/local.md:145` (shard
  predicate; local `resolveDiff` still skips), `action.yml:44` untouched (no
  new inputs), `CI.md` operator paragraph for `review.diff.sharded`, plus an
  explicit operator note that `code_exec` is disabled in shard runs (oversize
  PRs lose code-level verification; it stays on in fit-path reviews).
- [ ] Existing tests still pass: `vpr test`.

### Phase 3 — Structured reduce with tools (no prose parsing)

**Goal:** Shards emit compressed internals; one synth writes the overview.

- [ ] `src/core/shard-tool.ts` hosts `submit_shard` + `submit_overview`
  (and deletes the Phase 2 `review.shard.overview_dropped` counter, which has
  no producer once `submit_shard` has no overview fields):
  `digest: DigestEntry[]` backfilled on missing files as
  `{ file, what: "(no digest)", risks: [] }` with
  `review.shard.digest_incomplete` warn (never a full re-run); digest entries
  naming files outside the shard ignored + counted (not validation failures);
  `what ≤120 chars`, `risks[] ≤5/file` via schema `maxLength`
  (reject-and-retry); `finding_updates[]` reuses the identical schema object
  as the `review-tool.ts` finding-updates field (export the const from
  `review-tool.ts` and import it in `shard-tool.ts` so there is one object,
  not two copies; ID-membership validation stays at `sendOutput` via
  `normalizeReviewResult` like today, not duplicated in the shard tool; the
  Phase 2 merge rule continues unchanged, so sharded incremental batches keep
  reconciling active findings); `findings[]` =
  today's fields, no additions (per the cut-down shape: no `confidence`,
  `symbol`, `impacts`, or `needs_check` — their only consumers were the
  deleted gate/investigator); no `summary`/`pr_summary`/`pr_diagram`.
- [ ] Prompt builder adds only the `submit_shard` variant (Phase 2 shipped the
  parameterized `submit_review` one). `vpr test tests/core/prompt-builder.test.ts`
  covers both, including the header assertions (index/total, "review ONLY
  these files", file count, skipped note) and the shard-2 safety-sentence
  test from Phase 2. `vpr test tests/core/tool-schemas.test.ts` lists `submit_shard` +
  `submit_overview`. Re-check
  the `shardCap >= fitCap` invariant after the field-rule swap (the shard
  prompt grows here); if the swap breaks it, shrink the shard field-rule
  block until the inequality holds again — never paper over it with a
  `max(fitCap, …)` clamp, which would silently over-allocate context the
  model does not have.
- [ ] `submit_overview` keeps the harness-never-parses-prose invariant
  (tool, not text): input = merged findings (each supplied with its stable
  identity key) + all `digest[]` + title/body + file inventory (no diffs,
  shard outputs escaped via `escapePromptMarkup`); the synth agent runs with
  verification tools only — read-only tools + LSP when enabled + `code_exec` +
  `submit_overview` (no search/registry/MCP; code-exec is off in shard runs
  and on here, per the decided split: the synth may verify a claim by
  reading code or running a bounded command, never re-review the diff).
  Output = the only publishable prose
  (`pr_summary ≤2000`, `pr_diagram ≤1500`, both optional — an empty result
  means "no overview block", no retry). `Why` inferred once here. Prompt
  reuses `PR_TITLE_LIMIT`/`PR_BODY_LIMIT` and the `serializePromptRecord` +
  slice pattern. The synth runs in-process after the barrier (no shards running,
  so no child process needed) in its own extension session created when
  `lspEnabled` (own `agentDir`, own LSP set, disposed in a
  `finally`; constructed like the fit-path agent with `initialState`
  carrying `systemPrompt`/`model`/`thinkingLevel` plus the `AgentOptions`
  siblings `streamFn` and `getApiKey`, at the review's `thinkingLevel`);
  `code_exec` is safe there because no shard runs concurrently.
  The *absence* of `submit_review` from the synth's tool list is what
  enforces "never re-review the diff", not the prompt sentence.
- [ ] One mapper `ShardFinding → ReviewComment` runs at merge time and
  constructs the posted object field-by-field (`unknown`+narrowing at the
  untrusted tool boundary, no `as ReviewResult["comments"]` cast), asserts
  `isReviewComment` + `hasAiFixProse`.
- [ ] `ReviewResult.summary` has one producer for all three sharded cases (first /
  non-first / summary-disabled): the exported `buildCoverageLine` in
  `src/core/output.ts` from Phase 2 (the fit path keeps the model's own
  summary per Phase 2; this bullet scopes the sharded path only). Harness reduce gate:
  `summaryEnabled && isFirstReview`; the model decides warranted-vs-omitted
  via the optional `pr_summary`/`pr_diagram` fields (omitted → no block, no
  wasted footer). Reduce failure degrades to Phase 2 behavior (findings +
  coverage line) with `review.shard.reduce.failed` warn, never
  throw-and-post-nothing.
- [ ] Retry surface parameterized alongside the tool swap (same phase, or every
  shard retry degrades to failure): `SUBMIT_NUDGE` text and the
  `FORCED_SUBMIT_TOOL` constant (`review.ts:126–141`) gain shard variants
  naming `submit_shard` with its own action vocabulary (exposed from
  `createShardTool()` as its own nudge/forced-tool pair, keeping the
  `FORCED_SUBMIT_TOOL` provider-variance rationale from `review.ts:129–137`
  intact for the shard variant). Test
  (`vpr test tests/ci/review.test.ts`): a shard retry pins `submit_shard`
  (not `submit_review`), and the nudge names the tool the shard run actually
  has.
- [ ] Tests (all observable): `vpr test tests/core/shard-tool.test.ts`
  (schema caps, named `DigestEntry` referenced — not inline literals, digest
  backfill + extra-file ignore counts, mapper validation — all against the
  real module, never mocked),
  `vpr test tests/core/prompt-builder.test.ts`,
  `vpr test tests/core/tool-schemas.test.ts`,
  `vpr test tests/core/output.test.ts`,
  `vpr test tests/ci/review.test.ts` (synth agent tool set is exactly
  read-only + LSP-when-enabled + `code_exec` + `submit_overview`; `code_exec`
  absent from the shard set). Phase 2 + Phase 3 assert
  byte-identical coverage lines for the same input (`vpr test
  tests/ci/review.test.ts -t "coverage-line"`).
- [ ] Docs: `CI.md` sharding paragraph extended (harness gate, coverage-line
  summary, synth verification tool set: read-only + LSP when enabled +
  `code_exec` + `submit_overview`, no search/registry/MCP — and that the
  synth cannot file findings). Existing tests still pass: `vpr test`.

## Open Questions

No phase is blocked. Remaining confirmations at sign-off: `MAX_SHARDS = 5`
fixed (also caps parallel fan-out width), the barrier-form `SHARD_FANOUT_TIMEOUT_MS`
+ `shard_limit` reuse accepted, child-process-per-shard with full tool parity
minus `code_exec` accepted, code-exec on in fit-path + synth accepted.

## Acceptance Criteria

- [ ] All phase action items are checked.
- [ ] It has been audited by a reviewer for correctness and completion, and iteratively refactored until convergence.
- [ ] Fit-path behaviour unchanged, proven by the golden-prompt/one-`Agent`-run
  test (`vpr test tests/ci/review.test.ts -t "golden"`); new cases are appended to
  `tests/ci/review.test.ts` (mock factories; run `vpr test tests/ci/review.test.ts`),
  `tests/core/output.test.ts` (new sharded-arm notice tests appended plus the nine-literal `kind: "budget"` tag-only edit; run `vpr test tests/core/output.test.ts`),
  and `tests/core/diff-filter.test.ts` (`describe("shard")`; run
  `vpr test tests/core/diff-filter.test.ts -t "shard"`),
  plus the new `shard-tool`/`prompt-builder`/`tool-schemas` coverage listed per
  phase.
- [ ] `vpr build` (tsc) and `vpr lint` pass.
- [ ] Oversize diffs never review fewer files than the old scatter-skip path,
  and strictly more whenever any non-oversize section lies beyond the first
  cap (by the `shardCap >= fitCap` invariant; the unreviewable baseline is
  zero files, so "never fewer" holds there by construction); the unreviewable
  hard error is an accepted behavior change; the ~5× token ceiling is
  user-visible and documented, while wall time is ≈ one shard's worst case
  including its own retries + synth (parallel fan-out), not the old
  sequential estimate.
- [ ] User-visible change accepted: sharded reviews post the mechanical
  `buildCoverageLine` body (model prose lives only in `pr_summary`); `CI.md`
  documents it; shard prompts burn no tokens on discarded summaries.
  Terminal/file targets are out of scope here by design — local oversize
  reviews keep the legacy scatter-skip (`docs/local.md` says so).
- [ ] Code follows repo conventions: `vpr` (not `vp`), no `any`, union-keyed
  Records, `unknown`+narrowing at untrusted boundaries, permanent
  rationale comments.
