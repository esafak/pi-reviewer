import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface InitOptions {
  cwd?: string;
  reviewDrafts?: boolean;
}

const WORKFLOW_RELATIVE_PATH = path.join(".github", "workflows", "pi-review.yml");

function workflowContent(reviewDrafts = false): string {
  return `name: Pi Reviewer

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
    if: \${{ (github.event_name != 'pull_request_review_comment' || github.event.comment.user.type != 'Bot') && (github.event_name != 'issue_comment' || github.event.comment.user.type != 'Bot') && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && (github.event_name != 'pull_request' || github.event.pull_request.user.login != 'renovate[bot]') && (github.event_name != 'pull_request_review_comment' || github.event.pull_request.user.login != 'renovate[bot]') && (github.event_name != 'issue_comment' || github.event.issue.user.login != 'renovate[bot]') }}
    permissions:
      contents: read
      pull-requests: write
      issues: write # Required to post comments and reactions.

    concurrency:
      group: pi-reviewer-\${{ github.repository }}-\${{ github.event.pull_request.number || github.event.issue.number || inputs.pr-number || github.run_id }}
      cancel-in-progress: false

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: \${{ github.event.pull_request.head.sha || github.sha }}

      - uses: esafak/pi-reviewer@main
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
          pi-api-key: \${{ secrets.PI_API_KEY }}
          model: openrouter/openai/gpt-5.4-mini
          thinking: off
          min-severity: \${{ inputs.min-severity || 'info' }}
          review-drafts: '${reviewDrafts ? "true" : "false"}'
          # summary: 'false' # opt out of PR summaries (enabled by default)
          # extra-instructions: |
          #   Focus on API boundary errors and missing rollback paths.
          #   Ignore naming nits in test fixtures.
          # Optional workflow_dispatch inputs:
          # pr-number: 123
          # target-head: <ancestor SHA>
          # Opt in to injecting matching project docs into the review.
          # Comma-separated dirs scanned for .md files with a 'description' frontmatter.
          # doc-dirs: '.pi/notes,docs/review'
          # Skills load by default from .pi/skills,.claude/skills,.agents/skills,skills;
          # override with a comma-separated list, or 'none' to disable.
          # New/modified skills are reviewed as untrusted changes rather than followed.
          # skills-dirs: '.pi/skills,docs/skills'
          # web-search: 'true' # optional
          # search-provider: 'brave' # optional
          # ai-search: 'true' # optional
          # ai-search-provider: 'brave' # optional
          # gh: 'false' # optional: disable gh-backed GitHub research
          # github-scope: 'public' # or 'token-accessible'; defaults to public
          # mode: 'dependency' # optional: check dependency upgrades instead of the diff.
          #   This job skips renovate[bot] pull requests; the commented
          #   \`dependency\` job at the end of this file is the one that runs
          #   for those bumps.
          # url-reader: 'true' # optional: read release notes from upstreams that are
          #   not on GitHub; off by default because it is the only tool that can
          #   reach an arbitrary host.
          # code-exec: 'true' # optional, sandboxed offline code execution (code_exec)
          # code-exec-timeout-ms: '120000' # per-command timeout
          # code-exec-max-calls: '5' # calls per review
          # code-exec-wall-time-budget-ms: '360000' # total exec wall-clock budget
          # code-exec-max-stream-bytes: '32768' # per-stream stdout/stderr cap
          # code-exec-image: '...' # macOS Apple Container image (pre-pulled)

# Dependency breaking-change check. Uncomment the indented lines below to
# analyze the pull request's upgrade manifests instead of the diff, and to
# publish a \`pi-reviewer/breaking-changes\` check run. It is a separate job
# because it must run for the pull requests the review job skips —
# renovate[bot] above all — and because it needs \`checks: write\`.
#
# Require the check run's name (pi-reviewer/breaking-changes) in branch
# protection, not this job's name: the job succeeds whenever the action
# exits cleanly, so requiring only the job would never gate on the analysis.
# See CI.md for the gate, the thresholds, and the supported manifests.
#
#   dependency:
#     runs-on: ubuntu-latest
#     if: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository }}
#     permissions:
#       contents: read
#       pull-requests: write
#       issues: write # Required to post comments and reactions.
#       checks: write # Required to publish the check run; a classic PAT cannot.
#     concurrency:
#       # Its own group: the review job's group has no job or mode component.
#       group: pi-reviewer-dependency-\${{ github.repository }}-\${{ github.event.pull_request.number }}
#       cancel-in-progress: false
#     steps:
#       - uses: actions/checkout@v4
#         with:
#           fetch-depth: 0
#           persist-credentials: false
#           ref: \${{ github.event.pull_request.head.sha || github.sha }}
#       - uses: esafak/pi-reviewer@main
#         with:
#           github-token: \${{ secrets.GITHUB_TOKEN }}
#           pi-api-key: \${{ secrets.PI_API_KEY }}
#           model: openrouter/openai/gpt-5.4-mini
#           mode: 'dependency'
#           # Off by default: the bounded URL reader is the only tool that can
#           # reach an arbitrary host. Without it only GitHub upstreams are read,
#           # and every other upgrade is reported as unverifiable.
#           url-reader: 'true'

`;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const workflowPath = path.join(cwd, WORKFLOW_RELATIVE_PATH);

  if (existsSync(workflowPath)) {
    console.log("pi-review.yml already exists. Skipping.");
    return;
  }

  mkdirSync(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, workflowContent(options.reviewDrafts), "utf-8");

  console.log("✓ Created .github/workflows/pi-review.yml");
  console.log("");
  console.log("Next step: add your project conventions to AGENTS.md at the root of your project.");
  console.log(
    "This file will be used by the reviewer to understand your project's rules and patterns.",
  );
}
