import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { init } from "../../src/ci/init.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-init-"));
  createdDirs.push(dir);
  return dir;
}

describe("init", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("generates workflow file with correct content", async () => {
    const dir = await createTempDir();

    await init({ cwd: dir });

    const workflowPath = path.join(dir, ".github", "workflows", "pi-review.yml");
    const content = await readFile(workflowPath, "utf-8");

    expect(content).toContain("types: [opened, synchronize, reopened, ready_for_review]");
    expect(content).toContain("pull_request_review_comment:\n    types: [created]");
    expect(content).toContain("if: ${{ github.event_name != 'pull_request_review_comment' || github.event.comment.user.type != 'Bot' }}");
    expect(content.match(/^\s*if:/gm)).toHaveLength(1);
    expect(content).toContain("issue_comment:");
    expect(content).toContain("fetch-depth: 0");
    expect(content).toContain("cancel-in-progress: false");
    expect(content).toContain("contents: read");
    expect(content).toContain("pull-requests: write");
    expect(content).toContain("issues: write");
    expect(content).not.toContain("reactions: write");
    expect(content).toContain("review-drafts: 'false'");
    expect(content).toContain("          react-on-no-findings: 'true'");
  });

  it("creates intermediate directories when missing", async () => {
    const dir = await createTempDir();

    await init({ cwd: dir });

    const workflowPath = path.join(dir, ".github", "workflows", "pi-review.yml");
    const content = await readFile(workflowPath, "utf-8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("skips without overwriting when file already exists", async () => {
    const dir = await createTempDir();
    const workflowPath = path.join(dir, ".github", "workflows", "pi-review.yml");

    await init({ cwd: dir });
    await writeFile(workflowPath, "custom content", "utf-8");

    await init({ cwd: dir });

    const content = await readFile(workflowPath, "utf-8");
    expect(content).toBe("custom content");
    expect(logSpy).toHaveBeenCalledWith("pi-review.yml already exists. Skipping.");
  });

  it("prints success and next-step instructions after generation", async () => {
    const dir = await createTempDir();

    await init({ cwd: dir });

    expect(logSpy).toHaveBeenCalledWith("✓ Created .github/workflows/pi-review.yml");
    expect(logSpy).toHaveBeenCalledWith(
      "Next step: add your project conventions to AGENTS.md at the root of your project.",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "This file will be used by the reviewer to understand your project's rules and patterns.",
    );
  });
});
