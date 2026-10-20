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
      pr-number:
        description: 'Pull request number to review'
        required: false
        type: number
      target-head:
        description: 'Optional ancestor commit to review'
        required: false
        type: string

jobs:
  review:
    runs-on: ubuntu-latest
    if: ${{ (github.event_name != 'pull_request_review_comment' || github.event.comment.user.type != 'Bot') && (github.event_name != 'issue_comment' || github.event.comment.user.type != 'Bot') && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
    permissions:
      contents: read
      pull-requests: write
      issues: write # Required to post comments and reactions.
    concurrency:
      group: pi-reviewer-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr-number || github.run_id }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: ${{ github.event.pull_request.head.sha || github.sha }}
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          model: openrouter/openai/gpt-5.4-mini
          thinking: off
          # Optional: log tool calls and upload the short-retention thinking trace.
          # debug: 'true'
          min-severity: ${{ inputs.min-severity || 'info' }}
          review-drafts: 'false'
          # summary: 'false' # opt out of PR summaries (enabled by default)
          # Optional workflow_dispatch inputs:
          # pr-number: 123
          # target-head: <ancestor SHA>
          # Opt in to injecting matching project docs into the review.
          # Comma-separated dirs scanned for .md files with a 'description' frontmatter.
          # doc-dirs: '.pi/notes,docs/review'
          # Optional user-configured MCP servers (config is read from the default branch).
          # mcp-config-file: '.github/mcp.json'
          # Optional semantic review context via LSP (best-effort, CI comment reviews only).
          # Binaries must be preinstalled on the runner; missing ones warn and skip.
          # lsp-servers: 'ty,markdown-oxide,rust-analyzer,taplo,gopls,tsc-rs,kotlin-lsp' # default; 'none' disables
          # lsp-config-file: '.github/lsp.json' # trusted override, read from the default branch
          # Optional web search configuration.
          # Exa/Brave use EXA_API_KEY/BRAVE_SEARCH_API_KEY; DuckDuckGo regular
          # search uses a fixed unauthenticated endpoint and has no AI mode.
          # web-search: 'true'
          # search-provider: 'brave'
          # ai-search: 'true'
          # ai-search-provider: 'brave'
          # gh: 'false' # disable gh-backed GitHub research
          # setup-gh: 'true' # install GitHub CLI only when absent
          # github-scope: 'public' # or 'token-accessible'; defaults to public
          # Optional sandboxed code execution (fail-closed, no network).
          # The agent gets a `code_exec` tool to run tests/typechecks offline.
          # code-exec: 'true'
          # code-exec-timeout-ms: '120000'
          # code-exec-max-calls: '5'
          # code-exec-wall-time-budget-ms: '360000'
          # code-exec-max-stream-bytes: '32768'
          # code-exec-image: '...' # macOS Apple Container image (pre-pulled)
```

### User-configured MCP servers

MCP is opt-in for CI PR comment reviews. Add a JSON config file to the repository's
default branch, then set `mcp-config-file` to its repository-relative path. The
action reads the file from the default-branch ref—not from the PR head or the PR
merge commit—so a pull request cannot change which MCP commands run. If the file
does not exist on the default branch, the review fails rather than falling back
to PR-controlled content. MCP tools are not enabled for local runs, replies,
dry-runs, or non-comment output.

The config path is arbitrary: `.github/mcp.json` below is only an example name.
The action passes the file to the adapter in memory, so it is unrelated to the
adapter's own `mcp-adapter.json` file discovery.

```yaml
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          model: openrouter/openai/gpt-5.4-mini
          mcp-config-file: .github/mcp.json
```

Example `.github/mcp.json`:

```json
{
  "mcpServers": {
    "deepwiki": {
      "url": "https://mcp.deepwiki.com/mcp",
      "auth": false
    }
  }
}
```

For an authenticated server, add a config entry such as:

```json
{
  "mcpServers": {
    "internal-docs": {
      "url": "https://mcp.example.com/mcp",
      "auth": "bearer",
      "bearerTokenEnv": "DOCS_MCP_TOKEN"
    }
  }
}
```

Then map the secret into the action step's environment:

```yaml
      - uses: esafak/pi-reviewer@main
        env:
          DOCS_MCP_TOKEN: ${{ secrets.DOCS_MCP_TOKEN }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          model: openrouter/openai/gpt-5.4-mini
          mcp-config-file: .github/mcp.json
```

The adapter resolves `bearerTokenEnv` and `${ENV_VAR}` references in supported
config fields before sending requests; MCP servers receive ordinary auth
headers and do not need to support variable substitution. Keep credentials in
GitHub Secrets and map them into the action step's `env:`; never commit literal
tokens in the MCP file. Static bearer tokens and API-key headers are supported.
If `auth` is omitted, CI disables automatic OAuth discovery; set `auth: false`
for an anonymous server or `auth: bearer` with `bearerTokenEnv` for a bearer
token. Interactive and client-credentials OAuth are not supported in this
release.

Use remote HTTP MCP servers where possible. Local stdio server commands execute
on the workflow runner from a temporary checkout of the trusted default-branch
revision, never from the PR worktree. To limit inherited secrets, the action
disables ambient environment inheritance for stdio servers; provide only
required variables in the server's explicit `env` mapping. The action supports
`mcpServers` and `settings` in the config; it does not load imported configs,
Claude/agent plugin bundles, or `settings.agentPluginPaths`. Only configure
servers you trust: their tool output is available to the reviewer and their
requests may receive diff or repository context. MCP output is treated as
untrusted reference data, not instructions. Per-call MCP logging exists only
when `debug: true`: split `server` and bare `tool` names with status, the
closed `errorClass` (`tool` vs `call_failed` vs `input_required`), and — for
results whose adapter details carry one (`call_failed`, `input_required`) — a
bounded (≤500 chars) sanitized exception message from `details.message`.
Tool output (`content`) is still never logged. Without debug, per-call
details are not logged; the always-on failure event carries `servers`, bare
`tools`, and `errorClasses`, so operators can triage without debug: `tool`
means the server rejected the call (check the server tool contract),
`call_failed` means the call threw (check server health and config),
`input_required` means a UI-gated tool cannot run headless. If the
reviewer actually calls a configured MCP tool and that call
fails, pi-reviewer does not post a potentially incomplete review — unless
every failure is DeepWiki reporting the repository is not indexed, the
normal case for private repositories, which posts with a warning instead.
Any other DeepWiki failure still vetoes. Servers the
reviewer never calls are not connected.

DeepWiki's public MCP server is supported as an ordinary entry in this file and
does not require authentication. This repository's [`.github/mcp.json`](./.github/mcp.json)
is a ready-to-use example. The dogfooding workflow uses it for issue-comment
and manual-dispatch reviews; it leaves MCP off on pull-request events because
those read config from the target branch, where the example may not exist until
the PR is merged. Workflows that previously used a DeepWiki-specific action
input or `/review --deepwiki` flag should configure the server through their
MCP config instead.

### Semantic review context (LSP)

CI comment reviews get language-aware context on top of the diff: the agent
can ask for hover, definition, and references instead of guessing. The
preset selection is correctness-oriented (type errors, broken references,
syntax errors) — the defaults exclude lint/format servers, and review
guidance tells the agent to use diagnostics as breakage signal, not style
findings. (No output filtering is applied: stock `lsp_diagnostics` returns
whatever the server pushed.)

Seven preset servers cover the common languages, all Rust-based where mature:
`ty` (Python), `markdown-oxide` (Markdown), `rust-analyzer` (Rust), `taplo`
(TOML — requires a `--features lsp` build), `gopls` (Go), `tsc-rs`
(TypeScript), `kotlin-lsp` (Kotlin). Unset `lsp-servers` means all seven, best-effort — plus any
custom servers defined in `lsp-config-file`, which run without further
configuration. Each language is skipped with a warning when its binary is
absent, so reviews work with zero config on preinstalled runners. Set
`lsp-servers: 'none'` to disable LSP entirely. A comma-separated subset
selects specific servers, but an explicit selection must include every
config-file id: leftover entries fail fast instead of being silently
ignored.

Binaries must be preinstalled by the workflow — the action never installs,
fetches, or auto-downloads servers. This repository's own review workflow
pins `tsc-rs` in `.github/lsp-tools/package.json` (Renovate-tracked) and runs
`npm ci --prefix .github/lsp-tools` before the Review step.

```yaml
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          model: openrouter/openai/gpt-5.4-mini
          lsp-servers: 'tsc-rs'
```

There is deliberately no pre-prompt diagnostics sweep: stock `pi-lsp`
collects diagnostics on `write`/`edit`, which the read-only CI agent never
calls, so a sweep would always come back empty. Diagnostics still reach the
review through the agent: `lsp_hover` and `lsp_definition` open the document
on the server, and a follow-up `lsp_diagnostics` call then reads the pushed
results (verified with the stub server in `lsp-lifecycle.test.ts`). Pull-only
servers such as `tsc-rs` 0.7.0 never push, so their diagnostics stay
unavailable while navigation works.

Custom servers or preset overrides go in a JSON file with the pi-lsp
`{ version: 1, servers: [...] }` shape, set via `lsp-config-file` to its
repository-relative path. Like `mcp-config-file`, it is read from the
repository's default branch — never from the PR head — so a pull request
cannot change which commands run. Entries merge over presets per server id
(`enabled: false` disables one preset; unknown ids are allowed with full
`bin`/`args`/`include`/`rootMarkers` and become selectable via
`lsp-servers`).

```json
{
  "version": 1,
  "servers": [
    { "id": "ty", "args": ["server", "--extra-flag"] }
  ]
}
```

LSP applies to CI comment reviews only (not local runs, replies, dry-runs,
or non-comment output). The agent tools are read-only; their output is
treated as untrusted data.

The `init` command is the generic, non-App setup. It runs only when invoked
explicitly, creates the workflow only when `.github/workflows/pi-review.yml`
does not already exist, and does not configure GitHub App credentials,
environments, or repository variables. If the file already exists—for example,
because a repository has a custom workflow—`init` leaves it unchanged.

Commit it to your default branch, then provide the API key for your selected provider in the action environment. For `openai/...`, `anthropic/...`, and `zai/...` models, use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`, respectively. Other providers can use `PI_API_KEY` (or the explicit `pi-api-key` input). The precedence order is explicit `pi-api-key` input, then the selected provider's variable, then `PI_API_KEY`; provider-specific variables therefore override the `PI_API_KEY` fallback, but not an explicit input.

In the workflow above, `PI_API_KEY` is supplied through the `pi-api-key`
input, making it the explicit highest-priority key. If you want
`MODEL_NAME` to select the provider-specific key, omit `pi-api-key` and pass
the provider keys through `env:` instead.

### Selecting a model from multiple provider secrets

For workflows that need to select between several providers without changing
the workflow, set the repository variable `MODEL_NAME` to the complete model
name (for example, `openai/gpt-5.6-luna`) and add the corresponding secrets to
the repository or environment. Add this step immediately before the Pi
Reviewer action. Values used by shell commands are passed through `env:` rather
than expanded directly into the script. This keeps GitHub context values and
secrets out of the command text and follows the workflow's injection-safety
convention.

```yaml
      - name: Select provider API key
        shell: bash
        env:
          MODEL_NAME: ${{ vars.MODEL_NAME }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
        run: |
          if [ -z "$MODEL_NAME" ]; then
            echo "::error::Repository variable MODEL_NAME is required"
            exit 1
          fi
          provider="${MODEL_NAME%%/*}"
          case "$provider" in
            openai) key="$OPENAI_API_KEY" ;;
            anthropic) key="$ANTHROPIC_API_KEY" ;;
            zai) key="$ZAI_API_KEY" ;;
            *) echo "::error::Unsupported provider in MODEL_NAME: $provider"; exit 1 ;;
          esac
          if [ -z "$key" ]; then
            echo "::error::No API key configured for provider: $provider"
            exit 1
          fi
          echo "::add-mask::$key"
          printf 'PI_API_KEY=%s\n' "$key" >> "$GITHUB_ENV"
```

Then configure the action to use the selected key and model:

```yaml
      - uses: esafak/pi-reviewer@main
        # Alternative: pass all provider keys directly. Empty/unset secrets are
        # ignored, but every configured key is exposed to the action process.
        # When using this alternative, omit the selection step above and omit
        # the pi-api-key input below.
        # env:
        #   OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        #   ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        #   ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ env.PI_API_KEY }}
          model: ${{ vars.MODEL_NAME }}
```

This pattern supports one configured provider at a time while keeping all
provider secrets available to the workflow. The selection step supports the
`openai/`, `anthropic/`, and `zai/` prefixes documented above; use `PI_API_KEY`
directly for other providers or extend the `case` statement for that provider.

## Repository self-review

This repository's workflow uses the `review` environment and the required
repository variable `MODEL_NAME` to select the provider. Add the matching
provider secret to the `review` environment:

`review` is only this repository's environment name; environment names are arbitrary.
Put `MODEL_NAME` and the matching provider secret in whichever environment the workflow selects.

| `MODEL_NAME` prefix | Secret |
|---|---|
| `openai/` | `OPENAI_API_KEY` |
| `anthropic/` | `ANTHROPIC_API_KEY` |
| `zai/` | `ZAI_API_KEY` |

The workflow rejects unsupported providers and missing matching secrets
without printing key material. It deliberately defaults all workflow runs to
`warn`; the action's standalone default remains `info`.

## Usage

Replies to Pi Reviewer findings use a strict assistant action: the provider-visible, schema-validated `submit_reply` tool is preferred, while model-requested JSON validated by `parseReplyAction` remains a compatibility fallback for models that do not call tools. Low-information acknowledgements, thanks, agreement, and completion notices receive one GitHub review-comment reaction; substantive questions, requests, disagreements, uncertainty, and technical information receive a concise root-targeted reply. Review-comment reactions are authorized by `pull-requests: write`; pull-request no-findings reactions are authorized by `issues: write`. There is no separate `reactions: write` GitHub Actions permission. Reactions are deduplicated by GitHub per comment, user, and reaction content; replies use an authenticated marker. If a no-findings reaction fails, the action warns and stays silent; nothing visible is posted. If a review-comment reaction fails, the action warns and skips that acknowledgement, so a reaction failure never discards the review. Code reviews continue to use the separate structured `submit_review` tool.

On `pull_request: synchronize`, the action also scans the authenticated, paginated review-comment and thread snapshot for the oldest unprocessed direct human reply to each unresolved Pi Reviewer finding. This recovers replies whose `pull_request_review_comment` workflow was canceled or superseded. Recovery runs before the normal diff review and once more after it; each candidate is re-fetched and head-checked before model generation and every mutation, and failures for one finding do not abort the review. A later push is required: if no synchronize event runs after a canceled reply, it remains unprocessed until a future push or manual intervention. A conversational `reply` or `react` action does not resolve the finding; only the assistant's guarded `resolve` action does so.

Every eligible PR event produces at most one review for the range since the last successful marker. Only the PR's first review with a body carries the collapsed PR summary (see PR summaries); later batches post findings-only. A human reply from an OWNER, MEMBER, or COLLABORATOR to a Pi Reviewer inline finding receives the reaction or concise response selected by the assistant; threads rooted at human comments, bot-authored comments, status replies, or resolved threads are ignored. GitHub review-comment replies are root-targeted because GitHub exposes review threads as flat REST replies, so each authorized human message in an active finding thread can receive at most one response. Existing agent findings are reconciled in their original threads; human-authored threads are never changed. `/pi-review` is restricted to authorized internal PR commenters. Fork PRs are skipped. Replies are skipped if the PR head changes before processing, or if the PR is a draft while `review-drafts` is disabled.

The marker is authenticated with the identity returned by `GET /user` and contains the reviewed `fromSha`, `toSha`, event kind, and review ID. It is the durable state for batching—not an LLM session, transcript replay, Actions cache, or provider cache. If several pushes arrive while a runner is pending, the next run recomputes the complete range from the latest marker.

New findings are posted only for the current batch. Existing findings are returned as `finding_updates`: fully resolved findings receive one marked reply and are then resolved, partial findings receive one explanatory reply and remain open, and unchanged findings receive no reply. If a reply succeeds but resolution fails, the resolution remains independently retryable. Findings that cannot be positioned are kept in the review body with hidden, authenticated `body-finding:v1` markers and stable positive IDs; their lifecycle is reconciled by updating only the originating review body, preserving its visible text. The last-resort issue-comment fallback is intentionally not adopted as durable finding state, because issue comments do not have review-body lifecycle semantics. Lifecycle replies say `Resolved by <7-character SHA>` or `Partially addressed by <7-character SHA>`; conversational replies omit the SHA unless the user asks for it. Reply markers are authenticated by the posting bot and checked again immediately before posting. The per-PR concurrency group limits races, but check/POST is necessarily best-effort rather than atomic; a thread resolved during generation may still receive a response if resolution is not observed by the final check.

Draft pull requests are skipped by default, including manual dispatch and `/pi-review`. Set `review-drafts: true` to review draft lifecycle events. When a draft becomes ready, the accumulated range is reviewed once. Manual dispatch accepts a PR number and optional ancestor target head; the target must belong to the current PR history.

## PR summaries

CI comment reviews post a collapsed PR summary on the PR's first review with a body. The block explains What changed, the inferred Why, and Risks/edge cases, and includes a GFM Mermaid diagram (`flowchart TD` for structure, `sequenceDiagram` for call order) only when the diff introduces or alters a multi-component interaction — a new subsystem, a cross-file flow, or a changed state machine. Localized changes (single-file fixes, renames, config/dependency bumps, docs-only diffs) omit the diagram. The toggle is labeled with the reviewed range (e.g. `Summary · abc1234..def5678`) and starts collapsed so findings stay first.

Summaries are enabled by default and CI-only (local, SSH, and file outputs never include them). Opt out per workflow:
```yaml
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          model: openrouter/openai/gpt-5.4-mini
          summary: 'false'
```

Emit-once cadence: only the first bodied review carries the summary; later pushes post findings-only and never rewrite it automatically. Marker-only reaction reviews do not consume the slot — if the first batch fell back to a reaction, a later batch still posts the first summary. When summaries are disabled, review bodies are byte-identical to before this feature and the reaction fast-path is unchanged. A zero-findings first batch with a summary posts the summary body instead of reacting.

The skipped-files notice (when the diff exceeds the size limit) stays in the findings summary, not the PR overview. A review carrying a summary ends with a server-rendered fine-print footer naming the available commands; it is never model-generated, and it renders if and only if the summary block does — so a first review whose overview the model omitted carries neither.

Diagrams render with GitHub's default Mermaid theme; per-diagram theme directives are stripped by GitHub and must not be emitted. If a diagram shows "Unable to render rich display" with a chunk-load error, that is GitHub's renderer bundle failing to load in the viewer — unrelated to the diagram source, which is validated before posting. Refreshing the page resolves it; the prose carries the full content either way.

To refresh the summary after the PR evolves, comment `/pi-summary` in the PR conversation tab (top-level comment, not an inline thread reply). It carries the same contract as `/pi-review`: non-bot `OWNER`, `MEMBER`, or `COLLABORATOR` only, and it never runs on forks or drafts skipped by `review-drafts`. The command recomputes the summary over the whole diff (`merge-base` to head, never the incremental batch range) and updates the first bodied review — or the fallback issue comment — in place, replacing only the summary block and leaving batch markers and body-finding markers untouched. The run is head-checked like finding reconciliation: if the head moves during generation, nothing is mutated. Findings from the regeneration pass are discarded, so it can never file inline comments on old commits. Each invocation costs a full review pass.

## Inputs

| Input | Required | Description |
|---|---|---|
| `github-token` | yes | GitHub token to post PR comments and optionally access GitHub research resources within its permissions |
| `pi-api-key` | no | Optional explicit API key for the model's provider. When omitted, the action uses the provider-specific environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `ZAI_API_KEY`). |
| `model` | yes | Model to use in `provider/modelId` format (e.g. `openrouter/openai/gpt-5.4-mini`) |
| `thinking` | no | Thinking budget: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` (default: `off`) |
| `debug` | no | Log tool calls and upload available model thinking as a one-day artifact (default: `false`). Thinking may contain sensitive context. |
| `min-severity` | no | Minimum severity: `info`, `warn`, or `critical` (default: `info`) |
| `max-diff-chars` | no | Explicit diff cap in chars (default: derived from the model's context window, 100k floor). Precedence: this input > `PI_REVIEWER_MAX_DIFF_CHARS` env > config-file `maxDiffChars`. |
| `summary` | no | Post a collapsed PR summary (What/Why/Risk with an optional Mermaid diagram) on the PR's first review (default: `true`). Set to `'false'` to opt out. CI comment reviews only. |
| `doc-dirs` | no | Comma-separated dirs to scan for docs to inject into the review (default: empty — inject nothing) |
| `extra-instructions` | no | Additional maintainer-authored instructions appended to the CI prompt as trusted `<custom_instructions>` (default: empty — inject nothing) |
| `web-search` | no | Enable regular CI web search (default: false) |
| `search-provider` | no | `exa`, `brave`, or `duckduckgo`; explicit provider selection, no fallback. May also be set as `PI_REVIEWER_SEARCH_PROVIDER` in the caller workflow environment. |
| `ai-search` | no | Enable separate provider-grounded AI search (default: false) |
| `ai-search-provider` | no | `exa` or `brave`; requires the provider key. May also be set as `PI_REVIEWER_AI_SEARCH_PROVIDER` in the caller workflow environment. |
| `gh` | no | Enable gh-backed read-only GitHub research tools (default: `true`) |
| `setup-gh` | no | Install GitHub CLI only when absent (default: `true`). |
| `github-scope` | no | `public` (default) or `token-accessible`; the latter can expose every repository readable by the configured token. May also be set as `PI_REVIEWER_GITHUB_SCOPE` in the caller workflow environment when the input is omitted. |
| `search-max-queries` | no | Regular search query budget, bounded from 1 to 10 (default: 3) |
| `ai-search-max-queries` | no | AI search query budget, bounded from 1 to 3 (default: 1) |
| `search-max-results` | no | Regular results per query (default: 5) |
| `ai-search-max-sources` | no | AI sources per answer (default: 5) |
| `search-timeout-ms` | no | Per-request regular search timeout (default: 8000) |
| `ai-search-timeout-ms` | no | Per-request AI search timeout (default: 15000) |
| `registry-wall-time-budget-ms` | no | Total wall-clock budget across all package registry lookups, bounded to 1000-120000 ms (default: 15000) |
| `search-required` | no | Fail instead of warn when required regular search is unavailable or fails |
| `ai-search-required` | no | Fail instead of warn when required AI search is unavailable or fails |
| `code-exec` | no | Enable sandboxed code execution via the `code_exec` tool (default: `false`). CI comment reviews only; fail-closed when no sandbox backend is available |
| `code-exec-timeout-ms` | no | Per-command code-exec timeout, bounded to 1000-120000 ms (default: 120000) |
| `code-exec-max-calls` | no | Maximum sandboxed code-exec calls per review, bounded from 1 to 10 (default: 5) |
| `code-exec-wall-time-budget-ms` | no | Total wall-clock budget across all sandboxed code-exec calls, bounded to 30000-1200000 ms (default: 360000) |
| `code-exec-max-stream-bytes` | no | Per-stream stdout/stderr cap in bytes, bounded to 1024-131072 (default: 32768) |
| `code-exec-image` | no | Linux container image for sandboxed exec on macOS (Apple Container backend). Must be pre-pulled and contain bash, coreutils, and your toolchains |
| `review-drafts` | no | Review draft PRs (default: `false`) |
| `setup-node` | no | Set up Node 24 via `actions/setup-node` when a compatible Node is not already on `PATH` (default: `true`). Set to `false` to require the runner image to provide Node 24 or newer. |
| `cache` | no | Cache the pnpm store across runs (default: `true`). Disable on runners where the cache service is unavailable or unwanted. |

The action runs on Node 24 or newer (LTS when installed by the action). Before setup, it independently reuses compatible `node`, `pnpm`, and `vp` executables already on `PATH`; any subset can be preinstalled, and only missing or incompatible tools are installed. Node must be >=24, pnpm must match `package.json` and be at least 9 (the action ships a lockfileVersion 9.0 lockfile), and Vite+ may match or be newer than the stable minimum version in `pnpm-workspace.yaml` (a prerelease of that minimum does not qualify). When Vite+ must be installed, its temporary executable files and installation are placed under a private, executable directory in the runner user's home directory and removed after the action; users do not need to set `TMPDIR`. Dependencies are installed with pnpm delegated through `vp install`. The self-review workflow prewarms Vite+ with a pinned `setup-vp` step, whose cache is keyed from the repository checkout. The action itself separately caches its pnpm store with `actions/cache`, keyed on a hash of `pnpm-lock.yaml`, so warm runs skip the download. Both cache paths are optional performance optimizations: cache failures degrade to uncached setup/install rather than aborting the review. Runners without a compatible preinstalled toolchain need network access to `viteplus.dev` for the Vite+ CLI installer in addition to the package registry.

Web search is CI-only and disabled by default. Exa and Brave require their
provider keys; DuckDuckGo regular search is unauthenticated and best-effort,
with no supported Duck.ai CI API. To use Exa or Brave, provide
`EXA_API_KEY` or `BRAVE_SEARCH_API_KEY` through the workflow/job `env:` block;
these are optional environment secrets and are not action inputs. Search
results and AI answers are untrusted data, not instructions. Enabling search
creates a deliberate query-egress channel: model-derived queries may disclose
prompt context to the selected provider, so queries must not contain secrets,
private source, or the full diff. Valid current-run citations appear in a
collapsible **External sources** section in the GitHub review body. Links or
URLs written directly by the model outside that generated section remain an
existing residual risk and are not treated as validated evidence.

Package registry lookup is available by default in CI comment reviews and has
no opt-out input. It makes bounded public HTTPS requests to PyPI, Maven Central,
crates.io, npm, and the Go module proxy only when the model calls
`package_lookup`; local terminal/file reviews and reply-only runs do not receive
the tool. The tool uses each registry's package/version selectors (plus Maven's
coordinate filters), validates and allowlists a bounded subset of the registry's
native JSON fields, and treats all returned metadata as untrusted. It does not
download package artifacts, run package code, or add citations to the posted
review. Budgets are fixed at five lookups per review, an eight-second request
timeout, a fifteen-second total lookup wall-clock budget, 7 KiB per metadata
projection and 15 KiB aggregate metadata budget (reserving framing within the
8 KiB per-result and 16 KiB aggregate model-facing tool-content caps). Registry
failures are advisory and do not fail the review.

GitHub research uses the installed GitHub CLI and is enabled by default when a
token is available, only in CI comment reviews. Set `gh: 'false'` to disable it.
The `Ensure gh CLI` action step probes with `command -v` and installs on Linux
only when missing; failure is warn-only. On macOS/Windows install via `setup-gh-cli`.
The transport uses argument arrays with read-only commands and GET-only `gh api`.
Results are limited to 7 KiB each/15 KiB total, eight requests and 15 seconds
total (five seconds per request). `github-scope` controls visibility: `public`
filters private repositories, while `token-accessible` allows token-readable
resources. Missing token or CLI warns and review continues.

The reviewer receives bounded `github_search` and `github_read` tools for
repositories, code, pull requests, issues, runs, workflows, releases, repository
files, discussions, and PR checks/status/diffs.
The tools use the existing `github-token`; the token's permissions determine
which resources are available. `github-scope` defaults to `public` and rejects
private repositories even when the token can read them.
`token-accessible` explicitly permits any resources that the configured token
can read. Search and read results are bounded, untrusted advisory context, not
instructions or formal citations in the posted review. Search queries must not
contain secrets, private source, or the full diff. Public code search requires
GitHub authentication; cross-repository availability therefore depends on the
configured token having access to the search results. GitHub API search limits
apply, including the stricter code-search limit; rate-limit failures are
advisory and do not fail a review. `github_search` accepts typed state, label,
assignee, author, and additional query text for issue/PR searches; language and
match for repository/code searches; sort/order for repositories/issues/PRs; run
workflow/branch/status/event filters; `all` for workflows; and draft/prerelease
exclusions for releases. Labels are single validated tokens (spaces are not
supported). `github_read` supports comments for PRs/issues, name-only diffs,
branch-specific repository reads, and run logs/exit-status/attempt. These are
per-tool fields, not action inputs: the client maps them to fixed `gh` flags and
raw argv/output-shaping controls are not model inputs. Search limits remain at
five, while repo-local run/workflow/release matching checks all query terms
against the five most recent fetched items. Comments and logs show `[truncated]`
only when their raw result fits the 4–7 KiB capture window; results over 7 KiB
fail and the tool advises continuing without the result.

## Sandboxed code execution

Opt-in and available only to CI comment reviews. When `code-exec: 'true'`, the
reviewer receives a `code_exec` tool that runs shell commands
inside a sandbox with no network. This is code execution, not a read-only
lookup: the workspace is writable (so incremental builds survive across
calls) with `.git` re-mounted read-only, and secrets never enter the sandbox
environment. stdout and stderr return as separate blocks and separate
`details` fields, each with its own byte cap and truncation flag, plus the
exit code and a `Remaining code_exec calls` budget counter.

Backends are selected at runtime through a shared interface, fail-closed when
none is present:

| Backend | Platform | Mechanism |
|---|---|---|
| `bubblewrap` | Linux | `bwrap --unshare-all --unshare-net`, host rootfs bind-mounted read-only; toolchains come from the runner host (no container image on this path) |
| `apple-container` | macOS arm64 | Apple Containerization `container run` with no network attached and `--no-dns`; toolchains come from `PI_REVIEWER_CODE_EXEC_IMAGE` |
| `mxc` | Windows 11 | Microsoft MXC SDK `processcontainer` backend with deny-egress, workspace writable / `.git` read-only, UI disabled |
| `none` | anywhere else | never executes; the tool throws `code execution unavailable` so the agent moves on |

> Note: only Linux (bubblewrap) sandboxing has been tested. macOS and Windows backends require user feedback.

The action auto-installs `bubblewrap` on Linux runners when `code-exec` is enabled.
Ubuntu 24.04 confines unprivileged user namespaces via AppArmor
(`kernel.apparmor_restrict_unprivileged_userns=1`), under which `bwrap`
creates namespaces but is denied the in-namespace capabilities its loopback
setup needs (`bwrap: loopback: Failed RTM_NEWADDR`). The action therefore
relaxes that restriction before reviewing — but only on disposable
GitHub-hosted runners (`RUNNER_ENVIRONMENT=github-hosted`), which die with
the job. On other runners it prints a warning and leaves the host alone:
persistent hosts should set the sysctl persistently (`/etc/sysctl.d/`) or,
preferably, load Ubuntu's `bwrap-userns-restrict` AppArmor profile
(`apparmor-profiles` package). Without either, `code_exec` still fails
closed — every call dies in sandbox setup with bwrap's error (stderr plus
exit code) in the tool output, at the cost of one budgeted call each.
The sysctl only restricts unconfined processes. A runner already confined by
a container profile (any `/proc/self/attr/current` label other than
`unconfined`) is outside its scope — `unshare -U -r true` succeeds there
regardless of the sysctl value — so the setup step skips the sysctl warning
when confinement is observed and prefers its `bwrap` probes over inferring
capability from the sysctl.
This requirement is Linux/bubblewrap-only: the Apple Container and MXC
backends isolate differently and are unaffected. If you see
`bwrap: loopback: Failed RTM_NEWADDR` in CI logs on a custom runner, this
restriction is the cause. That guidance stays for bare-metal hosts; the next
section covers a different symptom with a different fix.

### Containerized self-hosted runners (ARC/Kubernetes)

Containerized runners (e.g. ARC runner pods on Kubernetes with the containerd
runtime) fail differently: `bwrap: Failed to make / slave: Permission denied`,
at startup before any loopback setup. bwrap unconditionally remounts `/` as
rslave so its tmpfs/proc/dev/binds never propagate to the host; the
container's own AppArmor profile (`cri-containerd.apparmor.d` /
`docker-default`, containing `deny mount`) denies it. A seccomp-only container
produces the same line with `Operation not permitted` instead — check the errno
wording and optional AppArmor `DENIED` audit lines to tell them apart.

Confirm with: `cat /proc/self/attr/current` (a confined name, not
`unconfined`), `bwrap --unshare-all --unshare-net --ro-bind / / true`
(reproduces the slave error), and the split of `unshare --user
--map-root-user true` succeeding while mount propagation is denied.

Host-level remedies do not apply here: the container profile is set by the
pod/runtime and unreachable from any job step, and the stock
`bwrap-userns-restrict` profile is path-attached to `/usr/bin/bwrap`, not
usable as a container profile. `securityContext.appArmorProfile: Unconfined`
and `capabilities.add: ["SYS_ADMIN"]` are dead ends (the former resolves to
`unprivileged_userns` under the userns restriction; AppArmor mediates `mount`
regardless of capabilities). For seccomp-denied mounts the knob is
`securityContext.seccompProfile`, not an AppArmor profile.

With a mounting profile in place, a second container-only failure can appear:
`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`. The
kernel denies fresh procfs instantiation from inside a nested user namespace
with `EPERM`: under the same profile tmpfs mounts succeed while proc mounts
fail, and `--proc` succeeds without a nested user namespace, so this is a
namespace restriction independent of LSM state — no AppArmor or manifest
change fixes it. The runner handles it by retrying once with `--ro-bind
/proc /proc` (reusing the existing mount read-only instead of creating one)
while keeping `--unshare-pid`, so PID isolation is retained. Trade-off: the
sandbox can read the pod's process table — command lines are world-readable
by design, while /proc/PID environ is ptrace-gated (denied for
non-descendants at ptrace_scope 1 and above, readable if the host sets 0) —
so treat the sandbox as egress-denied but not secret-isolated from same-uid
pod processes. Reproduce with `bwrap --ro-bind
/ / --dev /dev --proc /proc --tmpfs /tmp --unshare-user --unshare-pid true`
(fails) versus the same invocation with `--ro-bind /proc /proc` (succeeds),
or `unshare -Urm sh -c 'mount -t proc proc <dir>'` (fails) versus `mount -t
tmpfs` (succeeds). On VM runners `--proc` keeps working because the process
starts outside any nested user namespace.

Apply the ready-to-use profile in `assets/apparmor/` (a minimal profile permitting
mount/userns with proc/sys write denies retained — diff it against your runtime
default before use; minimum Ubuntu 24.04 / kernel 6.8): load it into
each node's host policy first (see `daemonset.yaml` — pods referencing a
profile that isn't loaded fail to start), then reference it from the runner pod
via `securityContext.appArmorProfile: { type: Localhost, localhostProfile:
pi-reviewer-runner }` (K8s 1.31+), or the
`container.apparmor.security.beta.kubernetes.io/<container>:
localhost/pi-reviewer-runner` annotation on older clusters.
On macOS the backend requires the Apple Container `container` CLI plus an
explicit Linux image with your toolchains, set via `code-exec-image`. The image
must be pre-pulled before the review step (an un-pulled image stalls the run
on registry egress while the deadline burns) and must contain `bash`,
coreutils (`timeout`), and your toolchains, since the container carries no
host rootfs unlike bubblewrap. On Windows the MXC SDK ships as a
regular dependency (installed with the action), so `windows-latest` runners
work with no extra setup, subject to the
[Windows OS-version support](https://github.com/microsoft/mxc/blob/main/docs/backends/process-container/os-version-support.md)
for `processcontainer`:

```yaml
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          model: openrouter/openai/gpt-5.4-mini
          code-exec: 'true'
```

There is no registry egress, so dependencies must be pre-installed and
compiled **before** the reviewer step in the same job. The sandbox reuses the
workspace (`target/`, `node_modules/`) and read-only toolchain caches, making
each call an incremental rebuild rather than a cold one:

```yaml
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          model: openrouter/openai/gpt-5.4-mini
          code-exec: 'true'
```

Rust needs this most: a cold `cargo build` exceeds the per-command timeout,
so run `cargo fetch && cargo test --no-run` first and cache `target/` plus
`~/.cargo` (e.g. with `Swatinem/rust-cache`). Inside the sandbox the agent is
instructed to stay offline:

| Ecosystem | Offline consumption |
|---|---|
| Cargo | `cargo test --offline -p <crate> --lib` |
| npm | `npm test` against pre-installed `node_modules` (`npm ci --offline` if reinstalling) |
| pip | `pytest -q` against the pre-built venv (`pip install --no-index` if installing) |
| Go | `GOFLAGS=-mod=mod GOPROXY=off go test ./...` |

The agent is instructed to form a hypothesis from the diff first and verify one
claim per call with a narrow command; timeouts and truncation errors steer it
narrower. Budgets are five calls per review by default with a six-minute total
wall-clock budget.
Calls run repo-relative (`workdir`, default `"."`); missing or escaping paths
are rejected before the sandbox spawns. Commands run under `bash` on the
Linux/macOS backends but under the Windows shell on MXC, so keep them portable
(`pytest -q`, `npm test`) and avoid shell-specific pipes and redirects.

GitHub research uses bounded `gh` read commands and GET-only `gh api` calls via
argument arrays (no shell). Search supports repositories, code, pull requests,
and issues; Discussions can be read by repository and number through the REST
API, but are not searchable through this transport. Public scope checks
repository visibility before returning results. Per-result, aggregate, request,
and wall-clock budgets bound all CLI output and calls. The current API contract
references the [GitHub REST specification](https://docs.github.com/en/rest).

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

## Custom instructions

Steer the CI review without forking the reviewer. `extra-instructions` is
rendered verbatim as `<custom_instructions>` after trusted guidance
(conventions, review rules, skills, doc context) and before PR-authored sections.

```yaml
      - uses: esafak/pi-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          extra-instructions: |
            Focus on API boundary errors and missing rollback paths.
            Ignore naming nits in test fixtures.
```

Keep the value a maintainer-controlled literal — never interpolate PR title,
body, branch names, or comments; the harness cannot verify where the value came
from. Blank injects nothing. Prefer `AGENTS.md`/`REVIEW.md` for durable
conventions; use this for per-workflow focus. Inspect the result via `dry-run`
(`review.dry_run.system_prompt`).

## Bot identity

By default, comments appear under `github-actions[bot]`. To post under a custom bot name, create a GitHub App:

Some repositories use this custom App-based approach rather than the
`init`-generated workflow. Their workflows select a model with the
`MODEL_NAME` environment/repository variable and use the corresponding
provider secret in a dedicated GitHub environment. The environment name is
not special.

1. Go to `github.com/settings/apps/new`, set **Contents** to **Read and write**, **Pull requests** and **Issues** to **Write**, and disable the webhook
2. Install the app on your repository
3. Generate a **private key** and note the **Client ID** (not the numeric App ID)
4. Add the Client ID as `PI_REVIEWER_CLIENT_ID` and the key as `PI_REVIEWER_PK` to your repo secrets

Then update your workflow:

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      persist-credentials: false

  - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
    id: bot-token
    with:
      client-id: ${{ secrets.PI_REVIEWER_CLIENT_ID }}
      private-key: ${{ secrets.PI_REVIEWER_PK }}
      permission-contents: write # for resolveReviewThread
      permission-pull-requests: write
      permission-issues: write

  - uses: esafak/pi-reviewer@main
    with:
      github-token: ${{ steps.bot-token.outputs.token }}
      pi-api-key: ${{ secrets.PI_API_KEY }}
      model: openrouter/openai/gpt-5.4-mini
      min-severity: ${{ inputs.min-severity || 'info' }}
```
