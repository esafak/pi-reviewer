# pi-reviewer

Model-agnostic AI PR reviewer for GitHub Actions. Works with any provider supported by [pi.dev](https://pi.dev/models) — OpenAI, Anthropic, OpenRouter, ZAI, and more.

- **Inline findings** on the diff, sorted by severity (`critical` / `warn` / `info`)
- **PR summary** (What / Why / Risks) on the first review — collapsed, out of the way
- **Dependency breaking-change check**: `mode: dependency` researches the release notes of a PR's upgrades and gates on a `pi-reviewer/breaking-changes` check run
- **Conversational**: reply to a finding and it answers; `/pi-review` and `/pi-summary` on demand
- `AGENTS.md` and project skills (`SKILL.md`) support
- Opt-in MCP servers; best-effort LSP with preinstalled binaries
- (AI) web search support

## Quickstart

Run once in your project root to generate `.github/workflows/pi-review.yml`:

```bash
pnpx github:esafak/pi-reviewer init
```

Set `model` to your pick, add its key as the `PI_API_KEY` repo secret, commit the workflow, and open a PR.

Or you can copy this:

```yaml
name: Pi Reviewer
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - uses: esafak/pi-reviewer@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          model: openai/gpt-6-luna
```

See [CI.md](./CI.md) for API keys by provider, everyday settings, and talking to the bot.

## What you get

- One review per push — only the new commits since the last review are reported.
- Findings land inline on the diff. Unpositionable notes fall back to the review body.
- Zero-findings? A 👍 reaction on the PR instead of noise (only when nothing is open).
- First review carries a collapsed PR summary. Later pushes post findings-only.
- Reply to a finding and it responds once — questions get answers, acks get a reaction.
- Comment `/pi-review` to re-review, `/pi-summary` to refresh the summary.
- Opt in to `code-exec` and it tests before it flags — reproducing the bug with your own test/typecheck commands in a sandbox instead of guessing from the diff.

## Example

This repo reviews itself with pi-reviewer — see it in action on [PR #167](https://github.com/esafak/pi-reviewer/pull/167): inline findings, the collapsed summary, and replies in the threads.

## Also: dependency breaking-change check

`mode: dependency` turns the action into a breaking-change gate for dependency
upgrades: it reads both ends of the changed manifests, researches the release
notes of major and pre-1.0 minor library upgrades (and tool major and minor
upgrades), and reports findings plus a `pi-reviewer/breaking-changes` check run.

- Needs `checks: write`; require the check run's name in branch protection, not the job's
- Does not skip `renovate[bot]` — your workflow's `if:` decides which pull requests run
- An upgrade it cannot verify is a `WARN`, never a failure
- `url-reader: 'true'` lets it read non-GitHub upstreams, and is off by default

Add it as a second job to the workflow above:

```yaml
  dependency:
    runs-on: ubuntu-latest
    if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
    permissions:
      contents: read
      pull-requests: write
      issues: write
      checks: write
    concurrency:
      group: pi-reviewer-dependency-${{ github.repository }}-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: esafak/pi-reviewer@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          model: openai/gpt-6-luna
          mode: dependency
          url-reader: 'true'
```

Thresholds, supported manifests, the gate, and the limits of a research-based
check: [CI.md](./CI.md#dependency-breaking-change-check).

## Basic configuration

For the full list of settings see [CI.md](./CI.md).

| Input | What it does | Default |
|---|---|---|
| `model` | Model in `provider/modelId` format | _(required)_ |
| `pi-api-key` | Explicit key for the model provider. Or set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `ZAI_API_KEY` in `env:` | `PI_API_KEY` fallback |
| `min-severity` | `info` reports everything, `warn` skips nits, `critical` only blockers | `info` |
| `mode` | `review` reviews the diff; `dependency` checks the PR's dependency upgrades for breaking changes | `review` |
| `summary` | Post the collapsed PR summary on the first review | `true` |
| `review-drafts` | Review draft PRs | `false` |
| `doc-dirs` | Inject matching project docs (`.md` with `description` frontmatter) | off |
| `skills-dirs` | Skill dirs loaded as review guidance (`.pi/skills`, `.claude/skills`, `.agents/skills`, `skills`); `'none'` disables | default on |
| `lsp-servers` | Semantic context (hover/definition/references); pins a language's server, or `'none'` to disable. Binaries must be preinstalled | best-effort on |
| `code-exec` | Run tests/typechecks in a no-network sandbox to verify findings before flagging | `false` |
| `extra-instructions` | Maintainer-written focus notes, appended verbatim | off |

Beyond the basics — MCP servers, skills, LSP setup, web search, sandboxed code execution, custom bot identity — see [CI.md](./CI.md).

## How it works

Each run reviews the accumulated batch since the last successful marker, stores that marker in the posted review, and reconciles open threads in place. No session replay, no cache to manage. Fork PRs are skipped; replies from `OWNER` / `MEMBER` / `COLLABORATOR` get one response each. Details in [CI.md](./CI.md).

## Also available: local `pi` extension

Same reviewer inside the [pi](https://github.com/mariozechner/pi) TUI as a `/review` command — local diffs, `--ssh` for remotes, `--ui` for a browser triage UI.

```bash
pi install https://github.com/esafak/pi-reviewer
```

```
/review --branch dev
/review --pr 42
/review --ui
```

Extension options, SSH mode, UI mode, diff-cap handling, and project-convention lookup are documented in [docs/local.md](./docs/local.md).

