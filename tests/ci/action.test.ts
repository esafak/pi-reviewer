import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

describe("GitHub Action Vite+ setup", () => {
  it("uses a gated executable temp directory for setup-vp", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");

    expect(action).toContain("id: executable-temp");
    expect(action).toContain("if: ${{ steps.toolchain.outputs.vite_plus_ready != 'true' }}");
    expect(action).toContain("TMPDIR: ${{ steps.executable-temp.outputs.path }}");
    expect(action).toContain("VP_HOME: ${{ steps.executable-temp.outputs.path }}");
    expect(action).toContain('tmpdir=$(mktemp -d "$base/pi-reviewer-XXXXXX")');
    expect(action).toContain("if: ${{ always() && steps.executable-temp.outputs.path != '' }}");
    expect(action).toContain('rm -rf -- "${{ steps.executable-temp.outputs.path }}"');
  });

  it("fetches targeted review history and only unshallows as a fallback", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    const entry = await readFile(path.join(process.cwd(), "src/ci/action-entry.ts"), "utf8");

    expect(action).not.toContain("Ensure review history");
    expect(action).not.toContain("fetch --unshallow");
    expect(entry).toContain("ensureCommit(latest.toSha, undefined)");
    expect(entry).toContain("ensureCommit(head, `refs/pull/${pullRequestNumber}/head`)");
    expect(entry).toContain("ensureCommit(pullRequest.base.sha, undefined)");
    expect(entry).toContain("--is-shallow-repository");
    expect(entry).toContain("if (isShallowRepository())");
    expect(entry).toContain("review.marker_history.unavailable");
    expect(entry).toContain('"fetch", "--unshallow", "--no-tags", "origin"');
  });

  it("allows provider selection through caller environment when inputs are omitted", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");

    expect(action).toContain(
      "PI_REVIEWER_SEARCH_PROVIDER: ${{ inputs.search-provider || env.PI_REVIEWER_SEARCH_PROVIDER }}",
    );
    expect(action).toContain(
      "PI_REVIEWER_AI_SEARCH_PROVIDER: ${{ inputs.ai-search-provider || env.PI_REVIEWER_AI_SEARCH_PROVIDER }}",
    );
  });

  it("maps GitHub research scope and enablement action inputs to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("PI_REVIEWER_GH: ${{ inputs.gh }}");
    expect(action).toContain(
      "PI_REVIEWER_GITHUB_SCOPE: ${{ inputs.github-scope || env.PI_REVIEWER_GITHUB_SCOPE }}",
    );
  });

  it("enables read-only gh by default and probes installation separately", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("gh:");
    expect(action).toContain('default: "true"');
    expect(action).toContain("PI_REVIEWER_GH: ${{ inputs.gh }}");
    expect(action).toContain("if: ${{ inputs.setup-gh == 'true' && inputs.gh == 'true' }}");
    expect(action).not.toContain("PI_REVIEWER_SETUP_GH");
    expect(action).toContain("command -v gh");
  });

  it("maps the package registry wall-time budget input to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("registry-wall-time-budget-ms:");
    expect(action).toContain('default: "15000"');
    expect(action).toContain(
      "PI_REVIEWER_REGISTRY_WALL_TIME_BUDGET_MS: ${{ inputs.registry-wall-time-budget-ms }}",
    );
  });

  it("maps the renamed code-exec inputs and installer gate", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    for (const input of [
      "code-exec",
      "code-exec-timeout-ms",
      "code-exec-max-calls",
      "code-exec-wall-time-budget-ms",
      "code-exec-max-stream-bytes",
      "code-exec-image",
    ])
      expect(action).toContain(`${input}:`);
    expect(action).toContain("PI_REVIEWER_CODE_EXEC: ${{ inputs.code-exec }}");
    expect(action).toContain(
      "PI_REVIEWER_CODE_EXEC_TIMEOUT_MS: ${{ inputs.code-exec-timeout-ms }}",
    );
    expect(action).toContain("inputs.code-exec == 'true'");
    expect(action).not.toContain("inputs.exec");
  });

  it("maps the optional MCP config path to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("mcp-config-file:");
    expect(action).toContain("PI_REVIEWER_MCP_CONFIG_FILE: ${{ inputs.mcp-config-file }}");
    expect(action).not.toContain("PI_REVIEWER_DEEPWIKI");
    expect(action).not.toMatch(/^  deepwiki:/m);
  });

  it("maps the opt-in debug input to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("PI_REVIEWER_DEBUG: ${{ inputs.debug }}");
    expect(action).toContain(
      "PI_REVIEWER_THINKING_ARTIFACT: ${{ runner.temp }}/pi-reviewer-thinking.jsonl",
    );
    expect(action).toContain("name: Upload model thinking artifact");
    expect(action).toContain("retention-days: 1");
    expect(action).toContain('default: "false"');
  });

  it("loads MCP config from the repository default branch", async () => {
    const entry = await readFile(path.join(process.cwd(), "src/ci/action-entry.ts"), "utf8");
    expect(entry).toContain("PI_REVIEWER_MCP_CONFIG_FILE");
    expect(entry).toContain("resolveDefaultBranchSha(");
    expect(entry).toContain("loadMcpConfigFromBase(process.cwd(), trustedDefaultBranchSha");
    expect(entry).toContain("trustedMcpWorktree");
    expect(entry).toContain("mcpConfig,");
  });

  it("maps the default-on summary input to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("  summary:");
    expect(action).toContain('default: "true"');
    expect(action).toContain("PI_REVIEWER_SUMMARY: ${{ inputs.summary }}");
  });

  it("maps the extra-instructions input to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("  extra-instructions:");
    expect(action).toContain("PI_REVIEWER_EXTRA_INSTRUCTIONS: ${{ inputs.extra-instructions }}");
  });

  it("keeps the action manifest valid YAML", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(() => YAML.parse(action)).not.toThrow();
  });

  it("detects confined runtimes without pointing at host remedies", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("Failed to make / slave");
    expect(action).toContain("confined runtime detected");
    expect(action).toContain("CI.md Containerized self-hosted runners");
    expect(action).toContain("--ro-bind / / true");
    const warning =
      action.match(/\[pi-reviewer\] WARNING: confined runtime detected[^\n]*/)?.[0] ?? "";
    expect(warning).toContain("pod-level");
    expect(warning).not.toContain("sysctl");
    expect(warning).not.toContain("bwrap-userns-restrict");
    // The generic fallback must not fire on signatures the sysctl block
    // already owns (github-hosted relaxation would warn falsely).
    expect(action).toContain("grep -q 'RTM_NEWADDR'");
    expect(action).toContain("grep -qi 'permissions to create'");
    // The github-hosted sysctl relaxation stays for the bare-metal path.
    expect(action).toContain('RUNNER_ENVIRONMENT:-}" = "github-hosted"');
  });

  it("reports the nested-userns proc fallback as info without failing closed", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain('grep -q "Can\'t mount proc"');
    const info = action.match(/\[pi-reviewer\] INFO: nested user namespace[^\n]*/)?.[0] ?? "";
    expect(info).toContain("No action required");
    expect(info).not.toContain("WARNING");
    expect(info).not.toContain("fail closed");
  });

  it("keeps the checked-in UI build artifact usable by the UI template", async () => {
    const template = await readFile(path.join(process.cwd(), "src/core/ui/template.ts"), "utf8");
    const artifact = await readFile(path.join(process.cwd(), "dist-ui/index.html"), "utf8");

    expect(template).toContain('"../../../dist-ui/index.html"');
    expect(artifact).toContain("/*%%DATA%%*/null/*%%END%%*/");
  });

  // The Actions log is a pipe: a synchronous exit can drop buffered writes, so
  // the entry point must return and let Node drain stdio.
  it("does not truncate buffered output with an immediate exit", async () => {
    const entry = await readFile(path.join(process.cwd(), "src/ci/action-entry.ts"), "utf8");

    expect(entry).not.toMatch(/\bprocess\.exit\(/);
    expect(entry).toContain("process.exitCode");
  });
});

