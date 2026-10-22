import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { detectDependencyChanges } from "../../../src/ci/dependency/detect.js";
import { resolveUpstreams } from "../../../src/ci/dependency/resolve.js";
import { upgradeId } from "../../../src/core/dependency/upgrade-id.js";
import { isBreakingRelevant } from "../../../src/core/dependency/threshold.js";
import { gitEnv } from "../../../src/core/git-env.js";

/**
 * The readers a run has. The GitHub research tools are on and the URL
 * reader is off, so a resolution is answered from the tool table alone.
 */
const githubOnly = { github: true, url: false };

describe("a tool pin, from detection to resolution", () => {
  let dir: string;

  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });
  const commit = (message: string) =>
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", message]);
  const write = async (file: string, text: string) => {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, "utf-8");
  };
  const head = () =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  const base = () =>
    execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: dir, encoding: "utf-8" }).trim();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-tools-"));
    git(["init"]);
    // The repository's automatic garbage collection runs in the background
    // and would still be writing to it when the test removes it.
    git(["config", "gc.auto", "0"]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("resolves a bare tool pin through the tool table", async () => {
    // The pin names no registry, so it is only comparable because the
    // dialect belongs to the pin rather than to a registry, and it resolves
    // only because the tool table knows the tool.
    await write("mise.toml", ["[tools]", 'python = "3.11"'].join("\n"));
    git(["add", "mise.toml"]);
    commit("init");
    await write("mise.toml", ["[tools]", 'python = "3.12"'].join("\n"));
    git(["add", "mise.toml"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    const change = detection.changes[0]!;
    expect(change).toMatchObject({
      kind: "minor",
      category: "tool",
      registry: "unknown",
      name: "python",
      manifest: "mise.toml",
    });
    // A tool breaks across minor versions, so this one is analyzed.
    expect(isBreakingRelevant(change)).toBe(true);

    const id = upgradeId(change);
    const resolutions = await resolveUpstreams(detection.changes, [id], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "python/cpython",
      via: "tool-table",
    });
  });

  it("resolves a tool pin that names a registry", async () => {
    await write("mise.toml", ["[tools]", '"core:node" = "24.1.0"'].join("\n"));
    git(["add", "mise.toml"]);
    commit("init");
    await write("mise.toml", ["[tools]", '"core:node" = "24.2.0"'].join("\n"));
    git(["add", "mise.toml"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    const change = detection.changes[0]!;
    expect(change).toMatchObject({ kind: "minor", category: "tool" });
    const resolutions = await resolveUpstreams(detection.changes, [upgradeId(change)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "nodejs/node",
      via: "tool-table",
    });
  });

  it("resolves an aqua recipe through the registry that publishes it", async () => {
    await write("aqua.yaml", ["packages:", "  - name: cli/cli", "    version: v2.0.0"].join("\n"));
    git(["add", "aqua.yaml"]);
    commit("init");
    await write("aqua.yaml", ["packages:", "  - name: cli/cli", "    version: v2.1.0"].join("\n"));
    git(["add", "aqua.yaml"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    const change = detection.changes[0]!;
    expect(change).toMatchObject({ kind: "minor", category: "tool", registry: "aqua" });
    expect(isBreakingRelevant(change)).toBe(true);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          [
            "packages:",
            "  - type: github_release",
            "    repo_owner: cli",
            "    repo_name: cli",
          ].join("\n"),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const resolutions = await resolveUpstreams(detection.changes, [upgradeId(change)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({ repo: "cli/cli" });
    vi.unstubAllGlobals();
  });

  it("finds a version a pinned action kept in the comment beside its digest", async () => {
    await write(
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
      ].join("\n"),
    );
    git(["add", ".github/workflows/ci.yml"]);
    commit("init");
    await write(
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/upload-artifact@b2c31a1b0a6d9ba1e2f1d3c4b5a6978899aabbcc # v8.0.0",
      ].join("\n"),
    );
    git(["add", ".github/workflows/ci.yml"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({
      kind: "major",
      category: "tool",
      registry: "github",
      name: "actions/upload-artifact",
      from: "v7.0.2",
      to: "v8.0.0",
    });
    expect(isBreakingRelevant(detection.changes[0]!)).toBe(true);
  });

  it("reports a pinned action whose version is not readable", async () => {
    await write(
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      ].join("\n"),
    );
    git(["add", ".github/workflows/ci.yml"]);
    commit("init");
    await write(
      ".github/workflows/ci.yml",
      [
        "jobs:",
        "  build:",
        "    steps:",
        "      - uses: actions/setup-node@1111111111111111111111111111111111111111",
      ].join("\n"),
    );
    git(["add", ".github/workflows/ci.yml"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    // The version could not be read, so the pin is reported as coverage
    // rather than as an upgrade that did not happen.
    expect(detection.changes).toHaveLength(0);
    expect(detection.warnings.join("\n")).toContain("no version");
  });
});
