# CI

pi-reviewer runs on PR lifecycle events. Each run reviews one batch — the commits since the last successful review — and records its marker in the posted review. Open threads are reconciled in place.

## Setup

Run once in your project root:

```bash
pnpx github:esafak/pi-reviewer init
```

This creates `.github/workflows/pi-review.yml` (skipped if it already exists). Commit it, add your model key, open a PR.

Or, adapt this:

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

The generated file adds the usual production guards (bot-loop filter, per-PR concurrency, `workflow_dispatch` inputs). You can start minimal and adopt those as needed.

### API keys

| Model prefix | Env / input |
|---|---|
| `openai/...` | `OPENAI_API_KEY` |
| `anthropic/...` | `ANTHROPIC_API_KEY` |
| `zai/...` | `ZAI_API_KEY` |
| anything else | `PI_API_KEY` or the `pi-api-key` input |

Precedence: `pi-api-key` input → provider-specific env → `PI_API_KEY`. So: pass one key explicitly, or omit `pi-api-key` and put provider keys in `env:`. Never commit keys — use GitHub Secrets.

To switch models without editing the workflow, put the full model name in a `MODEL_NAME` repo variable and select the matching secret in a step before the review:

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
      - uses: esafak/pi-reviewer@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          pi-api-key: ${{ env.PI_API_KEY }}
          model: ${{ vars.MODEL_NAME }}
```

## Everyday settings

```yaml
        with:
          min-severity: info      # info | warn | critical
          summary: 'true'         # collapsed What/Why/Risks on first review
          review-drafts: 'false'  # true to review draft PRs
          doc-dirs: '.pi/notes,docs/review'  # inject matching project docs (off by default)
          # skills-dirs: '.pi/skills'  # default-on review guidance; 'none' disables
          # lsp-servers: 'pyright'     # pin Python's server; other languages keep theirs
          # mcp-config-file: '.github/mcp.json'  # opt-in MCP servers, read from the default branch
          # code-exec: 'true'          # verify by running tests/typechecks in a no-network sandbox
          extra-instructions: |   # maintainer focus notes (off by default)
            Focus on API boundary errors and missing rollback paths.
```

- **Severity** filters noise; **summary** opts out with `'false'`.
- **Drafts** are skipped by default, including manual `/pi-review` runs.
- **Doc context** injects `.md` files with a `description` frontmatter whose description or filename matches the changed paths. Nothing is injected unless you set `doc-dirs`.
- **Skills** are default-on guidance: `SKILL.md` files under the skill dirs are loaded into the review; skills changed by the PR itself are treated as untrusted and reviewed as code instead. Set `skills-dirs: 'none'` to disable.
- **LSP** gives best-effort semantic context (hover/definition/references) on top of the diff. Each language runs one installed server (`ty`/`pyrefly`/`pyright` for Python, `tsrs`/`tsc-rs`/`typescript-language-server` for TypeScript), preferring the one that covers the most changed files. Binaries must be preinstalled — missing ones warn and skip that language. Set `lsp-servers: 'none'` to disable.
- **MCP servers** are opt-in via a JSON config file read from the repository's default branch — never the PR head — so a pull request cannot change which commands run. Keep credentials in GitHub Secrets mapped through the step's `env:`; never commit tokens. Output is treated as untrusted reference data, not instructions.
- **Code execution** (`code-exec: 'true'`) lets the reviewer verify instead of guess: it runs tests/typechecks in a no-network sandbox (fail-closed without a backend). Pre-install dependencies before the review step so calls are incremental rebuilds, not cold installs.
- **Web search** (`web-search: 'true'`) and **AI search** (`ai-search: 'true'`) verify current public facts. Both are disabled by default and CI-only. Exa and Brave need their API keys; DuckDuckGo offers best-effort unauthenticated regular search only. Results are untrusted, and queries must not contain secrets, private source, or the diff.
- **Extra instructions** are appended verbatim as trusted guidance. Keep them maintainer-written — never interpolate PR title, branch, or comments.

## Talking to the bot

- **Reply to a finding** and it answers once: questions and disagreements get a short reply, acks and thanks get a reaction. Only `OWNER` / `MEMBER` / `COLLABORATOR` replies are handled.
- **`/pi-review`** (top-level PR comment): re-review the current batch.
- **`/pi-summary`** (top-level PR comment): recompute the summary over the whole PR and update the first review in place. Findings from that pass are discarded — it never files inline comments.
- A clean run leaves a 👍 reaction instead of posting — but only when no findings are open. Otherwise it records the range and stays silent.
- Fork PRs are skipped. If the head moves mid-run, the run backs off rather than posting stale comments.

## How batching works

One review per eligible event, covering everything since the last marker. Markers are authenticated and stored in the review itself — not in a cache or LLM session — so a burst of pushes collapses into one correct range on the next run. Resolved findings get a `Resolved by <sha>` reply and are resolved; partially fixed ones explain what's left and stay open.

## Dependency breaking-change check

`mode: dependency` checks whether the upgrades a PR makes break this repository.
Instead of reviewing the diff, it reads both ends of every changed dependency
manifest, works out where each upgrade's release notes live, and asks the model
what changed upstream. It posts a review — findings inline where the diff
allows, coverage warnings on the upgrade's own line where it has one — and
publishes a check run named `pi-reviewer/breaking-changes`.

Which pull requests it checks is your workflow's `if:`. The action never
chooses, and the review mode's `renovate[bot]` skip does not apply here: a
Renovate bump is the point.

### Setup

It needs `checks: write`; `GITHUB_TOKEN` gets it from the job's `permissions:`
block. A classic personal access token cannot write check runs — use
`GITHUB_TOKEN` or a fine-grained token with **Checks: write**. Without the
permission the review still posts; only the gate is missing.

```yaml
name: Pi dependency check
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  dependency:
    runs-on: ubuntu-latest
    # The action does not choose its pull requests; this is the whole trigger.
    if: ${{ github.event.pull_request.head.repo.full_name == github.repository }}
    permissions:
      contents: read
      pull-requests: write
      issues: write # Fallback when a review cannot be posted.
      checks: write
    concurrency:
      # Its own group: the review job's is pi-reviewer-<repo>-<pr>.
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

