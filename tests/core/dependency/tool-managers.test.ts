import { describe, expect, it } from "vite-plus/test";

import { compareManifests } from "../../../src/core/dependency/compare.js";
import { manifestFormat, parseManifest } from "../../../src/core/dependency/manifests.js";

describe("manifestFormat — the tool managers", () => {
  it("recognizes the tool manifests", () => {
    expect(manifestFormat("mise.toml")).toBe("mise.toml");
    expect(manifestFormat(".mise.toml")).toBe("mise.toml");
    expect(manifestFormat("mise.local.toml")).toBe("mise.toml");
    expect(manifestFormat("packages/api/mise.toml")).toBe("mise.toml");
    expect(manifestFormat("packages/api/.mise.toml")).toBe("mise.toml");
    expect(manifestFormat("packages/api/mise.local.toml")).toBe("mise.toml");
    expect(manifestFormat(".config/mise/config.toml")).toBe("mise.toml");
    expect(manifestFormat(".tool-versions")).toBe("tool-versions");
    expect(manifestFormat("aqua.yaml")).toBe("aqua.yaml");
    expect(manifestFormat(".github/workflows/ci.yml")).toBe("github-actions");
    expect(manifestFormat(".github/workflows/ci.yaml")).toBe("github-actions");
    expect(manifestFormat("action.yml")).toBe("github-actions");
    expect(manifestFormat("action.yaml")).toBe("github-actions");
    expect(manifestFormat(".github/actions/setup/action.yml")).toBe("github-actions");
  });

  it("does not claim a file that is not a tool manifest", () => {
    expect(manifestFormat("mise.lock")).toBeUndefined();
    expect(manifestFormat(".github/dependabot.yml")).toBeUndefined();
  });
});

