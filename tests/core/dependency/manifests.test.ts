import { describe, expect, it } from "vite-plus/test";

import {
  UNSUPPORTED_MANIFESTS,
  isSupportedManifest,
  manifestFormat,
  parseManifest,
} from "../../../src/core/dependency/manifests.js";

describe("manifestFormat", () => {
  it("recognizes the supported manifests", () => {
    expect(manifestFormat("package.json")).toBe("package.json");
    expect(manifestFormat("apps/web/package.json")).toBe("package.json");
    expect(manifestFormat("requirements.txt")).toBe("requirements");
    expect(manifestFormat("requirements/dev.txt")).toBe("requirements");
    expect(manifestFormat("pyproject.toml")).toBe("pyproject");
    expect(manifestFormat("pom.xml")).toBe("pom.xml");
    expect(manifestFormat("Cargo.toml")).toBe("Cargo.toml");
    expect(manifestFormat("go.mod")).toBe("go.mod");
  });

  it("does not claim a file that is not a manifest", () => {
    expect(manifestFormat("src/index.ts")).toBeUndefined();
    expect(isSupportedManifest("src/index.ts")).toBe(false);
  });

  it("inventories the manifests it cannot parse", () => {
    expect(UNSUPPORTED_MANIFESTS).toContain("Podfile");
    expect(UNSUPPORTED_MANIFESTS).toContain("pubspec.yaml");
  });
});

describe("parseManifest — package.json", () => {
  it("reads all four dependency sections", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vitest: "5.0.3" },
        peerDependencies: { react: ">=18" },
        optionalDependencies: { fsevents: "~2.3.0" },
      }),
    );
    expect(result.records).toHaveLength(4);
    expect(result.records.map((record) => record.section)).toEqual([
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]);
    expect(result.records[0]).toMatchObject({
      registry: "npm",
      dialect: "semver",
      category: "library",
      name: "react",
      constraint: "^19.0.0",
    });
  });

  it("reads a workspace dependency's range", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({ dependencies: { local: "workspace:^2.0.0" } }),
    );
    expect(result.records[0].constraint).toBe("^2.0.0");
  });

  it("leaves a malformed alias uncomparable", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({ dependencies: { local: "npm:2.0" } }),
    );
    expect(result.records[0].constraint).toBe("npm:2.0");
  });

  it("splits an npm alias into the real package and its range", () => {
    const result = parseManifest(
      "package.json",
      JSON.stringify({ dependencies: { alias: "npm:real-package@^2.0.0" } }),
    );
    expect(result.records[0]).toMatchObject({
      name: "alias",
      constraint: "^2.0.0",
      resolvedName: "real-package",
    });
  });

  it("warns instead of returning nothing for a broken manifest", () => {
    const result = parseManifest("package.json", "{not json");
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — requirements", () => {
  it("reads pinned, ranged, and compatible-release constraints", () => {
    const result = parseManifest(
      "requirements",
      ["flask==3.0.0", "requests>=2.31.0", "urllib3~=2.2.0", "idna[extra]==3.7"].join("\n"),
    );
    expect(result.records.map((record) => record.constraint)).toEqual([
      "==3.0.0",
      ">=2.31.0",
      "~=2.2.0",
      "==3.7",
    ]);
    expect(result.records[0]).toMatchObject({ registry: "pypi", dialect: "pep440" });
  });

  it("ignores an environment marker and a comment", () => {
    const result = parseManifest(
      "requirements",
      ["# a comment", "flask==3.0.0 ; python_version >= '3.9'"].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0].constraint).toBe("==3.0.0");
  });
});

