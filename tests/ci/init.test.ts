import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import YAML from "yaml";

import { init } from "../../src/ci/init.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-init-"));
  createdDirs.push(dir);
  return dir;
}

/** A parsed YAML mapping, or a failure naming what was not one. */
function asMapping(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is not a mapping`);
  return value as Record<string, unknown>;
}

/**
 * The generated dependency job, as it parses once its comment markers are
 * removed.
 *
 * The job ships commented so it cannot run until a user enables it; the point
 * of parsing the uncommented form is that a wrong indentation, a moved key, or
 * an input on the wrong step still has to be a valid workflow.
 */
function dependencyJobOf(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === "#   dependency:");
  if (start === -1) throw new Error("the generated workflow has no dependency job");
  const job = lines.slice(start);
  const uncommented = [...lines.slice(0, start), ...job.map((line) => line.replace(/^# ?/, ""))];
  const document = asMapping(YAML.parse(uncommented.join("\n")) as unknown, "the workflow");
  return asMapping(asMapping(document.jobs, "jobs").dependency, "jobs.dependency");
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
    expect(content).toContain(
      "if: ${{ (github.event_name != 'pull_request_review_comment' || github.event.comment.user.type != 'Bot') && (github.event_name != 'issue_comment' || github.event.comment.user.type != 'Bot') && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && (github.event_name != 'pull_request' || github.event.pull_request.user.login != 'renovate[bot]') && (github.event_name != 'pull_request_review_comment' || github.event.pull_request.user.login != 'renovate[bot]') && (github.event_name != 'issue_comment' || github.event.issue.user.login != 'renovate[bot]') }}",
    );
    expect(content.match(/^\s*if:/gm)).toHaveLength(1);
    expect(content).toContain("issue_comment:");
    expect(content).toContain("fetch-depth: 0");
    expect(content).toContain("persist-credentials: false");
    expect(content).not.toContain("Fetch PR refs for comment and manual events");
    expect(content).toContain("cancel-in-progress: false");
    expect(content).toContain("contents: read");
    expect(content).toContain("pull-requests: write");
    expect(content).toContain("issues: write");
    expect(content).not.toContain("reactions: write");
    expect(content).not.toContain("react-on-no-findings");
    expect(content).toContain("review-drafts: 'false'");
    expect(content).toContain("# mode: 'dependency'");
    expect(content).toContain("# url-reader: 'true'");
  });

  it("generates the commented dependency job without the renovate exclusion", async () => {
    const dir = await createTempDir();

    await init({ cwd: dir });

    const workflowPath = path.join(dir, ".github", "workflows", "pi-review.yml");
    const content = await readFile(workflowPath, "utf-8");
    // Inert: every line from the job key on is a comment, so the job cannot run
    // until the indented lines are uncommented.
    const block = content.slice(content.indexOf("\n#   dependency:") + 1).split("\n");
    expect(block.length).toBeGreaterThan(1);
    expect(
      block.filter((line) => line.trim().length > 0).every((line) => line.startsWith("#")),
    ).toBe(true);

    const job = dependencyJobOf(content);
    expect(job.if).toBeTypeOf("string");
    // The dependency job exists for Renovate bumps, so its condition must not
    // exclude them the way the review job's does — but it does still require a
    // same-repository pull request head.
    expect(job.if).toContain("pull_request");
    expect(job.if).toContain("github.repository");
    expect(job.if).not.toContain("renovate");

    const permissions = asMapping(job.permissions, "jobs.dependency.permissions");
    expect(permissions["checks"]).toBe("write");
    expect(permissions["pull-requests"]).toBe("write");
    expect(permissions["contents"]).toBe("read");

    const concurrency = asMapping(job.concurrency, "jobs.dependency.concurrency");
    expect(concurrency["group"]).toMatch(/^pi-reviewer-dependency-/);
    expect(concurrency["cancel-in-progress"]).toBe(false);

    const steps = job.steps;
    expect(Array.isArray(steps)).toBe(true);
    const stepList = steps as unknown[];
    expect(stepList).toHaveLength(2);
    const reviewStep = asMapping(stepList[1], "jobs.dependency.steps[1]");
    const inputs = asMapping(reviewStep.with, "jobs.dependency.steps[1].with");
    expect(inputs["mode"]).toBe("dependency");
    expect(inputs["url-reader"]).toBe("true");
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