describe("parseManifest — mise.toml", () => {
  it("reads a bare tool with the tool dialect", () => {
    const result = parseManifest("mise.toml", ["[tools]", 'python = "3.11"'].join("\n"));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      registry: "unknown",
      dialect: "tool",
      category: "tool",
      name: "python",
      section: "tools",
      constraint: "3.11",
    });
  });

  it("reads a backend prefix as the registry it names", () => {
    const result = parseManifest(
      "mise.toml",
      [
        "[tools]",
        '"npm:pnpm" = "10.0.0"',
        '"cargo:ripgrep" = "14.1.0"',
        '"go:golang.org/x/tools" = "v0.21.0"',
        '"gem:rails" = "7.1.3"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.registry)).toEqual([
      "npm",
      "crates",
      "go",
      "rubygems",
    ]);
    expect(result.records[0]).toMatchObject({ name: "npm:pnpm", resolvedName: "pnpm" });
  });

  it("reads a GitHub backend as the repository it names", () => {
    const result = parseManifest(
      "mise.toml",
      ["[tools]", '"github:owner/repo" = "v1.0.0"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      registry: "github",
      name: "github:owner/repo",
      resolvedName: "owner/repo",
      constraint: "v1.0.0",
    });
  });

  it("reads an aqua backend as a recipe", () => {
    const result = parseManifest(
      "mise.toml",
      ["[tools]", '"aqua:atlassian.com/acli" = "2.0.0"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      registry: "aqua",
      resolvedName: "atlassian.com/acli",
    });
  });

  it.each([
    [
      "an option table names a registry",
      ["[tools]", '"aqua:cli/cli" = { version = "2.0.0", registry = "mine" }'],
      "names a registry",
    ],
    [
      "the tool's own table names a registry",
      ['[tools."aqua:cli/cli"]', 'version = "2.0.0"', 'registry = "https://example.test/custom"'],
      "names a registry",
    ],
    [
      "a dotted option names a registry",
      ["[tools]", '"aqua:cli/cli".version = "2.0.0"', '"aqua:cli/cli".registry = "mine"'],
      "names a registry",
    ],
    [
      "the settings name a registry",
      [
        "[settings]",
        'aqua.registry_url = "https://github.com/example/custom"',
        "",
        "[tools]",
        '"aqua:cli/cli" = "2.0.0"',
      ],
      "names an aqua registry",
    ],
    [
      "the settings name a registry in a table",
      [
        "[settings]",
        'aqua = { registry_url = "https://github.com/example/custom" }',
        "",
        "[tools]",
        '"aqua:cli/cli" = "2.0.0"',
      ],
      "names an aqua registry",
    ],
    [
      "the settings are a table of their own",
      [
        'settings = { aqua = { registry_url = "https://github.com/example/custom" } }',
        "",
        "[tools]",
        '"aqua:cli/cli" = "2.0.0"',
      ],
      "names an aqua registry",
    ],
    [
      "the settings name a registry list",
      [
        "[settings.aqua]",
        'registries = ["https://github.com/example/custom"]',
        "",
        "[tools]",
        '"aqua:cli/cli" = "2.0.0"',
      ],
      "names an aqua registry",
    ],
    [
      "the settings turn off the built-in registry",
      ["[settings.aqua]", "baked_registry = false", "", "[tools]", '"aqua:cli/cli" = "2.0.0"'],
      "names an aqua registry",
    ],
  ] as const)("does not read an aqua pin when %s", (_name, lines, warning) => {
    const result = parseManifest("mise.toml", lines.join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain(warning);
  });

  it("reads an aqua pin when the settings only verify a package", () => {
    const result = parseManifest(
      "mise.toml",
      ["[settings.aqua]", "cosign = false", "", "[tools]", '"aqua:cli/cli" = "2.0.0"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "aqua:cli/cli" });
    expect(result.warnings).toEqual([]);
  });

  it("keeps an unknown backend unidentified", () => {
    const result = parseManifest("mise.toml", ["[tools]", '"ubi:foo" = "1.0"'].join("\n"));
    expect(result.records[0]).toMatchObject({ registry: "unknown", name: "ubi:foo" });
    expect(result.records[0]?.resolvedName).toBeUndefined();
  });

  it("reads a core and an asdf backend through the tool table", () => {
    const result = parseManifest(
      "mise.toml",
      ["[tools]", '"core:node" = "24"', '"asdf:nodejs" = "24.0.0"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ registry: "mise-core", resolvedName: "node" });
    expect(result.records[1]).toMatchObject({ registry: "unknown", resolvedName: "nodejs" });
  });

  it("takes the first version of an array and reports the rest", () => {
    const result = parseManifest("mise.toml", ["[tools]", 'python = ["3.11", "3.12"]'].join("\n"));
    expect(result.records[0]).toMatchObject({ constraint: "3.11" });
    expect(result.warnings.join("\n")).toContain("only the first is compared");
  });

  it("reads the version of an option table", () => {
    const result = parseManifest(
      "mise.toml",
      ["[tools]", 'go = { version = "1.22", foo = "bar" }'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "go", constraint: "1.22" });
  });

  it("reads a tool pin written as a table of its own", () => {
    const result = parseManifest("mise.toml", ["[tools.python]", 'version = "3.12"'].join("\n"));
    expect(result.records[0]).toMatchObject({ name: "python", constraint: "3.12" });
  });

  it("reads a tool pin written as a dotted key", () => {
    const result = parseManifest("mise.toml", ["[tools]", 'python.version = "3.12"'].join("\n"));
    expect(result.records[0]).toMatchObject({ name: "python", constraint: "3.12" });
  });

  it("reports a tool table that declares no version", () => {
    const result = parseManifest("mise.toml", ["[tools.python]", 'install_env = "x"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("has no version");
  });

  it("does not read a version out of an array that holds other values", () => {
    // The reader keeps the array's versions but not their places, so the
    // first version it holds is not necessarily the array's first element.
    const result = parseManifest("mise.toml", ["[tools]", 'python = [42, "3.12"]'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("not versions");
  });

  it("does not read a backend that names an inherited property", () => {
    const result = parseManifest(
      "mise.toml",
      ["[tools]", '"constructor:python" = "3.12"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ registry: "unknown" });
    expect(result.records[0]?.resolvedName).toBeUndefined();
  });

  it("reports a pin with no version", () => {
    const result = parseManifest("mise.toml", ["[tools]", "python = 3.11"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — .tool-versions", () => {
  it("reads a plain line", () => {
    const result = parseManifest("tool-versions", ["nodejs 24.0.0"].join("\n"));
    expect(result.records[0]).toMatchObject({
      registry: "unknown",
      dialect: "tool",
      category: "tool",
      name: "nodejs",
      constraint: "24.0.0",
    });
  });

  it("takes the first version of a line and reports the rest", () => {
    const result = parseManifest("tool-versions", ["python 3.12.1 3.11.9"].join("\n"));
    expect(result.records[0]).toMatchObject({ name: "python", constraint: "3.12.1" });
    expect(result.warnings.join("\n")).toContain("only the first is compared");
  });

  it("reports a pseudo-version and reads no version from it", () => {
    const result = parseManifest("tool-versions", ["ruby system", "perl ref:master"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("has no version");
  });
});

describe("parseManifest — aqua.yaml", () => {
  it("reads the separate name and version spelling", () => {
    const result = parseManifest(
      "aqua.yaml",
      ["packages:", "  - name: cli/cli", "    version: v2.0.0"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      registry: "aqua",
      dialect: "tool",
      category: "tool",
      name: "cli/cli",
      section: "packages",
      constraint: "v2.0.0",
    });
  });

  it("reads the combined spelling", () => {
    const result = parseManifest(
      "aqua.yaml",
      ["packages:", "  - name: suzuki-shunsuke/pinact@v3.0.0"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "suzuki-shunsuke/pinact",
      constraint: "v3.0.0",
    });
  });

  it("strips a checksum suffix from the version", () => {
    const result = parseManifest(
      "aqua.yaml",
      ["packages:", "  - name: astral-sh/ruff", "    version: v0.4.0@sha256:abcdef"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ constraint: "v0.4.0" });
  });

  it("keeps the spelling of a version the parser would resolve", () => {
    // The parser resolves a plain number to a JavaScript number, and
    // `3.10` resolves to `3.1`. The text is what a version is written as.
    const result = parseManifest(
      "aqua.yaml",
      ["packages:", "  - name: example/tool", "    version: 3.10"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ constraint: "3.10" });
  });

  it.each([
    [
      "the standard registry under its own name",
      [
        "registries:",
        "  - type: standard",
        "    name: aqua-registry",
        "    repo_owner: aquaproj",
        "    repo_name: aqua-registry",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
        "    registry: aqua-registry",
      ],
    ],
    [
      "a declaration of the standard registry under another name",
      [
        "registries:",
        "  - name: upstream",
        "    type: standard",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
        "    registry: upstream",
      ],
    ],
    [
      "the standard registry with its default path",
      [
        "registries:",
        "  - type: standard",
        "    path: registry.yaml",
        "    ref: v4",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
    ],
    [
      "a standard registry declared as github content",
      [
        "registries:",
        "  - name: official",
        "    type: github_content",
        "    repo_owner: aquaproj",
        "    repo_name: aqua-registry",
        "    path: registry.yaml",
        "    ref: v4",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
        "    registry: official",
      ],
    ],
    [
      "the standard registry, which needs no name",
      [
        "registries:",
        "  - type: standard",
        "    ref: v4.0.0",
        "packages:",
        "  - name: cli/cli@v2.0.0",
        "    registry: standard",
      ],
    ],
  ] as const)("reads a package from %s", (_name, lines) => {
    const result = parseManifest("aqua.yaml", lines.join("\n"));
    expect(result.records[0]).toMatchObject({ name: "cli/cli", constraint: "v2.0.0" });
    expect(result.warnings).toEqual([]);
  });

  it.each([
    [
      "another owner",
      [
        "registries:",
        "  - type: standard",
        "    repo_owner: evil-org",
        "    ref: v1.0.0",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "which is not read",
    ],
    [
      "a local registry under the standard names",
      [
        "registries:",
        "  - type: local",
        "    name: mine",
        "    repo_owner: aquaproj",
        "    repo_name: aqua-registry",
        "    path: ./registry",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
        "    registry: mine",
      ],
      "which is not read",
    ],
    [
      "another path",
      [
        "registries:",
        "  - type: standard",
        "    repo_owner: aquaproj",
        "    repo_name: aqua-registry",
        "    path: ./registry",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "which is not read",
    ],
    [
      "an undeclared registry",
      ["packages:", "  - name: cli/cli", "    version: v2.0.0", "    registry: mine"],
      "which is not declared",
    ],
    [
      "a registry configuration that could not be read",
      [
        "registries: [{type: standard, repo_owner: evil-org}]",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "could not be read",
    ],
    [
      "a registry declaration that could not be read",
      [
        "registries:",
        "  - &fork",
        "    type: standard",
        "    repo_owner: evil-org",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "could not be read",
    ],
    [
      "a registry field that could not be read",
      [
        "registries:",
        "  - type: standard",
        "    repo_owner: &owner evil-org",
        "    ref: v1",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "could not be read",
    ],
    [
      "a registry key that could not be read",
      [
        "registries:",
        "  - name: custom",
        "    type: standard",
        "    &ownerKey repo_owner: evil-org",
        "    ref: v1",
        "  - type: standard",
        "    *ownerKey : evil-org",
        "    ref: v1",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "could not be read",
    ],
    [
      "a registry with an empty name",
      [
        "registries:",
        '  - name: ""',
        "    type: standard",
        "    repo_owner: evil-org",
        "    ref: v1",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ],
      "which is not read",
    ],
    [
      "a registry that is not the standard one",
      [
        "registries:",
        "  - type: github_release",
        "    name: custom",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
        "    registry: custom",
      ],
      "is not the standard registry",
    ],
  ] as const)("does not read a package from %s", (_name, lines, warning) => {
    const result = parseManifest("aqua.yaml", lines.join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain(warning);
  });

  it("reports an unselected custom registry without dropping standard packages", () => {
    const result = parseManifest(
      "aqua.yaml",
      [
        "registries:",
        "  - type: github_release",
        "    name: custom",
        "packages:",
        "  - name: cli/cli",
        "    version: v2.0.0",
      ].join("\n"),
    );
    // The custom registry is reported even though no package selects it, and
    // the package that uses the standard registry is still read.
    expect(result.warnings.join("\n")).toContain("is not the standard registry");
    expect(result.records[0]).toMatchObject({ name: "cli/cli" });
  });

  it("reports a file that declares no packages", () => {
    const result = parseManifest("aqua.yaml", ["registries: []"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("declares no packages");
  });
});

describe("parseManifest — package.json tool entries", () => {
  it("reads a runtime pin in the object form", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({
        devEngines: { runtime: { name: "node", version: "^24.0.0", onFail: "warn" } },
      }),
    );
    expect(result.records[0]).toMatchObject({
      registry: "unknown",
      dialect: "tool",
      category: "tool",
      name: "node",
      section: "devEngines.runtime",
      constraint: "^24.0.0",
    });
  });

  it("reads a runtime pin in the array form", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({
        devEngines: {
          runtime: [
            { name: "node", version: "^24.0.0" },
            { name: "python", version: "3.12" },
          ],
        },
      }),
    );
    expect(result.records.map((record) => record.name)).toEqual(["node", "python"]);
  });

  it("reads the package manager and splits its name from its version", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({ packageManager: "pnpm@12.10.1" }),
    );
    expect(result.records[0]).toMatchObject({
      registry: "npm",
      dialect: "semver",
      category: "tool",
      name: "pnpm",
      section: "packageManager",
      constraint: "12.10.1",
    });
  });

  it("splits a scoped package manager and strips its integrity suffix", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({ packageManager: "@scope/name@1.0.0+sha512.abcdef" }),
    );
    expect(result.records[0]).toMatchObject({ name: "@scope/name", constraint: "1.0.0" });
  });

  it("keeps the libraries and the tools apart", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devEngines: { runtime: { name: "node", version: "^24.0.0" } },
      }),
    );
    expect(result.records.map((record) => record.category)).toEqual(["library", "tool"]);
  });
});

describe("parseManifest — GitHub Actions", () => {
  it("reads a tag-pinned action", () => {
    const result = parseManifest(
      "github-actions",
      ["jobs:", "  build:", "    steps:", "      - uses: actions/checkout@v4.6.2"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      registry: "github",
      dialect: "semver",
      category: "tool",
      name: "actions/checkout",
      constraint: "v4.6.2",
    });
  });

  it("reads the version a digest-pinned action keeps in its comment", () => {
    const result = parseManifest(
      "github-actions",
      [
        "steps:",
        "  - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "actions/upload-artifact",
      constraint: "v7.0.2",
    });
  });

  it("keeps a pin with no version visible", () => {
    const result = parseManifest(
      "github-actions",
      ["steps:", "  - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"].join(
        "\n",
      ),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      name: "actions/setup-node",
      constraint: "unresolved",
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("strips a subpath from the repository it names", () => {
    const result = parseManifest(
      "github-actions",
      ["steps:", "  - uses: actions/checkout/sub@v4.6.2"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "actions/checkout" });
  });

  it("ignores a local action", () => {
    const result = parseManifest(
      "github-actions",
      ["steps:", "  - uses: ./local-action"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("reads the root action definition", () => {
    const result = parseManifest(
      "github-actions",
      [
        "name: pi-reviewer",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "actions/setup-node",
      constraint: "v7.0.0",
    });
  });

  it.each([
    [
      "a reordering of the same pins",
      ["- uses: actions/checkout@v4.6.2", "- uses: actions/checkout@v5.0.0"],
      ["- uses: actions/checkout@v5.0.0", "- uses: actions/checkout@v4.6.2"],
      [],
    ],
    [
      "the same pin twice",
      ["- uses: actions/checkout@v4.6.2", "- uses: actions/checkout@v4.6.2"],
      ["- uses: actions/checkout@v4.6.2", "- uses: actions/checkout@v4.6.2"],
      [],
    ],
    [
      "every copy of a pin bumped",
      ["- uses: actions/checkout@v4.6.2", "- uses: actions/checkout@v4.6.2"],
      ["- uses: actions/checkout@v5.0.0", "- uses: actions/checkout@v5.0.0"],
      ["major"],
    ],
    [
      "one copy of a pin bumped",
      ["- uses: actions/checkout@v4.6.2", "- uses: actions/checkout@v4.6.2"],
      ["- uses: actions/checkout@v4.6.2", "- uses: actions/checkout@v5.0.0"],
      ["major"],
    ],
  ] as const)("reports %s as the comparison sees it", (_name, before, after, kinds) => {
    const parse = (steps: readonly string[]) =>
      parseManifest("github-actions", ["steps:", ...steps].join("\n")).records;
    const changes = compareManifests(parse(before), parse(after), "workflow.yml");
    expect(changes.map((change) => change.kind)).toEqual(kinds);
  });
});