describe("parseManifest — pyproject arrays", () => {
  it("keeps a compound constraint in one requirement", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", 'dependencies = ["flask>=2,<3", "httpx>=1"]'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask", "httpx"]);
    expect(result.records[0].constraint).toBe(">=2,<3");
  });

  it("reads several items on one line of a multi-line array", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", "dependencies = [", '  "flask>=2", "httpx>=1"', "]"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask", "httpx"]);
  });

  it("warns about an array that is never closed", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", 'dependencies = ["flask>=2"'].join("\n"),
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — pyproject", () => {
  it("reads the PEP 621 dependency list", () => {
    const result = parseManifest(
      "pyproject",
      [
        "[project]",
        'name = "x"',
        "dependencies = [",
        '  "flask>=3.0",',
        '  "httpx==0.28.1",',
        "]",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask", "httpx"]);
    expect(result.records[0].constraint).toBe(">=3.0");
  });

  it("reads an optional-dependencies group", () => {
    const result = parseManifest(
      "pyproject",
      ["[project.optional-dependencies]", "test = [", '  "pytest>=8.0",', "]"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "pytest",
      section: "project.optional-dependencies.test",
    });
  });

  it("reports a per-package optional group as the wrong shape", () => {
    const result = parseManifest(
      "pyproject",
      ["[project.optional-dependencies.test]", 'pytest = ">=8.0"'].join("\n"),
    );
    // A group's value is an array of requirement strings, so a name and a
    // constraint under it is a diagnostic, not a declaration.
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain(
      "pyproject.toml group test is not a list of requirements",
    );
  });

  it("reads an optional group whose value is a list of requirements", () => {
    const result = parseManifest(
      "pyproject",
      ["[project.optional-dependencies]", 'test = ["pytest>=8.0"]'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "pytest",
      constraint: ">=8.0",
      section: "project.optional-dependencies.test",
    });
  });

  it("warns when the manifest declares no dependency list", () => {
    const result = parseManifest("pyproject", '[project]\nname = "x"\n');
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — pom.xml", () => {
  it("reads dependency elements", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<dependencies>",
        "<dependency>",
        "<groupId>org.slf4j</groupId>",
        "<artifactId>slf4j-api</artifactId>",
        "<version>2.0.9</version>",
        "</dependency>",
        "<dependency>",
        "<groupId>com.google.guava</groupId>",
        "<artifactId>guava</artifactId>",
        "<version>33.0.0-jre</version>",
        "</dependency>",
        "</dependencies>",
        "</project>",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "org.slf4j:slf4j-api",
      "com.google.guava:guava",
    ]);
    expect(result.records[0]).toMatchObject({
      registry: "maven",
      dialect: "maven",
      name: "org.slf4j:slf4j-api",
      constraint: "2.0.9",
    });
    expect(result.records[1]).toMatchObject({
      name: "com.google.guava:guava",
      constraint: "33.0.0-jre",
    });
  });

  it("keeps a property-backed version as an unresolvable constraint", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        "<version>${lib.version}</version>",
        "</dependency>",
      ].join("\n"),
    );
    expect(result.records[0].constraint).toBe("${lib.version}");
  });
});

