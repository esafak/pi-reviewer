import { describe, expect, it, vi } from "vite-plus/test";
import type { DependencyChange } from "../../../src/core/dependency/types.js";
import {
  resolveUpstreams,
  upgradeId,
  validateResearch,
  type UpgradeResearch,
} from "../../../src/ci/dependency/resolve.js";

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const text = (value: string) => new Response(value, { status: 200 });

const change = (overrides: Partial<DependencyChange> = {}): DependencyChange => ({
  registry: "npm",
  dialect: "semver",
  category: "library",
  name: "react",
  section: "dependencies",
  from: "^18.0.0",
  to: "^19.0.0",
  kind: "major",
  manifest: "package.json",
  ...overrides,
});

const githubOnly = { github: true, url: false };
const urlOnly = { github: false, url: true };
const both = { github: true, url: true };

describe("upstream resolution", () => {
  it("gives every upgrade a stable id that distinguishes the section", () => {
    const dependencies = change();
    const devDependencies = change({ section: "devDependencies" });
    expect(upgradeId(dependencies)).toBe(upgradeId(change()));
    expect(upgradeId(dependencies)).not.toBe(upgradeId(devDependencies));
    expect(upgradeId(dependencies)).not.toBe(
      upgradeId(change({ manifest: "apps/web/package.json" })),
    );
  });

  it("reads the current metadata rather than the upgrade's target version", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/facebook/react.git",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolutions = await resolveUpstreams([change()], [upgradeId(change())], githubOnly);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://registry.npmjs.org/react/latest");
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "facebook/react",
      via: "registry-metadata",
    });
    vi.unstubAllGlobals();
  });

  it("resolves a GitHub source to a repository candidate", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        name: "react",
        version: "19.3.1",
        repository: { type: "git", url: "git+https://github.com/facebook/react.git" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolutions = await resolveUpstreams([change()], [upgradeId(change())], githubOnly);
    const candidate = resolutions[0]!.candidates[0]!;
    expect(candidate.repo).toBe("facebook/react");
    expect(candidate.url).toBe("https://github.com/facebook/react");
    expect(candidate.id).toBe(`${upgradeId(change())}-1`);
    vi.unstubAllGlobals();
  });

  it("runs a non-GitHub source through the mirror table", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        Version: "v1.36.10",
        Time: "2026-01-01T00:00:00Z",
        Origin: { VCS: "git", URL: "https://go.googlesource.com/protobuf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const protobuf = change({
      registry: "go",
      dialect: "go",
      name: "google.golang.org/protobuf",
    });
    const resolutions = await resolveUpstreams([protobuf], [upgradeId(protobuf)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "protocolbuffers/protobuf-go",
      via: "mirror",
    });
    vi.unstubAllGlobals();
  });

  it("does not substitute a host-wide rule for the mirror table", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        Version: "v1.0.0",
        Time: "2026-01-01T00:00:00Z",
        Origin: { VCS: "git", URL: "https://go.googlesource.com/protobuf" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // A different module that happens to be served from the same host is not
    // the module the table names.
    const other = change({
      registry: "go",
      dialect: "go",
      name: "example.com/other",
    });
    const resolutions = await resolveUpstreams([other], [upgradeId(other)], both);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      url: "https://go.googlesource.com/protobuf",
    });
    expect(resolutions[0]!.candidates[0]!.repo).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("resolves a known tool through the tool table", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);
    const python = change({
      registry: "unknown",
      dialect: "tool",
      category: "tool",
      name: "python",
      section: "tools",
    });
    const resolutions = await resolveUpstreams([python], [upgradeId(python)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "python/cpython",
      via: "tool-table",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("resolves an aqua recipe through the registry that publishes it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        text(
          [
            "packages:",
            "  - type: github_release",
            "    repo_owner: cli",
            "    repo_name: cli",
          ].join("\n"),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const aqua = change({
      registry: "aqua",
      dialect: "tool",
      category: "tool",
      name: "cli/cli",
      section: "tools",
    });
    // The lookup costs one request of the run's budget.
    const resolutions = await resolveUpstreams([aqua], [upgradeId(aqua)], githubOnly, {
      maxRequests: 1,
    });
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "cli/cli",
      via: "registry-metadata",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("leaves an aqua recipe it cannot place unresolved", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    // The aqua registry describes its own recipes, so a recipe named after a
    // tool is still a recipe the harness cannot place.
    const aqua = change({
      registry: "aqua",
      dialect: "tool",
      category: "tool",
      name: "node",
      section: "tools",
    });
    const resolutions = await resolveUpstreams([aqua], [upgradeId(aqua)], githubOnly);
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("aqua");
    vi.unstubAllGlobals();
  });

  it("does not read a repository out of a source that is not one", async () => {
    for (const source of [
      "file://github.com/facebook/react",
      "git://github.com/facebook/react",
      "mailto:maintainer@example.com",
    ]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          json({ name: "react", version: "19.3.1", repository: source }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const react = change();
      const resolutions = await resolveUpstreams([react], [upgradeId(react)], both);
      expect(resolutions[0]!.candidates, source).toEqual([]);
      expect(resolutions[0]!.unresolved, source).toContain("cannot open");
      vi.unstubAllGlobals();
    }
  });

  it("does not read a repository out of a URL that names none", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({ name: "react", version: "19.3.1", repository: "https://github.com/o/r%2Fsub" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], both);
    // The escape is not part of a repository name, so the URL names no
    // project and there is nothing to offer.
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("cannot open");
    vi.unstubAllGlobals();
  });

  it("does not offer a repository the research tool would refuse", async () => {
    for (const source of [
      "github:a_b/r",
      "git@github.com:a_b/r",
      "https://github.com/a_b/r",
      `github:o/${"r".repeat(101)}`,
      `github:${"o".repeat(40)}/r`,
    ]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          json({ name: "react", version: "19.3.1", repository: source }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const react = change();
      const resolutions = await resolveUpstreams([react], [upgradeId(react)], both);
      expect(resolutions[0]!.candidates, source).toEqual([]);
      expect(resolutions[0]!.unresolved, source).toContain("cannot open");
      vi.unstubAllGlobals();
    }
  });

  it("does not read a repository out of a shorthand that names none", async () => {
    for (const source of ["github:o/.git", "git@github.com:o/.git", "github:o"]) {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          json({ name: "react", version: "19.3.1", repository: source }),
        );
      vi.stubGlobal("fetch", fetchMock);
      const react = change();
      const resolutions = await resolveUpstreams([react], [upgradeId(react)], both);
      expect(resolutions[0]!.candidates, source).toEqual([]);
      expect(resolutions[0]!.unresolved, source).toContain("cannot open");
      vi.unstubAllGlobals();
    }
  });

  it("reads an escaped file path as the file the reader will ask for", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/o/r/blob/main/Release%20Notes.md",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], githubOnly);
    // The reader asks for the path by name, so the candidate carries the
    // decoded name.
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "o/r",
      path: "Release Notes.md",
    });
    vi.unstubAllGlobals();
  });

  it("does not read a file path that stands for another file", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/o/r/blob/main/a%2Fb.md",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({ repo: "o/r" });
    expect(resolutions[0]!.candidates[0]!.path).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("reads the path a tree URL names without its reference", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/facebook/react/tree/main/docs",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "facebook/react",
      path: "docs",
    });
    vi.unstubAllGlobals();
  });

  it("strips the suffix from the repository and from nothing else", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/o/r.git?tab=readme-ov-file",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({ repo: "o/r" });
    vi.unstubAllGlobals();

    const fileMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/o/r/blob/main/docs/notes.git",
      }),
    );
    vi.stubGlobal("fetch", fileMock);
    const fileChange = change();
    const fileResolutions = await resolveUpstreams(
      [fileChange],
      [upgradeId(fileChange)],
      githubOnly,
    );
    // The file is named `notes.git`; the suffix belongs to the repository and
    // to nothing else.
    expect(fileResolutions[0]!.candidates[0]).toMatchObject({
      repo: "o/r",
      path: "docs/notes.git",
    });
    vi.unstubAllGlobals();
  });

  it("does not fail the run on a source with a malformed escape", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({ name: "react", version: "19.3.1", repository: "https://github.com/o/repo%ZZ" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], both);
    // The escape is not a repository name, so the URL names no project, and
    // the resolution does not fail over it.
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("cannot open");
    vi.unstubAllGlobals();
  });

  it("leaves a tool name that is not an entry unresolved", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    for (const name of ["constructor", "__proto__", "toString"]) {
      const tool = change({
        registry: "unknown",
        dialect: "tool",
        category: "tool",
        name,
        section: "tools",
      });
      const resolutions = await resolveUpstreams([tool], [upgradeId(tool)], githubOnly);
      expect(resolutions[0]!.candidates, name).toEqual([]);
      expect(resolutions[0]!.unresolved, name).toContain("tool table");
    }
    vi.unstubAllGlobals();
  });

  it("charges every Maven redirect hop to the request budget", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "lib", latestVersion: "2.0.0" }] },
        }),
      )
      .mockResolvedValueOnce(
        new Response("", {
          status: 301,
          headers: { location: "https://repo1.maven.org/maven2/org/demo/lib/2.0.0/lib-2.0.0.pom" },
        }),
      )
      .mockResolvedValueOnce(
        text("<project><scm><url>https://github.com/example/demo</url></scm></project>"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const demo = change({
      registry: "maven",
      dialect: "maven",
      name: "org.demo:lib",
    });
    const resolutions = await resolveUpstreams([demo], [upgradeId(demo)], githubOnly, {
      maxRequests: 2,
    });
    // The budget is spent by the search and the first hop, so the redirected
    // document is never fetched.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("budget");
    vi.unstubAllGlobals();
  });

  it("resolves a repository the manifest names without a lookup", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const action = change({
      registry: "github",
      dialect: "semver",
      category: "tool",
      name: "actions/upload-artifact",
      section: "",
    });
    const resolutions = await resolveUpstreams([action], [upgradeId(action)], githubOnly);
    expect(resolutions[0]!.candidates[0]).toMatchObject({
      repo: "actions/upload-artifact",
      via: "manifest",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("records a source the model cannot open as unresolved", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        name: "demo",
        version: "1.0.0",
        repository: "mailto:maintainer@example.com",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const demo = change({ name: "demo" });
    const resolutions = await resolveUpstreams([demo], [upgradeId(demo)], both);
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("cannot open");
    vi.unstubAllGlobals();
  });

  it("does not use a URL candidate when the reader is off", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        Version: "v1.0.0",
        Time: "2026-01-01T00:00:00Z",
        Origin: { VCS: "git", URL: "https://codeberg.org/example/demo" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const demo = change({
      registry: "go",
      dialect: "go",
      name: "example.com/demo",
    });
    const off = await resolveUpstreams([demo], [upgradeId(demo)], githubOnly);
    expect(off[0]!.candidates).toEqual([]);
    expect(off[0]!.unresolved).toContain("URL reader");
    const on = await resolveUpstreams([demo], [upgradeId(demo)], both);
    expect(on[0]!.candidates[0]).toMatchObject({ url: "https://codeberg.org/example/demo" });
    vi.unstubAllGlobals();
  });

  it("does not use a URL the reader's static rules refuse", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        Version: "v1.0.0",
        Time: "2026-01-01T00:00:00Z",
        Origin: { VCS: "git", URL: "https://127.0.0.1/notes" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const demo = change({
      registry: "go",
      dialect: "go",
      name: "example.com/demo",
    });
    const resolutions = await resolveUpstreams([demo], [upgradeId(demo)], both);
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("private or local address");
    vi.unstubAllGlobals();
  });

  it("does not use a repository when the GitHub research tools are disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/facebook/react.git",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], {
      github: false,
      url: false,
    });
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("GitHub research tools");
    vi.unstubAllGlobals();
  });

  it("keeps a candidate that carries both a repository and a URL usable by either reader", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/facebook/react.git",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const byRepo = await resolveUpstreams([react], [upgradeId(react)], githubOnly);
    expect(byRepo[0]!.candidates[0]).toMatchObject({ repo: "facebook/react" });
    const byUrl = await resolveUpstreams([react], [upgradeId(react)], urlOnly);
    expect(byUrl[0]!.candidates[0]).toMatchObject({ url: "https://github.com/facebook/react" });
    vi.unstubAllGlobals();
  });

  it("caches the source by package rather than by version range", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      json({
        name: "react",
        version: "19.3.1",
        repository: "https://github.com/facebook/react.git",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = change({ from: "^18.0.0", to: "^19.0.0" });
    const second = change({ from: "^19.0.0", to: "^20.0.0", section: "devDependencies" });
    const resolutions = await resolveUpstreams(
      [first, second],
      [upgradeId(first), upgradeId(second)],
      githubOnly,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolutions.map((entry) => entry.candidates[0]!.repo)).toEqual([
      "facebook/react",
      "facebook/react",
    ]);
    vi.unstubAllGlobals();
  });

  it("reports a failing lookup as coverage rather than failing the run", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const react = change();
    const resolutions = await resolveUpstreams([react], [upgradeId(react)], githubOnly);
    expect(resolutions[0]!.candidates).toEqual([]);
    expect(resolutions[0]!.unresolved).toContain("Registry request failed");
    vi.unstubAllGlobals();
  });

  it("reports an upgrade with no detected change as unresolved", async () => {
    const resolutions = await resolveUpstreams([], ["u-unknown"], githubOnly);
    expect(resolutions).toEqual([
      { id: "u-unknown", candidates: [], unresolved: "the upgrade has no detected change" },
    ]);
  });
});

