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

  it("fetches full git history before resolving review SHAs", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");

    expect(action).toContain("- name: Ensure review history");
    expect(action).toContain("working-directory: ${{ github.workspace }}");
    expect(action).toContain("GITHUB_TOKEN: ${{ inputs.github-token }}");
    expect(action).toContain("if [ -f .git/shallow ]; then");
    expect(action).toContain("http.https://github.com/.extraheader");
    expect(action).toContain('http.https://github.com/.extraheader="');
    expect(action).toMatch(/fetch --unshallow --no-tags\s+origin/);
    expect(action.indexOf("- name: Ensure review history")).toBeLessThan(
      action.indexOf("- name: Run review"),
    );
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

  it("maps GitHub research action inputs to the CI environment", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(action).toContain("PI_REVIEWER_GITHUB_RESEARCH: ${{ inputs.github-research }}");
    expect(action).toContain(
      "PI_REVIEWER_GITHUB_SCOPE: ${{ inputs.github-scope || env.PI_REVIEWER_GITHUB_SCOPE }}",
    );
  });

  it("keeps the action manifest valid YAML", async () => {
    const action = await readFile(path.join(process.cwd(), "action.yml"), "utf8");
    expect(() => YAML.parse(action)).not.toThrow();
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
