---
description: Load when working on the GitHub Action entrypoint, workflow bootstrap, or CI review posting.
---

# CI review flow

<bootstrap>
  <rule><requirement>`init()` creates `.github/workflows/pi-review.yml` only when it does not already exist.</requirement><example>Running `pi-reviewer init` twice leaves a custom workflow file untouched on the second run.</example></rule>
  <rule><requirement>The generated workflow triggers on pull requests and manual dispatch with a minimum-severity chooser.</requirement><example>The workflow accepts `info`, `warn`, or `critical` from `workflow_dispatch`.</example></rule>
</bootstrap>

<entrypoint>
  <rule><requirement>`src/ci/action-entry.ts` reads PR metadata from `GITHUB_EVENT_PATH` and aborts when the event is not a pull request.</requirement><example>Missing `pull_request.number` or `pull_request.head.sha` exits with code `1`.</example></rule>
  <rule><requirement>The Action passes PR number, head SHA, GitHub token, repo, and min severity into `review()`.</requirement><example>`MIN_SEVERITY=warn` is normalized to `WARN` before review runs.</example></rule>
</entrypoint>

<posting>
  <rule><requirement>`review()` in CI uses the comment output target, not terminal or file output.</requirement><example>`GITHUB_ACTIONS=true` plus a PR context posts back to GitHub instead of writing `pi-review.md` locally.</example></rule>
  <rule><requirement>The workflow installs dependencies with `vp install --frozen-lockfile` before running the compiled entrypoint.</requirement><example>`action.yml` runs `vp install --frozen-lockfile` in the action workspace, then executes the compiled script.</example></rule>
</posting>

<self-verification>
  <check>The workflow file, action entrypoint, and CI output target are all represented.</check>
  <check>No local extension behavior was mixed into CI guidance.</check>
  <check>Every rule has a concrete example tied to the current repo.</check>
</self-verification>