The generated `pi-review.yml` carries an equivalent commented job. A
`workflow_dispatch` trigger also needs a `pr-number` input and an `if:` that
admits it; a `/pi-review` comment works if you also trigger on `issue_comment`
and widen the `if:`. Drafts are skipped before the mode runs, so a required
check waits on the draft until it is marked ready — or set
`review-drafts: 'true'`.

### The gate

`failure` when a `CRITICAL` finding is published, `success` otherwise: `WARN`
and `INFO` annotate the diff without failing it. An analysis that cannot
complete fails too, rather than passing over work that did not happen. Coverage
warnings survive `min-severity`, so `min-severity: critical` cannot hide an
upgrade that could not be verified.

**Require the check run's name, `pi-reviewer/breaking-changes`, not the job's.**
The job succeeds whenever the action exits cleanly — even when a breaking change
was found — so requiring the job would never gate on the analysis.

### What is analyzed

| Kind | Analyzed on |
|---|---|
| Libraries (imported by the code) | major, pre-1.0 minor (`0.x` → `0.y`) |
| Tools and runtimes | major **and** minor (`3.11` → `3.12`) |

Patch bumps, library minors past 1.0, additions, removals, downgrades and
uncomparable constraints are listed in the check summary with a reason, never
analyzed. So are manifests it does not read: `Podfile`, `pubspec.yaml`,
`mix.exs`, `Package.swift`, `conanfile.*`, `MODULE.bazel`, `WORKSPACE`.

Formats it does read: npm `package.json` (including `devEngines.runtime` and
`packageManager`); PyPI `requirements*.txt` and `pyproject.toml`; Maven
`pom.xml` and Gradle `build.gradle[.kts]`; crates `Cargo.toml`; Go `go.mod`;
NuGet `*.csproj`, `*.fsproj`, `Directory.Packages.props`, `packages.config`;
RubyGems `Gemfile`; Packagist `composer.json`; mise (`mise.toml` and
`.mise.toml` at any depth, plus the `mise.local.toml` and `.config/mise/`
variants); asdf `.tool-versions`; aqua `aqua.yaml`; and GitHub Actions
workflows and actions.

### What "researched" means

Every qualifying upgrade gets a published disposition. The summary lists them
with the accepted citation — a checkout path for a `local:` citation, the
candidate id the analysis handed the model for a remote one — plus the
researched and unverifiable totals. The harness checks which upgrade a
disposition belongs to, that a cited remote location is one it resolved, and
that none is missing; it cannot verify the notes were read, so *researched* is
the model's claim.

This is research, not a build: an upgrade whose notes cannot be found or reached
is a `WARN`, never a failure. A finding on that upgrade's own line is withdrawn,
since the notes were what would ground it; a finding elsewhere cannot be related
to an upgrade at all.

GitHub upstreams are read with `github_read`. Everything else needs
`url-reader: 'true'` — off by default because it is the only tool that can reach
an arbitrary host. Without it, non-GitHub upgrades report as unverifiable.

Each run analyzes the whole pull request and creates a fresh check run; there is
no incremental range and no reconciliation of earlier findings. `/pi-summary` is
ignored here, and `target-head` is rejected.

## Advanced

**MCP.** Prefer remote HTTP servers. Local stdio commands run from a temporary checkout of the trusted default-branch revision with no ambient env inheritance — provide only required variables in the server's explicit `env` mapping. Example config (`.github/mcp.json`):

