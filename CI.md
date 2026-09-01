# CI Agent

Runs on PR lifecycle events via GitHub Actions. Each invocation reviews one accumulated commit batch and stores its authenticated batch marker in the GitHub review.

## Setup

Run once in your project root:

```bash
npx github:zeflq/pi-reviewer init
```

This generates `.github/workflows/pi-review.yml`:

```yaml
name: Pi Reviewer

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      min-severity:
        description: 'Minimum severity to report (info, warn, critical)'
        required: false
        default: 'info'
        type: choice
        options:
          - info
          - warn
          - critical

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write # Required when react-on-no-findings is enabled.
    concurrency:
      group: pi-reviewer-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr-number || github.run_id }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - name: Fetch PR refs for comment and manual events
        shell: bash
        run: git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*' --no-tags
      - uses: zeflq/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          model: openrouter/openai/gpt-5.4-mini
          thinking: off
          review-drafts: false
          react-on-no-findings: true
          min-severity: ${{ inputs.min-severity || 'info' }}
          # Optional workflow_dispatch inputs:
          # pr-number: 123
          # target-head: <ancestor SHA>
          # Opt in to injecting matching project docs into the review.
          # Comma-separated dirs scanned for .md files with a 'description' frontmatter.
          # doc-dirs: '.pi/notes,docs/review'
```

Commit it to your default branch, then add your API key to your repo secrets:
- `PI_API_KEY` — the API key **for the provider in `model`**. The action forwards this key to that model's endpoint, so it must match the provider. For `openrouter/...` use an OpenRouter key (`sk-or-...`); for `anthropic/...` an Anthropic key; etc.

## Usage

Every eligible PR event produces at most one review for the range since the last successful marker. Existing agent findings are reconciled in their original threads; human-authored threads are never changed. `/pi-review` is restricted to authorized internal PR commenters. Fork PRs are skipped.

The marker is authenticated with the identity returned by `GET /user` and contains the reviewed `fromSha`, `toSha`, event kind, and review ID. It is the durable state for batching—not an LLM session, transcript replay, Actions cache, or provider cache. If several pushes arrive while a runner is pending, the next run recomputes the complete range from the latest marker.

New findings are posted only for the current batch. Existing findings are returned as `finding_updates`: fully resolved findings receive one marked reply and are then resolved, partial findings receive one explanatory reply and remain open, and unchanged findings receive no reply. If a reply succeeds but resolution fails, the resolution remains independently retryable.

Draft pull requests are skipped by default, including manual dispatch and `/pi-review`. Set `review-drafts: true` to review draft lifecycle events. When a draft becomes ready, the accumulated range is reviewed once. Manual dispatch accepts a PR number and optional ancestor target head; the target must belong to the current PR history.

## Inputs

| Input | Required | Description |
|---|---|---|
| `github-token` | yes | GitHub token to post PR comments |
| `pi-api-key` | yes | API key for the model's provider (forwarded to the model endpoint; e.g. an OpenRouter `sk-or-...` key for `openrouter/...` models) |
| `model` | yes | Model to use in `provider/modelId` format (e.g. `openrouter/openai/gpt-5.4-mini`) |
| `thinking` | no | Thinking budget: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `off`) |
| `min-severity` | no | Minimum severity: `info`, `warn`, or `critical` (default: `info`) |
| `react-on-no-findings` | no | Leave a thumbs-up reaction on the PR instead of posting a comment when no new findings remain and all existing findings are resolved (default: `true`) |
| `doc-dirs` | no | Comma-separated dirs to scan for docs to inject into the review (default: empty — inject nothing) |
| `review-drafts` | no | Review draft PRs (default: `false`) |
| `setup-node` | no | Set up Node 24 via `actions/setup-node` when a compatible Node is not already on `PATH` (default: `true`). Set to `false` to require the runner image to provide Node 24 or newer. |
| `cache` | no | Cache the pnpm store across runs (default: `true`). Disable on runners where the cache service is unavailable or unwanted. |

The action runs on Node 24 or newer (LTS when installed by the action). Before setup, it independently reuses compatible `node`, `pnpm`, and `vp` executables already on `PATH`; any subset can be preinstalled, and only missing or incompatible tools are installed. Node must be >=24, pnpm must match `package.json`, and Vite+ may match or be newer than the stable minimum version in `pnpm-workspace.yaml` (a prerelease of that minimum does not qualify). When Vite+ must be installed, its temporary executable files are placed under a private, executable directory in the runner user's home directory; users do not need to set `TMPDIR`. Dependencies are installed with pnpm delegated through `vp install`. The pnpm store is cached by a standalone `actions/cache` step keyed on a hash of `pnpm-lock.yaml`, so warm runs skip the download. The cache step uses `continue-on-error`, so a cache failure degrades to an uncached install rather than aborting the review. Runners without a compatible preinstalled toolchain need network access to `viteplus.dev` for the Vite+ CLI installer in addition to the package registry.

## Doc context

The reviewer can pull relevant project documentation into the review prompt based on which files changed in the diff. It is **opt-in** in CI: nothing is injected unless you set `doc-dirs`.

```yaml
      - uses: zeflq/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          doc-dirs: '.pi/notes,docs/review'
```

For each configured dir, any `.md` file with a `description` frontmatter field is a candidate:

```markdown
---
description: Authentication flows, JWT tokens, session management
---

# Auth Guide

...content injected into the review when auth-related files change...
```

At review time, the action extracts keywords from the changed file paths (e.g. `src/auth/login.ts` → `auth`, `login`), then injects any doc whose `description` or filename matches a keyword. Keep descriptions specific enough to avoid over-matching, but broad enough to cover the files they apply to.

## Bot identity

By default, comments appear under `github-actions[bot]`. To post under a custom bot name, create a GitHub App:

1. Go to `github.com/settings/apps/new`, set **Pull requests** permission to **Write**, disable the webhook
2. Install the app on your repository
3. Generate a **private key** and note the **App ID**
4. Add `BOT_APP_ID` and `BOT_PRIVATE_KEY` to your repo secrets

Then update your workflow:

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: tibdex/github-app-token@v2
    id: bot-token
    with:
      app_id: ${{ secrets.BOT_APP_ID }}
      private_key: ${{ secrets.BOT_PRIVATE_KEY }}

  - uses: zeflq/pi-reviewer@main
    with:
      github-token: ${{ steps.bot-token.outputs.token }}
      pi-api-key: ${{ secrets.PI_API_KEY }}
      model: openrouter/openai/gpt-5.4-mini
      min-severity: ${{ inputs.min-severity || 'info' }}
```
