#!/usr/bin/env bash
# Captures real `gh` output for the GitHub research read kinds.
#
# Each capture is stored as the raw stdout gh printed, so a reviewer can read
# exactly what the CLI returns. The manifest records the argv, the exit code,
# and any stderr, so the contract tests can replay a real response —
# including the failures — without touching the network.
#
# Usage: scripts/capture-github-research-fixtures.sh [output-dir]
set -euo pipefail

REPO="esafak/pi-reviewer"
OUT="${1:-tests/fixtures/github-research}"
PR=169
ISSUE=4
RUN=$(gh run list --repo "$REPO" --limit 50 --json databaseId,conclusion \
  --jq '[.[] | select(.conclusion == "failure")][0].databaseId // empty')
WORKFLOW=347788971
# The client reads a release by its numeric id, so the capture uses the same
# endpoint rather than the tag.
RELEASE_ID=$(gh api "repos/$REPO/releases" --jq '.[0].id')

mkdir -p "$OUT"
export OUT
# The capture date, recorded per entry.
CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export CAPTURED_AT

capture() {
  local name="$1"
  shift
  local stdout_file="$OUT/$name"
  local stderr_file="$OUT/$name.stderr"
  local code=0
  "$@" >"$stdout_file" 2>"$stderr_file" || code=$?
  record "$name" "$code" "$stdout_file" "$stderr_file" "$@"
  echo "captured $name (exit $code)"
}

# Captures a command for real and, when its stdout is identical to another
# capture, records the entry against that payload instead of a second copy.
capture_matching() {
  local name="$1"
  local alias_of="$2"
  shift 2
  local stdout_file="$OUT/$name"
  local stderr_file="$OUT/$name.stderr"
  local code=0
  "$@" >"$stdout_file" 2>"$stderr_file" || code=$?
  if cmp -s "$stdout_file" "$OUT/$alias_of"; then
    rm "$stdout_file"
    record "$name" "$code" "$OUT/$alias_of" "$stderr_file" "$@"
  else
    record "$name" "$code" "$stdout_file" "$stderr_file" "$@"
  fi
  echo "captured $name (exit $code)"
}


# The argv is recorded as the array the command was run with, so the
# manifest holds the exact command rather than a re-joined string.
record() {
  local name="$1"
  local code="$2"
  local stdout_file="$3"
  local stderr_file="$4"
  shift 4
  NAME="$name" CODE="$code" STDOUT="$stdout_file" STDERR="$stderr_file" \
    CAPTURED_AT="$CAPTURED_AT" \
    node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const manifestPath = path.join(process.env.OUT, "manifest.json");
      const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
        : {};
      manifest[process.env.NAME] = {
        argv: process.argv.slice(1),
        exitCode: Number(process.env.CODE),
        stdout: path.basename(process.env.STDOUT),
        stderr: fs.readFileSync(process.env.STDERR, "utf8"),
        capturedAt: process.env.CAPTURED_AT,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      if (process.env.STDERR !== "/dev/null") fs.rmSync(process.env.STDERR, { force: true });
    ' -- "$@"
}

capture pr-view gh pr view "$PR" --repo "$REPO" \
  --json number,title,body,state,url,headRefName,baseRefName,updatedAt,isDraft
capture pr-view-comments gh pr view "$PR" --repo "$REPO" \
  --json number,title,body,comments,state,url,headRefName,baseRefName,updatedAt,isDraft
capture issue-view gh issue view "$ISSUE" --repo "$REPO" \
  --json number,title,body,state,url,updatedAt
capture issue-view-comments gh issue view "$ISSUE" --repo "$REPO" \
  --json number,title,body,comments,state,url,updatedAt
capture discussion gh api repos/cli/cli/discussions/2618 \
  --jq '{number,title,body,html_url,created_at,updated_at,category:.category.name,user:.user.login}'
# The discussion capture is the only one from another repository, so its free
# text is replaced: the contract is the shape of the response, not another
# project's words. The projection makes `user` a string, so the replacement
# keeps it a string.
node -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  const row = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...row, title: "A discussion title", body: "A discussion body.", user: "a-user" }) +
      "\n",
  );
' "$OUT/discussion"
capture run-view gh run view "$RUN" --repo "$REPO" \
  --json databaseId,name,status,conclusion,url,headBranch,headSha
capture run-log gh run view "$RUN" --repo "$REPO" --log
capture run-exit-status gh run view "$RUN" --repo "$REPO" --exit-status \
  --json databaseId,name,status,conclusion,url,headBranch,headSha
# The log form is the combination that exits nonzero: the JSON form reports
# the failure in the payload and exits 0. It is captured for real, and the
# script checks that its stdout matches the plain log capture.
capture_matching run-log-exit-status run-log \
  gh run view "$RUN" --repo "$REPO" --log --exit-status
capture workflow gh api "repos/$REPO/actions/workflows/$WORKFLOW" \
  --jq '{id,name,state,path,url,html_url}'
capture release gh api "repos/$REPO/releases/$RELEASE_ID" \
  --jq '{tagName:.tag_name,name,isDraft:.draft,url:.html_url,publishedAt:.published_at}'
capture repo-view gh repo view "$REPO" \
  --json name,nameWithOwner,description,url,visibility,defaultBranchRef
capture pr-diff gh pr diff "$PR" --repo "$REPO"
capture pr-diff-names gh pr diff "$PR" --repo "$REPO" --name-only
capture pr-checks gh pr checks "$PR" --repo "$REPO" --json name,state,workflow
capture file-contents gh api "repos/$REPO/contents/package.json" \
  --jq '{path:.path,url:.html_url,content:.content}'

echo "done: $OUT"