```json
{
  "mcpServers": {
    "deepwiki": {
      "url": "https://mcp.deepwiki.com/mcp",
      "auth": false,
      "loggableArgs": ["repoName"]
    }
  }
}
```

Authenticated servers use `auth: bearer` with a `bearerTokenEnv` variable mapped from secrets. If a server the reviewer actually calls fails, the review is vetoed rather than posting a potentially incomplete result — except DeepWiki reporting a repo isn't indexed (normal for private repos), which posts with a warning.

`loggableArgs` names the arguments whose values may appear in the logs — the argument that carries a repository identifier, for instance. The declaration is the authorization: the values it covers are disclosed as-is once they are shaped like an identifier (`owner/name`), private repository names included. Declare only arguments whose values are safe to see in a log, and keep secrets out of them.

**LSP.** Seven languages have built-in servers, each with interchangeable candidates: Python (`ty` → `pyrefly` → `pyright`), TypeScript (`tsrs` → `tsc-rs` → `typescript-language-server`), Markdown (`markdown-oxide`), Rust (`rust-analyzer`), TOML (`taplo`), Go (`gopls`), Kotlin (`kotlin-lsp`). Exactly one built-in server runs per language — the installed candidate that covers the most changed files, the built-in order breaking ties — so having any one of them installed is enough, and two built-in servers never report on the same file. Naming ids in `lsp-servers` pins that language to those candidates and leaves the other languages on their own preference order; `none` disables LSP entirely. The selection is correctness-oriented (type errors, broken references) — diagnostics are breakage signal, not style findings. Custom servers or per-candidate overrides go in a pi-lsp `{ version: 1, servers: [...] }` JSON file set via `lsp-config-file`, also read from the default branch: a candidate id configures that server (`enabled: false` drops it, so the language falls back to the next candidate), a language id (`python`) with `enabled: false` switches the language off. Both inputs apply to CI comment reviews only.

**Search budgets.** Regular search: 3 queries, 5 results each, 8s per request. AI search: 1 query, 5 sources, 15s. Package registry lookup (PyPI, Maven Central, crates.io, npm, Go proxy) is default-on in CI comment reviews with no opt-out: 5 lookups per review, 8s each, 15s total. GitHub research (`gh`-backed, also default-on; `gh: 'false'` disables) is bounded to 8 dispatched `gh` subprocesses and 15s of cumulative `gh` wait time, defaulting to public scope (`github-scope: token-accessible` allows token-readable resources). The request budget counts dispatched subprocesses, not GitHub API calls: a repository visibility probe and a failed attempt each cost one, and the three research tools share the budget. The time budget measures time spent waiting on `gh`, so the time the model spends thinking does not consume it. All external results are untrusted.

**GitHub research reads.** `github_read` covers `file`, `pull_request`, `issue`, `discussion`, `run`, `workflow`, `release`, `repository`, `diff`, and `checks` — `checks` is the kind that reports a pull request's CI. A file read takes an optional `ref` (branch, tag, or commit SHA) and returns a bounded preview; a diff and a run log are truncated the same way. A read that fails is reported as an error result, not as a successful one carrying an error message.

**URL reader.** `url_read` fetches one public https page and returns its text. It is off by default and enabled with `url-reader: 'true'`; it is the only tool that can reach an arbitrary host, so the switch is deliberate. It is a reader, not a browser: it opens no link the page contains, runs no script, and never authenticates. It sends a fixed header set and no credential — the action's GitHub token is never attached, and no cookie jar exists — so a fetched page cannot read the action's credentials. The location must be https, carry no credentials, and resolve to a public address; private, loopback, link-local, unique-local, and reserved ranges are refused, including the transition mechanisms that carry an IPv4 address in their prefix (the IPv4-compatible `::a.b.c.d` form, 6to4, Teredo, and both standardized NAT64 prefixes). A network-specific NAT64 prefix is operator-defined and cannot be enumerated, so a runner whose network resolves names through DNS64 needs an egress policy of its own. The socket is bound to the address the reader checked rather than resolving the hostname a second time, so a host that answers one address publicly and another privately cannot slip through. Redirects are followed by hand, at most three hops, each re-checked against the same rules before it is contacted. Only text content types are returned, and the byte cap applies to the decoded content so an encoding cannot smuggle a document past it. Budgets: 8 requests per run (a redirect hop counts as one), 128KiB of decoded content in total, 64KiB per document, 16KiB handed to the model, 10s per fetch, 2 concurrent fetches. A refused or failed read is an error the model recovers from, never a run failure. Everything it returns is untrusted content.

