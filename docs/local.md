# Local extension

Same reviewer inside the [pi](https://github.com/mariozechner/pi) TUI as a `/review` command.
CI users can stop here — this file is only for local, SSH, and UI workflows.

---
## Modes

Runs inside the [pi](https://github.com/mariozechner/pi) TUI as a `/review` command. The agent reviews your diff and returns structured findings — you decide what to do with them.

### Local mode

The default. Fetches the diff and your project conventions locally, spawns a pi subprocess to run the review, then saves the result to `pi-review.md`.

```
/review
/review --branch dev
/review --pr 42
/review --diff HEAD~1
```

### SSH mode (`--ssh`)

For reviewing code on a remote machine. Instead of spawning a subprocess, SSH mode runs directly inside the current pi agent session — which already has SSH bash tool access to the remote. No local git access needed. Requires an SSH extension (e.g. [ssh.ts](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/ssh.ts)) to be active.

```
/review --ssh
/review --ssh --pr 42
/review --ssh --branch dev
```

Before starting the agent, pi-reviewer fetches the diff over SSH, then `AGENTS.md` / `CLAUDE.md`, `REVIEW.md`, and any context provider files for the touched directories. The diff is passed directly to the agent — no extra round-trip needed. The agent saves `pi-review.md` directly on the remote.

> **Note:** `--model` and `--thinking` have no effect in SSH mode — the model is fixed to whatever the parent session is using.

### MCP context sources

The reviewer does not include provider-specific MCP integrations. To use DeepWiki or another MCP server locally, install [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) in Pi and add the server to your adapter config (`~/.pi/agent/mcp-adapter.json` for every project, or `.pi/mcp-adapter.json` for one project). For example, the public DeepWiki server requires no authentication:

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

MCP results are external, untrusted reference data. In CI, use the `mcp-config-file` action input instead; see [CI.md](../CI.md).

### UI mode (`--ui`)

Opens a local browser-based review interface after the agent finishes. Inspect each finding against the diff, decide per-comment (accept / reject / discuss), then click **Finish review** to save decisions to `pi-review.md`, send accepted findings to the agent, or both. Works with `--ssh` too.

![pi-reviewer demo](./demo.gif)

```
/review --ui
/review --ssh --ui
```

Theme, view mode, default model, and thinking level are remembered across reviews and can be changed from the settings panel inside the UI.

---

---

## Options and configuration

### Extension options

Install the extension once:

```bash
pi install https://github.com/esafak/pi-reviewer
```

Then inside the pi TUI:

| Option | Description | Example |
|---|---|---|
| `--branch <name>` | Compare against this branch (default: auto-detected from `origin/HEAD`) | `--branch origin/dev` |
| `--pr <number>` | Fetch and review a specific PR diff via `gh` CLI | `--pr 42` |
| `--diff <ref>` | Review changes since a specific git ref | `--diff HEAD~1` |
| `--ssh` | SSH mode: agent fetches diff and conventions on the remote | `--ssh` |
| `--ui` | Open browser review UI after the agent finishes | `--ui` |
| `--min-severity <level>` | Only report issues at this level and above: `info`, `warn`, or `critical` | `--min-severity warn` |
| `--model <id>` | Model for this review in `provider/id` format. **Local mode only.** | `--model openai/gpt-4o` |
| `--thinking <level>` | Thinking budget: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. **Local mode only.** | `--thinking low` |
| `--dir <path>` | Run the review in a subdirectory (e.g. a package in a monorepo). Context files are loaded from the sub-project and all ancestor directories up to the repo root. | `--dir packages/api` |
| `--verbose` | Print full agent output to the console | |
| `--dry-run` | Print the diff and prompt without calling the agent | |

For CI, a review with nothing to publish leaves a thumbs-up reaction on the
pull request instead of posting a comment — but only when the pull request has
no open findings; otherwise it records the reviewed range and stays silent.
There is no opt-out.

`--model` and `--thinking` apply to the current run only. To change the permanent default, use the settings panel in `--ui` or edit `~/.pi/pi-reviewer/config.json` directly.

### Configuration

Persistent settings are stored in `~/.pi/pi-reviewer/config.json`. All fields are optional:

```json
{
  "theme": "dark",
  "viewMode": "split",
  "model": "anthropic/claude-sonnet-4-6",
  "thinking": "low",
  "minSeverity": "INFO",
  "branch": "origin/develop",
  "autoCollapseViewed": false,
  "verbose": false
}
```

| Field | Values | Default | How to set |
|---|---|---|---|
| `theme` | `"dark"` \| `"light"` | `"dark"` | Settings panel in `--ui` |
| `viewMode` | `"split"` \| `"unified"` | `"split"` | Settings panel in `--ui` |
| `model` | `"provider/id"` string | _(parent session's model)_ | Settings panel or edit directly |
| `thinking` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | _(parent session's level)_ | Settings panel or edit directly |
| `minSeverity` | `"INFO"` \| `"WARN"` \| `"CRITICAL"` | `"INFO"` | Edit directly |
| `branch` | any branch name | _(auto-detected from `origin/HEAD`)_ | Edit directly |
| `autoCollapseViewed` | `true` \| `false` | `false` | Settings panel in `--ui` |
| `verbose` | `true` \| `false` | `false` | Edit directly |

**`minSeverity`** — `"INFO"` reports everything; `"WARN"` skips informational notes; `"CRITICAL"` only surfaces blockers. The `--min-severity` flag uses lowercase, the config file uses uppercase.

**`branch`** — use the `origin/<name>` form (e.g. `"origin/develop"`) rather than a bare branch name. This ensures `git merge-base` diffs against the last pushed state, avoiding an empty diff when you're already on that branch.

### Diff coverage

`/review` and `--branch` use `git merge-base` to diff from where your branch diverged — committed changes, staged files, and unstaged edits are all included. You don't need to commit before reviewing.

`--diff` and `--pr` use the exact ref or remote diff as-is.

### Diff size handling

pi-reviewer automatically filters out noise files (lockfiles, `dist/`, `build/`, `.next/`, `node_modules/`, minified files, `.d.ts` files). If the remaining diff still exceeds the cap, whole file sections are dropped — never mid-hunk — and the posted review carries a harness-rendered `> [!WARNING]` callout naming the shortfall, with the skipped paths in a collapsible list. The agent is also told which files were skipped so the summary stays consistent.

```
⚠ 1 noise file excluded (package-lock.json) — 2 files skipped — diff exceeded 100,000 chars (src/big.ts, src/huge.ts)
```

The cap defaults to the execution model's context window minus the assembled system prompt and tool/output headroom, clamped between the 100k-character floor and a 500k derived ceiling that bounds surprise cost on huge-context models. Unknown or custom models fall back to 100k. Set an explicit cap when the default doesn't fit — e.g. to include more of a large PR on a big model, or to fit a small one:

- `/review --max-diff-chars 250000`
- `~/.pi/pi-reviewer/config.json`: `{ "maxDiffChars": 250000 }`
- Env: `PI_REVIEWER_MAX_DIFF_CHARS=250000` (also the `max-diff-chars` CI action input, which falls back to an inherited env value when unset)

Precedence: flag/option > env `PI_REVIEWER_MAX_DIFF_CHARS` > config file `maxDiffChars` > model-derived default. An explicit value is honored verbatim — it may sit below the 100k floor or above the derived ceiling, so small models can still overflow on a heavy prompt; lower the cap for them.

`--ssh` runs inject the prompt into your live session, whose prior history also consumes context but is not measured — keep sessions short or lower the cap when an SSH review fails on context length. (Local `/review` runs spawn a fresh `pi --no-session` process, so only the assembled prompt counts there.)

### Project conventions

Create `AGENTS.md` or `CLAUDE.md` at your project root to give the reviewer context about your conventions. `REVIEW.md` is always loaded alongside it for review-specific rules.

- `AGENTS.md` is checked first; `CLAUDE.md` is the fallback. Matched case-insensitively.
- Files can also live in `.pi/`, `.claude/`, or `.agents/` subdirectories.
- **Monorepo support:** pi-reviewer walks up from the working directory to the git root and collects `AGENTS.md`/`REVIEW.md` at every level, root first. `--dir` extends the walk-up to the outer project root.
- **Touched directories:** files under review also contribute their parent chains up to the git root, deduped against the base chain, so nested conventions travel with the diff.

### Context providers

Any pi extension can inject additional context into the review prompt by listening on the `"pi-reviewer:collect-context-providers"` event — providers receive the changed files and a filesystem abstraction (works locally and over SSH) and return `{ path, content }` pairs appended to the system prompt.

**[pi-reviewer-doc-context](../extensions/pi-reviewer-doc-context/README.md)** is the built-in provider. It scans your project's doc dirs for `.md` files with a `description` frontmatter field and loads the ones relevant to the current diff. See its README for the doc format, configuration, and the full provider API.

### CI-only tools

Web search, AI search, GitHub research, package lookup, and sandboxed code execution are CI-only — see [CI.md](../CI.md).
