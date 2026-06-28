---
description: Load when working on the /review extension, command parsing, SSH/local execution, or review handoff logic.
---

# pi-reviewer extension

<command>
  <rule><requirement>`parseArgs()` understands `--diff`, `--branch`, `--pr`, `--dir`, `--ssh`, `--ui`, `--dry-run`, `--verbose`, `--model`, `--thinking`, and `--min-severity`.</requirement><example>`--thinking turbo` is rejected; `--min-severity warn` is normalized to `WARN`.</example></rule>
  <rule><requirement>`resolveCurrentModelId()` prefers an explicit model, then the session model, then the raw string fallback.</requirement><example>`gpt-4o` resolves to `openai/gpt-4o` when the registry knows that model.</example></rule>
</command>

<local-and-ssh>
  <rule><requirement>Local mode resolves the diff, loads context, builds a JSON prompt, spawns `pi --mode json`, and parses the final assistant turn.</requirement><example>`runLocalReview()` writes a temporary system prompt file, then extracts the last non-empty `turn_end` response.</example></rule>
  <rule><requirement>SSH mode lets the agent fetch its own diff and project files over the remote SSH tool bridge.</requirement><example>`buildSSHDiffCommand()` returns `gh pr diff 42` for PR reviews and a merge-base diff for branches.</example></rule>
  <rule><requirement>SSH-only uses the markdown prompt and lets the agent save `pi-review.md`; SSH+UI uses JSON output and captures the diff from `tool_result`.</requirement><example>`runSSHReviewAndWait()` returns a `ReviewResult` with the captured diff for the UI.</example></rule>
</local-and-ssh>

<ui-and-feedback>
  <rule><requirement>`handleUIReview()` opens the browser UI, writes or delegates the saved review, and returns the injection message when findings should be sent back to the agent.</requirement><example>Local UI saves to `pi-review.md`; SSH UI can delegate the save to the remote and later send accepted findings.</example></rule>
  <rule><requirement>`setReviewFooter()` shows a spinner and source label while review work is running.</requirement><example>The footer displays the diff source plus model or thinking metadata.</example></rule>
  <rule><requirement>`createEventAccumulator()` keeps the latest assistant review text and accumulates token usage from JSON events.</requirement><example>It ignores non-JSON lines and tracks API error or thinking-only failures.</example></rule>
</ui-and-feedback>

<self-verification>
  <check>Command parsing, local mode, SSH mode, UI handoff, and footer/event tracking are covered.</check>
  <check>No core API details were duplicated beyond their extension usage.</check>
  <check>Each rule includes a current implementation example.</check>
</self-verification>