**Code execution.** Backends: `bubblewrap` (Linux), Apple Container (macOS arm64, needs a pre-pulled `code-exec-image` with your toolchains), MXC process containers (Windows 11); anywhere else fails closed. Budgets: 5 calls per review, 2min per command, 6min total. Two self-hosted failure signatures: `bwrap: Failed to make / slave` means the container's security profile denies mounts (needs a pod-level AppArmor/seccomp profile); `bwrap: loopback: Failed RTM_NEWADDR` means unprivileged user namespaces are restricted (relax `kernel.apparmor_restrict_unprivileged_userns` or load the `bwrap-userns-restrict` profile). GitHub-hosted runners are handled automatically.

**Bot identity.** Comments post as `github-actions[bot]` by default. For a custom bot name, create a GitHub App (Contents read+write, Pull requests + Issues write, no webhook), install it, and mint the token with `actions/create-github-app-token`:

```yaml
      - uses: actions/create-github-app-token@v3
        id: bot-token
        with:
          client-id: ${{ secrets.PI_REVIEWER_CLIENT_ID }}
          private-key: ${{ secrets.PI_REVIEWER_PK }}
          permission-contents: write
          permission-pull-requests: write
          permission-issues: write
      - uses: esafak/pi-reviewer@v1
        with:
          github-token: ${{ steps.bot-token.outputs.token }}
          pi-api-key: ${{ secrets.PI_API_KEY }}
          model: openai/gpt-6-luna
```

## Inputs

Mirrors [`action.yml`](./action.yml) — the action is source of truth if they differ.

| Input | Default | What it does |
|---|---|---|
| `github-token` | _(required)_ | Token to post comments; bounds GitHub research |
| `model` | _(required)_ | Model in `provider/modelId` format |
| `pi-api-key` | `PI_API_KEY` fallback | Explicit key, overriding provider env vars |
| `thinking` | `off` | Thinking budget: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `debug` | `false` | Log tool calls; upload thinking trace as a 1-day artifact |
| `min-severity` | `info` | `info` reports everything, `warn` skips nits, `critical` only blockers |
| `mode` | `review` | `review` reviews the diff; `dependency` analyzes the pull request's dependency upgrades |
| `max-diff-chars` | model-derived (100k floor) | Explicit diff cap; whole file sections drop, never mid-hunk |
| `summary` | `true` | Collapsed What/Why/Risks on the first review |
| `doc-dirs` | off | Comma-separated dirs for matching project docs |
| `skills-dirs` | `.pi/skills,.claude/skills,.agents/skills,skills` | Skill dirs for review guidance; `none` disables |
| `extra-instructions` | off | Maintainer focus notes, appended verbatim |
| `mcp-config-file` | off | MCP JSON config path, read from the default branch |
| `lsp-servers` | all languages, best changed-file coverage | Pin a language's server, or `none` to disable semantic context |
| `lsp-config-file` | off | LSP JSON overrides, read from the default branch |
| `web-search` | `false` | Regular web search for current public facts |
| `search-provider` | — | `exa`, `brave`, or `duckduckgo` (no fallback) |
| `ai-search` | `false` | Provider-grounded AI search |
| `ai-search-provider` | — | `exa` or `brave` |
| `github-scope` | `public` | Or `token-accessible` for token-readable resources |
| `url-reader` | `false` | Bounded URL reader (`url_read`): reads one public https page and returns its text |
| `gh` | `true` | Read-only `gh`-backed GitHub research tools |
| `setup-gh` | `true` | Install GitHub CLI on Linux when absent |
| `search-max-queries` | `3` | Regular query budget (1–10) |
| `ai-search-max-queries` | `1` | AI query budget (1–3) |
| `search-max-results` | `5` | Regular results per query |
| `ai-search-max-sources` | `5` | AI sources per answer |
| `search-timeout-ms` | `8000` | Per-request regular search timeout |
| `ai-search-timeout-ms` | `15000` | Per-request AI search timeout |
| `registry-wall-time-budget-ms` | `15000` | Total package-registry lookup budget (1s–120s) |
| `search-required` | `false` | Fail instead of warn when regular search fails |
| `ai-search-required` | `false` | Fail instead of warn when AI search fails |
| `code-exec` | `false` | Sandboxed `code_exec` for tests/typechecks |
| `code-exec-timeout-ms` | `120000` | Per-command timeout (1s–120s) |
| `code-exec-max-calls` | `5` | Max calls per review (1–10) |
| `code-exec-wall-time-budget-ms` | `360000` | Total exec budget (30s–1200s) |
| `code-exec-max-stream-bytes` | `32768` | Per-stream stdout/stderr cap (1KiB–128KiB) |
| `code-exec-image` | — | Pre-pulled Linux image for macOS Apple Container backend |
| `review-drafts` | `false` | Review draft PRs |
| `setup-node` | `true` | Set up Node 24 when no compatible Node is on `PATH` |
| `cache` | `true` | Cache the pnpm store across runs |
