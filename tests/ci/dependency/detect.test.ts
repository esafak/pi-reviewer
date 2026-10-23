import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  changedPaths,
  detectDependencyChanges,
  readFileAtRevision,
} from "../../../src/ci/dependency/detect.js";
import { gitEnv } from "../../../src/core/git-env.js";

describe("detectDependencyChanges", () => {
  let dir: string;

  // Hooks export GIT_DIR/GIT_WORK_TREE; gitEnv() strips them, so every git
  // invocation here can only reach this fixture and never the developer's
  // repository (or the one a pre-push hook is running from).
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });
  const commit = (message: string) =>
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", message]);
  const write = async (file: string, text: string) => {
    const target = path.join(dir, file);
    await writeFile(path.join(dir, path.dirname(file)), "", "utf-8").catch(() => undefined);
    await writeFile(target, text, "utf-8");
  };
  const head = () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
  const base = () =>
    execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-deps-"));
    git(["init"]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a major version bump in package.json", async () => {
    await write("package.json", JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    git(["add", "package.json"]);
    commit("init");
    await write("package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    git(["add", "package.json"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({
      name: "react",
      kind: "major",
      from: "^18.0.0",
      to: "^19.0.0",
      manifest: "package.json",
    });
  });

  it("finds a major version bump in a .NET project", async () => {
    const before = [
      "<Project>",
      "  <ItemGroup>",
      '    <PackageReference Include="Serilog" Version="3.0.0" />',
      "  </ItemGroup>",
      "</Project>",
    ].join("\n");
    const after = before.replace("3.0.0", "4.0.0");
    await write("App.csproj", before);
    git(["add", "App.csproj"]);
    commit("init");
    await write("App.csproj", after);
    git(["add", "App.csproj"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({
      registry: "nuget",
      name: "Serilog",
      kind: "major",
      from: "3.0.0",
      to: "4.0.0",
      manifest: "App.csproj",
    });
  });

  it("finds a major version bump in a Gradle build", async () => {
    const before = [
      "dependencies {",
      "    implementation 'com.google.guava:guava:33.0.0'",
      "}",
    ].join("\n");
    const after = before.replace("33.0.0", "34.0.0");
    await write("build.gradle", before);
    git(["add", "build.gradle"]);
    commit("init");
    await write("build.gradle", after);
    git(["add", "build.gradle"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({
      registry: "maven",
      name: "com.google.guava:guava",
      kind: "major",
      manifest: "build.gradle",
    });
  });

  it("finds a Go module major path transition as one change", async () => {
    await write("go.mod", "module example.com/app\n\nrequire example.com/m v1.2.3\n");
    git(["add", "go.mod"]);
    commit("init");
    await write("go.mod", "module example.com/app\n\nrequire example.com/m/v2 v2.0.0\n");
    git(["add", "go.mod"]);
    commit("bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({
      kind: "major",
      name: "example.com/m/v2",
      previousName: "example.com/m",
    });
  });

  it("treats a renamed and upgraded manifest as a version change", async () => {
    // Git's rename detection compares content similarity, so the manifest
    // carries enough text for the heuristic to recognise the move.
    const before = JSON.stringify({
      name: "app",
      version: "1.0.0",
      description: "an application with a reasonably long description field",
      dependencies: { react: "^18.0.0" },
    });
    const after = JSON.stringify({
      name: "app",
      version: "1.0.0",
      description: "an application with a reasonably long description field",
      dependencies: { react: "^19.0.0" },
    });
    await write("package.json", before);
    git(["add", "package.json"]);
    commit("init");
    await mkdir(path.join(dir, "packages/app"), { recursive: true });
    git(["mv", "package.json", "packages/app/package.json"]);
    await write("packages/app/package.json", after);
    git(["add", "-A"]);
    commit("rename and bump");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({ kind: "major", to: "^19.0.0" });
  });

  it("reports a manifest added in the range as additions", async () => {
    await write("README.md", "x\n");
    git(["add", "README.md"]);
    commit("init");
    await write("package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    git(["add", "package.json"]);
    commit("add");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({ kind: "added", name: "react" });
  });

  it("reports a manifest deleted in the range as a removal", async () => {
    await write("package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    git(["add", "package.json"]);
    commit("init");
    git(["rm", "package.json"]);
    commit("remove");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(1);
    expect(detection.changes[0]).toMatchObject({ kind: "removed", name: "react" });
  });

  it("reports a content-preserving rename as no change", async () => {
    // The manifest holds a dependency the parser reads, so the rename is
    // compared rather than skipped. A move that changes nothing is a rename
    // outright, so the content needs no padding to be recognised.
    const content = `${JSON.stringify({ dependencies: { react: "^19.0.0" } })}\n`;
    await write("package.json", content);
    git(["add", "package.json"]);
    commit("init");
    await mkdir(path.join(dir, "packages/app"), { recursive: true });
    git(["mv", "package.json", "packages/app/package.json"]);
    git(["add", "-A"]);
    commit("move");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(0);
  });

  it("reports a manifest that changed format as a removal and an addition", async () => {
    await write("package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
    git(["add", "package.json"]);
    commit("init");
    await write("requirements.txt", "flask==3.0.0\n");
    git(["add", "-A"]);
    git(["rm", "--cached", "package.json"]);
    commit("replace");

    const detection = detectDependencyChanges(dir, base(), head());
    const kinds = detection.changes.map((change) => change.kind).sort();
    expect(kinds).toEqual(["added", "removed"]);
  });

  it("reports a manifest renamed into another format as a removal and an addition", async () => {
    // The manifest moves and changes format at once, so the two sides are
    // not comparable and the move is not a version change. The shared line
    // keeps the move recognisable as a rename.
    const content = `${JSON.stringify({ dependencies: { react: "^19.0.0" } })}\n`;
    await write("package.json", content);
    git(["add", "package.json"]);
    commit("init");
    git(["mv", "package.json", "requirements.txt"]);
    await write("requirements.txt", `${content}flask==3.0.0\n`);
    git(["add", "-A"]);
    commit("move");

    const detection = detectDependencyChanges(dir, base(), head());
    const kinds = detection.changes.map((change) => change.kind).sort();
    expect(kinds).toEqual(["added", "removed"]);
    expect(detection.changes.find((change) => change.kind === "added")).toMatchObject({
      name: "flask",
      to: "==3.0.0",
    });
  });

  it("reports an unsupported manifest on either side of a change", async () => {
    await write("Podfile", "x\n");
    git(["add", "Podfile"]);
    commit("init");
    await write("Podfile", "y\n");
    git(["add", "Podfile"]);
    commit("change");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.unsupported).toEqual(["Podfile"]);
  });

  it("reports a range whose changed paths could not be read", () => {
    const detection = detectDependencyChanges(dir, "0".repeat(40), "1".repeat(40));
    expect(detection.changes).toHaveLength(0);
    expect(detection.warnings.length).toBeGreaterThan(0);
  });

  it("reports a snapshot it could not read as coverage", async () => {
    // The range is readable and the manifest is in it, but the manifest is
    // larger than the reader will read, so the failure is visible rather
    // than an empty manifest.
    await write("package.json", `${"x".repeat(5 * 1024 * 1024)}`);
    git(["add", "package.json"]);
    commit("init");
    await write("package.json", `${"x".repeat(5 * 1024 * 1024)}y`);
    git(["add", "package.json"]);
    commit("change");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(0);
    expect(detection.warnings.join("\n")).toContain("could not be read");
  });

  it("reports an unresolvable constraint as coverage", async () => {
    await write(
      "pom.xml",
      [
        "<project>",
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        "<version>${lib.version}</version>",
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    git(["add", "pom.xml"]);
    commit("init");
    await write(
      "pom.xml",
      [
        "<project>",
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        "<version>${other.version}</version>",
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    git(["add", "pom.xml"]);
    commit("change");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes.some((change) => change.kind === "unresolved")).toBe(true);
    expect(detection.warnings.length).toBeGreaterThan(0);
  });

  it("reports an unsupported manifest as unsupported coverage", async () => {
    await write("Podfile", "x\n");
    git(["add", "Podfile"]);
    commit("init");
    await write("Podfile", "y\n");
    git(["add", "Podfile"]);
    commit("change");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(0);
    expect(detection.unsupported).toEqual(["Podfile"]);
  });

  it("ignores a file that is not a manifest", async () => {
    await write("src.ts", "a\n");
    git(["add", "src.ts"]);
    commit("init");
    await write("src.ts", "b\n");
    git(["add", "src.ts"]);
    commit("change");

    const detection = detectDependencyChanges(dir, base(), head());
    expect(detection.changes).toHaveLength(0);
    expect(detection.unsupported).toHaveLength(0);
  });
});

describe("readFileAtRevision", () => {
  let dir: string;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-deps-"));
    git(["init"]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a file at a revision", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\n", "utf-8");
    git(["add", "a.txt"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    expect(readFileAtRevision(dir, revision, "a.txt")).toMatchObject({
      text: "hello\n",
      missing: false,
    });
  });

  it("reports a path that does not exist as missing, not an error", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\n", "utf-8");
    git(["add", "a.txt"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    expect(readFileAtRevision(dir, revision, "nope.txt")).toMatchObject({ missing: true });
  });

  it("rejects a revision that is not a commit id", () => {
    const snapshot = readFileAtRevision(dir, "HEAD", "a.txt");
    expect(snapshot.missing).toBe(false);
    expect(snapshot.error).toBe("invalid revision");
    expect(snapshot.text).toBeUndefined();
  });
});

describe("changedPaths", () => {
  let dir: string;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore", env: gitEnv() });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-deps-"));
    git(["init"]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports a rename with both paths", async () => {
    const content = `${"x".repeat(500)}\n`;
    await writeFile(path.join(dir, "old.txt"), content, "utf-8");
    git(["add", "old.txt"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
    await writeFile(path.join(dir, "old.txt"), `${"x".repeat(500)}y\n`, "utf-8");
    git(["mv", "old.txt", "new.txt"]);
    git(["add", "-A"]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "rename"]);
    const from = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    const to = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
      env: gitEnv(),
    }).trim();
    expect(changedPaths(dir, from, to).paths).toEqual([
      { status: "renamed", oldPath: "old.txt", newPath: "new.txt" },
    ]);
  });
});