describe("research report validation", () => {
  const react = change();
  const other = change({ name: "vue", section: "devDependencies" });
  const resolutions = [
    {
      id: upgradeId(react),
      candidates: [
        { id: `${upgradeId(react)}-1`, via: "registry-metadata" as const, repo: "facebook/react" },
      ],
    },
    {
      id: upgradeId(other),
      candidates: [
        { id: `${upgradeId(other)}-1`, via: "registry-metadata" as const, repo: "vuejs/core" },
      ],
    },
  ];
  const upgrades = [upgradeId(react), upgradeId(other)];

  it("accepts a citation naming a candidate of that upgrade", () => {
    const report: UpgradeResearch[] = [
      { id: upgradeId(react), status: "researched", source: `candidate:${upgradeId(react)}-1` },
    ];
    const result = validateResearch(report, resolutions, upgrades);
    expect(result.accepted).toEqual([
      { id: upgradeId(react), status: "researched", source: `candidate:${upgradeId(react)}-1` },
    ]);
    expect(result.gaps).toEqual([upgradeId(other)]);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects a citation naming a candidate of another upgrade", () => {
    const report: UpgradeResearch[] = [
      { id: upgradeId(react), status: "researched", source: `candidate:${upgradeId(other)}-1` },
    ];
    const result = validateResearch(report, resolutions, upgrades);
    expect(result.accepted).toEqual([]);
    expect(result.gaps).toEqual(upgrades);
    expect(result.diagnostics[0]).toContain("names no candidate of this upgrade");
  });

  it("accepts a local citation and publishes it as written", () => {
    const report: UpgradeResearch[] = [
      { id: upgradeId(react), status: "researched", source: "local:packages/react/CHANGELOG.md" },
    ];
    const result = validateResearch(report, resolutions, upgrades);
    expect(result.accepted[0]).toEqual({
      id: upgradeId(react),
      status: "researched",
      source: "local:packages/react/CHANGELOG.md",
    });
  });

  it("rejects a local citation that escapes the checkout", () => {
    for (const source of [
      "local:/etc/passwd",
      "local:\\etc\\passwd",
      "local:..\\outside.md",
      "local:../outside.md",
      "local:a/../../b.md",
    ]) {
      const result = validateResearch(
        [{ id: upgradeId(react), status: "researched", source }],
        resolutions,
        upgrades,
      );
      expect(result.accepted, source).toEqual([]);
      expect(result.diagnostics[0], source).toContain("repository-relative path");
    }
  });

  it("rejects a citation in neither form", () => {
    const result = validateResearch(
      [{ id: upgradeId(react), status: "researched", source: "https://example.com/changelog" }],
      resolutions,
      upgrades,
    );
    expect(result.accepted).toEqual([]);
    expect(result.diagnostics[0]).toContain("neither a candidate nor a local path");
  });

  it("discards an unknown upgrade id without letting it satisfy the accounting", () => {
    const result = validateResearch(
      [{ id: "u-unknown", status: "researched", source: "candidate:whatever" }],
      resolutions,
      upgrades,
    );
    expect(result.accepted).toEqual([]);
    expect(result.gaps).toEqual(upgrades);
    expect(result.diagnostics[0]).toContain("not one of the qualifying upgrades");
  });

  it("resolves a conflicting duplicate conservatively", () => {
    const result = validateResearch(
      [
        { id: upgradeId(react), status: "researched", source: `candidate:${upgradeId(react)}-1` },
        { id: upgradeId(react), status: "unverified", reason: "the notes were gone" },
      ],
      resolutions,
      upgrades,
    );
    expect(result.accepted[0]).toMatchObject({ id: upgradeId(react), status: "unverified" });
    expect(result.gaps).not.toContain(upgradeId(react));
    expect(result.diagnostics[0]).toContain("conflicting dispositions");
  });

  it("resolves a conflict the same way whatever order the report lists it in", () => {
    const valid = {
      id: upgradeId(react),
      status: "researched" as const,
      source: `candidate:${upgradeId(react)}-1`,
    };
    const invalid = {
      id: upgradeId(react),
      status: "researched" as const,
      source: "candidate:other",
    };
    const first = validateResearch([valid, invalid], resolutions, upgrades);
    const second = validateResearch([invalid, valid], resolutions, upgrades);
    expect(first.accepted).toEqual(second.accepted);
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(first.accepted[0]).toMatchObject({ status: "researched" });
  });

  it("keeps a duplicate that agrees", () => {
    const result = validateResearch(
      [
        { id: upgradeId(react), status: "researched", source: `candidate:${upgradeId(react)}-1` },
        { id: upgradeId(react), status: "researched", source: `candidate:${upgradeId(react)}-1` },
      ],
      resolutions,
      upgrades,
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
  });
});
