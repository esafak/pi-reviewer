# GitHub research payload fixtures

These are real `gh` responses, captured once, for the contract tests in
`tests/ci/github-research-contract.test.ts`. They exist because the
exact-argv tests only prove *which command* the tool builds; they cannot
prove that the client understands the *shape* of what the command returns.

## What is here

| file | what it is |
|---|---|
| `manifest.json` | per capture: the argv, the exit code, the stdout file, any stderr, and the capture date |
| `pr-view` | `gh pr view` — a pull request without comments |
| `pr-view-comments` | `gh pr view` with comments |
| `issue-view` | `gh issue view` |
| `issue-view-comments` | `gh issue view` with comments |
| `discussion` | `gh api repos/…/discussions/…` |
| `run-view` | `gh run view --json` |
| `run-log` | `gh run view --log` — a real CI log, and the largest capture |
| `run-exit-status` | `gh run view --exit-status --json` — exits 0, because the JSON form reports the failure in the payload |
| `run-log-exit-status` | `gh run view --log --exit-status` — exits 1, and is the only combination the transport sees that does; its stdout is the same log, so it shares the payload file |
| `workflow` | `gh api repos/…/actions/workflows/…` |
| `release` | `gh api repos/…/releases/…` |
| `repo-view` | `gh repo view` |
| `pr-diff` | `gh pr diff` — a real pull request diff |
| `pr-diff-names` | `gh pr diff --name-only` |
| `pr-checks` | `gh pr checks --json` |
| `file-contents` | `gh api repos/…/contents/…` — a file, base64 encoded |

Each payload file is byte-for-byte what `gh` printed. The manifest records
the command as the array it was run with, so a reviewer can re-run any
capture and compare.

## Capturing them again

```sh
scripts/capture-github-research-fixtures.sh
```

The script needs `gh` authenticated with read access to the repository. It
overwrites the payloads and the manifest in place, so a re-capture shows up
as a normal diff. Every entry records the date and time it was captured.

## Provenance

| | |
|---|---|
| CLI | `gh` 2.102.0 (2026-09-30) |
| repository | `esafak/pi-reviewer` — the repository this action reviews |
| pull request | 169 |
| issue | 4 |
| run | 39367612741 — a failed run, so the log and the nonzero exit are real |
| workflow | 347788971 |
| release | the numeric id of v1.0.0 — the client reads a release by id, not by tag |
| discussion | `cli/cli` discussion 2618 — the only capture from another repository |

## Sanitization

One capture comes from another repository: the discussion, because
`esafak/pi-reviewer` has discussions enabled but none. Its title, body, and
author are replaced with placeholders, so no other project's words are
committed here. The replacements keep the types the projection produces —
the author is a string, because the projection is `user:.user.login` — and
the field names, which is what the contract tests assert.

Everything else is this repository's own public content, kept verbatim:
it is exactly what the tool reads in production, and the assertions are
about shape rather than content.

## Limits of this approach

The fixtures pin the CLI's behavior at capture time. They cannot detect the
CLI changing underneath us afterwards; that needs a deliberate re-capture or
a live smoke test, and neither is in scope here.
