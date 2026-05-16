---
description: Load when working on diff resolution, context loading, prompt generation, output formatting, or the review UI server.
---

# Core review pipeline

<pipeline>
  <rule><requirement>`resolveDiff()` chooses the diff source from `--pr`, `--diff`, `--branch`, GitHub Actions, or the detected origin base.</requirement><example>`--pr 42` uses `gh pr diff 42`; `--branch dev` uses `git merge-base dev HEAD`.</example></rule>
  <rule><requirement>Untracked files are temporarily staged so they can appear in branch and diff comparisons.</requirement><example>`git add -N` happens before `git diff`, then files are removed from the index afterward.</example></rule>
  <rule><requirement>`loadContext()` and `loadContextSSH()` walk from git root to cwd and collect one of `AGENTS.md`, `CLAUDE.md`, and `REVIEW.md` per directory level.</requirement><example>A package can inherit root `AGENTS.md` plus package-local `REVIEW.md` in root → cwd order.</example></rule>
</pipeline>

<formatting>
  <rule><requirement>`filterDiff()` drops noise files and truncates whole file sections when the diff exceeds the size cap.</requirement><example>`dist/`, lockfiles, `.d.ts`, and minified files are excluded; skipped files are reported in the warning.</example></rule>
  <rule><requirement>`buildJSONSystemPrompt()` is used for local mode and SSH+UI; `buildMarkdownSystemPrompt()` is used for SSH-only mode.</requirement><example>SSH-only adds the save-to-`pi-review.md` instruction, while JSON mode returns a structured `ReviewResult`.</example></rule>
  <rule><requirement>`sendOutput()` posts inline GitHub review comments first, then falls back to an issue comment, and writes `pi-review.md` for file output.</requirement><example>If inline comments are rejected with 422, the summary is still posted as an issue comment.</example></rule>
</formatting>

<ui-server>
  <rule><requirement>`startUIServer()` serves one local page, keeps the session alive with pings, and resolves a single user action.</requirement><example>The page closes itself after `/action`, or times out to `closed` after the heartbeat window.</example></rule>
</ui-server>

<self-verification>
  <check>Diff selection, context loading, prompt building, and output handling are all covered.</check>
  <check>No extension-only behavior was described as core behavior.</check>
  <check>Each rule includes a concrete example from the current implementation.</check>
</self-verification>