/**
 * The action entry's ordering.
 *
 * The two modes share most of the entry point, and the order of the branches
 * is what keeps them apart: a reply never creates a check run, the dependency
 * mode is the only path that creates one, and the Renovate skip belongs to the
 * review mode. The unit tests below the entry point cannot see that order, so
 * it is asserted on the source itself.
 */
describe("action entry mode dispatch", () => {
  const read = async () => readFile(path.join(process.cwd(), "src/ci/action-entry.ts"), "utf8");

  it("dispatches to one mode or the other after the shared guards", async () => {
    const entry = await read();
    expect(entry).toContain('if (mode === "dependency") await runDependencyMode(context);');
    expect(entry).toContain("else await runReviewMode(context);");
  });

  it("handles a reply before the mode branch", async () => {
    const entry = await read();
    const reply = entry.indexOf('if (event.kind === "reply")');
    const dispatch = entry.indexOf('if (mode === "dependency") await runDependencyMode');
    expect(reply).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(reply);
    // The reply branch returns, so no analysis and no check run follows it.
    expect(entry.slice(reply, dispatch)).toContain("return;");
  });

  it("skips Renovate PRs in the review mode only", async () => {
    const entry = await read();
    expect(entry).toContain('if (mode === "review" && isRenovatePullRequest(pullRequest))');
    expect(entry).not.toContain("if (isRenovatePullRequest(pullRequest)) {");
  });

  it("treats a missing pull request number as an error in the dependency mode", async () => {
    const entry = await read();
    const missing = entry.indexOf("if (!isSafePullRequestNumber(event.pr))");
    expect(entry.slice(missing, entry.indexOf("if (event.fork)", missing))).toContain(
      "The dependency mode requires a pull request number",
    );
  });

  it("rejects target-head in the dependency mode", async () => {
    const entry = await read();
    expect(entry).toContain("target-head is not supported in dependency mode");
  });

  it("creates a check run on the dependency path alone", async () => {
    const entry = await read();
    const dependencyMode = entry.slice(
      entry.indexOf("async function runDependencyMode"),
      entry.indexOf("async function runReviewMode"),
    );
    expect(dependencyMode).toContain("withDependencyCheckRun(");
    const reviewMode = entry.slice(entry.indexOf("async function runReviewMode"));
    expect(reviewMode).not.toContain("withDependencyCheckRun(");
    expect(reviewMode).not.toContain("createDependencyCheckRun(");
  });

  it("prepares the same worktree for both modes", async () => {
    const entry = await read();
    expect(entry.match(/await prepareWorktree\(/g)).toHaveLength(2);
    const dependencyMode = entry.slice(
      entry.indexOf("async function runDependencyMode"),
      entry.indexOf("async function runReviewMode"),
    );
    expect(dependencyMode).toContain("prepareCommits(");
    expect(dependencyMode).toContain("prepareWorktree(");
  });

  it("fetches the analyzed commits before any ancestry or merge decision", async () => {
    const entry = await read();
    const reviewMode = entry.slice(entry.indexOf("async function runReviewMode"));
    const commits = reviewMode.indexOf("prepareCommits(");
    expect(commits).toBeGreaterThan(-1);
    // A head that is not local makes every ancestry and merge answer describe
    // the wrong range, so the fetch precedes them all.
    for (const decision of ["isMergeCommit(head)", "rangeContainsMerge(", "selectBatchRange("])
      expect(reviewMode.indexOf(decision)).toBeGreaterThan(commits);
    // The worktree is created only for a range that will be reviewed.
    expect(reviewMode.indexOf("await prepareWorktree(")).toBeGreaterThan(
      reviewMode.indexOf("review.skipped.already_reviewed"),
    );
  });

  it("uses the authenticated head for the review's commit", async () => {
    const entry = await read();
    const flow = await readFile(path.join(process.cwd(), "src/ci/dependency-check.ts"), "utf8");
    // The head is captured once: the check run is created for it, and the
    // review is posted against it.
    expect(entry).toContain("const head = pullRequest.head.sha;");
    expect(entry).toContain("headSha: head,");
    expect(flow).toContain("commitId: options.headSha");
  });

  it("no longer calls the dependency mode unavailable", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    const docs = await readFile(path.join(process.cwd(), "CI.md"), "utf8");
    expect(action).not.toContain("not available in this build yet");
    expect(docs).not.toContain("not available in this build yet");
  });
});