describe("parseManifest — pom.xml", () => {
  it("ignores a dependency inside a comment", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<!--",
        "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>9</version></dependency>",
        "-->",
        "</project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("ignores a dependency inside a CDATA section", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project><![CDATA[",
        "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>9</version></dependency>",
        "]]></project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("warns about a comment that is never closed", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<!--",
        "<dependency><groupId>g</groupId><artifactId>a</artifactId><version>9</version></dependency>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns about a document that is not XML", () => {
    const result = parseManifest("pom.xml", "not XML");
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("warns about a malformed document", () => {
    const result = parseManifest("pom.xml", "<project><dependency><groupId>g</groupId>");
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — Cargo.toml", () => {
  it("does not borrow a version from the next table", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies.foo]", "workspace = true", "", "[package]", 'version = "9.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reads the dependency tables", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[package]",
        'name = "x"',
        "[dependencies]",
        'serde = "1.0"',
        'tokio = { version = "1.40", features = ["full"] }',
        "[dev-dependencies]",
        'tempfile = "3.10"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["serde", "tokio", "tempfile"]);
    expect(result.records[1].constraint).toBe("1.40");
    expect(result.records[2].section).toBe("dev-dependencies");
  });

  it("reads a per-dependency table", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies.serde]", 'version = "1.0"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "serde", constraint: "1.0" });
  });

  it("reads a quoted dependency key", () => {
    const result = parseManifest("Cargo.toml", ["[dependencies]", '"my-crate" = "1.0"'].join("\n"));
    expect(result.records[0]).toMatchObject({ name: "my-crate", constraint: "1.0" });
  });

  it("keeps a hash inside a quoted value", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'serde = "1.0" # a " # comment'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "serde", constraint: "1.0" });
  });

  it("reports a dependency section that is not a table", () => {
    // A section that is null is not a table of dependencies, and reading it
    // as one would fail rather than report.
    const result = parseManifest("package.json", JSON.stringify({ dependencies: null }));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain(
      "package.json dependencies is not a table of dependencies",
    );
  });

  it("warns about a table it does not read, and names the table", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[workspace.dependencies]", 'serde = "1.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain(
      "Cargo.toml table [workspace.dependencies] is not read",
    );
  });

  it("warns about an empty table it does not read", () => {
    // A table is declared whether or not it holds an assignment.
    const result = parseManifest("Cargo.toml", ["[workspace.dependencies]"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain(
      "Cargo.toml table [workspace.dependencies] is not read",
    );
  });

  it("warns about a dependency with no literal version", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", "serde.workspace = true"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — go.mod", () => {
  it("ignores a replace directive", () => {
    const result = parseManifest(
      "go.mod",
      [
        "module example.com/app",
        "require example.com/m v1.2.3",
        "replace example.com/m => example.com/fork v1.2.4",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["example.com/m"]);
  });

  it("reports an include it does not follow", () => {
    // Every spelling of an include names a file the reader does not follow.
    for (const include of [
      "-r other.txt",
      "-rother.txt",
      "--requirement other.txt",
      "--requirement=other.txt",
      "-c constraints.txt",
      "-e .",
    ]) {
      const result = parseManifest("requirements", [include, "flask==3.0.0"].join("\n"));
      expect(
        result.records.map((record) => record.name),
        include,
      ).toEqual(["flask"]);
      expect(result.warnings.join("\n"), include).toContain("which is not read");
    }
  });

  it("stays silent about the options a requirements file may carry", () => {
    const result = parseManifest(
      "requirements",
      ["--index-url https://example.test/simple", "flask==3.0.0"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask"]);
    expect(result.warnings).toEqual([]);
  });

  it("reads a require block and ignores a replace directive", () => {
    const result = parseManifest(
      "go.mod",
      [
        "module example.com/app",
        "require (",
        "\tgithub.com/stretchr/testify v1.9.0",
        "\tgolang.org/x/net v0.27.0",
        ")",
        "replace golang.org/x/net => example.com/fork v0.27.0",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "github.com/stretchr/testify",
      "golang.org/x/net",
    ]);
  });

  it("reports a block it never closes, and trusts nothing in the file", () => {
    const result = parseManifest(
      "go.mod",
      ["module example.com/app", "require (", "\tgithub.com/stretchr/testify v1.9.0"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("go.mod has a block that is never closed");
  });

  it("reads a require block and a single-line require", () => {
    const result = parseManifest(
      "go.mod",
      [
        "module example.com/app",
        "require (",
        "\tgithub.com/stretchr/testify v1.9.0",
        "\tgolang.org/x/net v0.27.0 // indirect",
        ")",
        "require github.com/spf13/cobra v1.8.1",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "github.com/stretchr/testify",
      "golang.org/x/net",
      "github.com/spf13/cobra",
    ]);
    expect(result.records[0]).toMatchObject({
      registry: "go",
      dialect: "go",
      constraint: "v1.9.0",
    });
  });
});
