# CI Agent

Runs on PR lifecycle events via GitHub Actions. Each invocation reviews one accumulated commit batch and stores its authenticated batch marker in the GitHub review.

## Setup

Run once in your project root:

```bash
pnpx github:esafak/pi-reviewer init
```

This generates `.github/workflows/pi-review.yml`:

```yaml
name: Pi Reviewer

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]
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
    if: github.event_name != 'pull_request_review_comment' || github.event.comment.user.type != 'Bot'
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
      - uses: esafak/pi-reviewer@main
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

Commit it to your default branch, then provide the API key for your selected provider in the action environment. For `openai/...`, `anthropic/...`, and `zai/...` models, use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`, respectively. Other providers can use `PI_API_KEY` (or the explicit `pi-api-key` input). When more than one is available, the explicit `pi-api-key` input takes precedence, followed by the selected provider's variable, then `PI_API_KEY`.

## Repository self-review

This repository's workflow uses the `review` environment and the required
repository variable `MODEL_NAME` to select the provider. Add the matching
provider secret to the `review` environment:

| `MODEL_NAME` prefix | Secret |
|---|---|
| `openai/` | `OPENAI_API_KEY` |
| `anthropic/` | `ANTHROPIC_API_KEY` |
| `zai/` | `ZAI_API_KEY` |

The workflow rejects unsupported providers and missing matching secrets
without printing key material. It deliberately defaults all workflow runs to
`warn`; the action's standalone default remains `info`.

## Usage

Replies to Pi Reviewer findings use a strict assistant action: low-information acknowledgements, thanks, agreement, and completion notices receive one GitHub review-comment reaction; substantive questions, requests, disagreements, uncertainty, and technical information receive a concise root-targeted reply. Review-comment reactions are authorized by `pull-requests: write`; pull-request no-findings reactions are authorized by `issues: write`. There is no separate `reactions: write` GitHub Actions permission. Reactions are deduplicated by GitHub per comment, user, and reaction content; replies use an authenticated marker. If a no-findings reaction fails, the action warns and posts the normal no-findings comment; if a review-comment reaction fails, the action warns and skips that acknowledgement, so a reaction failure never discards the review.

Every eligible PR event produces at most one review for the range since the last successful marker. A human reply from an OWNER, MEMBER, or COLLABORATOR to a Pi Reviewer inline finding receives the reaction or concise response selected by the assistant; threads rooted at human comments, bot-authored comments, status replies, or resolved threads are ignored. GitHub review-comment replies are root-targeted because GitHub exposes review threads as flat REST replies, so each authorized human message in an active finding thread can receive at most one response. Existing agent findings are reconciled in their original threads; human-authored threads are never changed. `/pi-review` is restricted to authorized internal PR commenters. Fork PRs are skipped. Replies are skipped if the PR head changes before processing, or if the PR is a draft while `review-drafts` is disabled.

The marker is authenticated with the identity returned by `GET /user` and contains the reviewed `fromSha`, `toSha`, event kind, and review ID. It is the durable state for batching—not an LLM session, transcript replay, Actions cache, or provider cache. If several pushes arrive while a runner is pending, the next run recomputes the complete range from the latest marker.

New findings are posted only for the current batch. Existing findings are returned as `finding_updates`: fully resolved findings receive one marked reply and are then resolved, partial findings receive one explanatory reply and remain open, and unchanged findings receive no reply. If a reply succeeds but resolution fails, the resolution remains independently retryable. Findings that cannot be positioned are kept in the review body with hidden, authenticated `body-finding:v1` markers and stable positive IDs; their lifecycle is reconciled by updating only the originating review body, preserving its visible text. The last-resort issue-comment fallback is intentionally not adopted as durable finding state, because issue comments do not have review-body lifecycle semantics. Lifecycle replies say `Resolved by <7-character SHA>` or `Partially addressed by <7-character SHA>`; conversational replies omit the SHA unless the user asks for it. Reply markers are authenticated by the posting bot and checked again immediately before posting. The per-PR concurrency group limits races, but check/POST is necessarily best-effort rather than atomic; a thread resolved during generation may still receive a response if resolution is not observed by the final check.

