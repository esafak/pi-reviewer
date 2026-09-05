import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export interface InitOptions {
  cwd?: string;
  reviewDrafts?: boolean;
}

const WORKFLOW_RELATIVE_PATH = path.join(".github", "workflows", "pi-review.yml");

function workflowContent(reviewDrafts = false): string { return `name: Pi Reviewer

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
      issues: write # Required when react-on-no-findings is enabled.

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
          react-on-no-findings: 'true'
          # Optional workflow_dispatch inputs:
          # pr-number: 123
          # target-head: <ancestor SHA>
          # Opt in to injecting matching project docs into the review.
          # Comma-separated dirs scanned for .md files with a 'description' frontmatter.
          # doc-dirs: '.pi/notes,docs/review'
`; }

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
    "This file will be used by the reviewer to understand your project's rules and patterns."
  );
}
