import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

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
    expect(action).toContain("if [ -f .git/shallow ]; then");
    expect(action).toContain("git fetch --unshallow --no-tags origin");
    expect(action.indexOf("- name: Ensure review history")).toBeLessThan(
      action.indexOf("- name: Run review"),
    );
  });
});