Draft pull requests are skipped by default, including manual dispatch and `/pi-review`. Set `review-drafts: true` to review draft lifecycle events. When a draft becomes ready, the accumulated range is reviewed once. Manual dispatch accepts a PR number and optional ancestor target head; the target must belong to the current PR history.

## Inputs

| Input | Required | Description |
|---|---|---|
| `github-token` | yes | GitHub token to post PR comments |
| `pi-api-key` | no | Optional explicit API key for the model's provider. When omitted, the action uses the provider-specific environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`). |
| `model` | yes | Model to use in `provider/modelId` format (e.g. `openrouter/openai/gpt-5.4-mini`) |
| `thinking` | no | Thinking budget: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `off`) |
| `min-severity` | no | Minimum severity: `info`, `warn`, or `critical` (default: `info`) |
| `react-on-no-findings` | no | Leave a thumbs-up reaction on the PR instead of posting a comment when no new findings remain and all existing findings are resolved (default: `true`) |
| `doc-dirs` | no | Comma-separated dirs to scan for docs to inject into the review (default: empty — inject nothing) |
| `review-drafts` | no | Review draft PRs (default: `false`) |
| `setup-node` | no | Set up Node 24 via `actions/setup-node` when a compatible Node is not already on `PATH` (default: `true`). Set to `false` to require the runner image to provide Node 24 or newer. |
| `cache` | no | Cache the pnpm store across runs (default: `true`). Disable on runners where the cache service is unavailable or unwanted. |

The action runs on Node 24 or newer (LTS when installed by the action). Before setup, it independently reuses compatible `node`, `pnpm`, and `vp` executables already on `PATH`; any subset can be preinstalled, and only missing or incompatible tools are installed. Node must be >=24, pnpm must match `package.json`, and Vite+ may match or be newer than the stable minimum version in `pnpm-workspace.yaml` (a prerelease of that minimum does not qualify). When Vite+ must be installed, its temporary executable files and installation are placed under a private, executable directory in the runner user's home directory and removed after the action; users do not need to set `TMPDIR`. Dependencies are installed with pnpm delegated through `vp install`. The self-review workflow prewarms Vite+ with a pinned `setup-vp` step, whose cache is keyed from the repository checkout. The action itself separately caches its pnpm store with `actions/cache`, keyed on a hash of `pnpm-lock.yaml`, so warm runs skip the download. Both cache paths are optional performance optimizations: cache failures degrade to uncached setup/install rather than aborting the review. Runners without a compatible preinstalled toolchain need network access to `viteplus.dev` for the Vite+ CLI installer in addition to the package registry.

## Doc context

The reviewer can pull relevant project documentation into the review prompt based on which files changed in the diff. It is **opt-in** in CI: nothing is injected unless you set `doc-dirs`.

```yaml
      - uses: esafak/pi-reviewer@main
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

1. Go to `github.com/settings/apps/new`, set **Pull requests** and **Issues** permissions to **Write**, and disable the webhook
2. Install the app on your repository
3. Generate a **private key** and note the **App ID**
4. Add `PI_REVIEWER_APP_ID` and `PI_REVIEWER_PK` to your repo secrets

Then update your workflow:

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
    id: bot-token
    with:
      app-id: ${{ secrets.PI_REVIEWER_APP_ID }}
      private-key: ${{ secrets.PI_REVIEWER_PK }}
      permission-pull-requests: write
      permission-issues: write

  - uses: esafak/pi-reviewer@main
    with:
      github-token: ${{ steps.bot-token.outputs.token }}
      pi-api-key: ${{ secrets.PI_API_KEY }}
      model: openrouter/openai/gpt-5.4-mini
      min-severity: ${{ inputs.min-severity || 'info' }}
```
