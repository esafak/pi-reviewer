import { describe, expect, it } from "vite-plus/test";

import { parseManifest } from "../../../src/core/dependency/manifests.js";

describe("the last validation gaps", () => {
  it("publishes no records when a nested array hides a syntax error", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[package.metadata]", 'ignored = [["ok"] "\\q"]', "", "[dependencies]", 'foo = "9.0"'].join(
        "\n",
      ),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when a table header has trailing content", () => {
    const result = parseManifest("Cargo.toml", ['[dependencies]foo = "9.0"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when an inline table repeats a key", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { version = "9.0", version = "1.0" }'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records for a raw less-than sign in an attribute value", () => {
    const result = parseManifest(
      "pom.xml",
      [
        '<project x="<">',
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        "<version>9.0</version>",
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when a declaration hides markup", () => {
    const result = parseManifest(
      "pom.xml",
      [
        '<!DOCTYPE ignored SYSTEM "><project><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency>">',
        "</project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when a bare array value hides a syntax error", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[package.metadata]",
        'ignored = [true "\\q" # comment',
        "]",
        "",
        "[dependencies]",
        'foo = "9.0"',
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when an inline table entry has no value", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { version = "1.0", path = }'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not read a quoted key as a reserved field", () => {
    const before = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { path = "vendor/foo", "version " = "1.0" }'].join("\n"),
    );
    const after = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { path = "vendor/foo", "version " = "9.0" }'].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
    expect(before.warnings.length).toBeGreaterThan(0);
    expect(after.warnings.length).toBeGreaterThan(0);
  });

  it("does not read a compound key as a reserved field", () => {
    const before = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { path = "vendor/foo", metadata."version" = "1.0" }'].join("\n"),
    );
    const after = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { path = "vendor/foo", metadata."version" = "9.0" }'].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
    expect(before.warnings.length).toBeGreaterThan(0);
    expect(after.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records for a quoted key followed by another", () => {
    const result = parseManifest("Cargo.toml", ['"x" "version" = "9.0"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records for a bare key followed by a quoted one", () => {
    const result = parseManifest("Cargo.toml", ['not"version" = "9.0"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not read an empty path segment as a reserved field", () => {
    const before = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { path = "vendor/foo", "".version = "1.0" }'].join("\n"),
    );
    const after = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { path = "vendor/foo", "".version = "9.0" }'].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
  });

  it("does not read a literal dot as a scope separator", () => {
    const before = parseManifest(
      "pyproject",
      ['"tool.poetry.dependencies".flask = ">=1.0"'].join("\n"),
    );
    const after = parseManifest(
      "pyproject",
      ['"tool.poetry.dependencies".flask = ">=9.0"'].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
  });

  it("does not read a table below a dependency as another package", () => {
    const before = parseManifest(
      "Cargo.toml",
      [
        "[dependencies.foo]",
        'version = "1.0"',
        'path = "vendor/foo"',
        "",
        "[dependencies.foo.metadata]",
        'version = "1.0"',
      ].join("\n"),
    );
    const after = parseManifest(
      "Cargo.toml",
      [
        "[dependencies.foo]",
        'version = "1.0"',
        'path = "vendor/foo"',
        "",
        "[dependencies.foo.metadata]",
        'version = "9.0"',
      ].join("\n"),
    );
    expect(before.records).toHaveLength(1);
    expect(after.records).toHaveLength(1);
    expect(before.records[0]).toMatchObject({ name: "foo", constraint: "1.0" });
    expect(after.records[0]).toMatchObject({ name: "foo", constraint: "1.0" });
  });

  it("publishes no records when a version is declared twice", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies.foo]", 'version = "9.0"', 'version = "1.0"', 'path = "vendor/foo"'].join(
        "\n",
      ),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reads two instances of an array as separate scopes", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[[bin]]",
        'name = "one"',
        'path = "src/one.rs"',
        "",
        "[[bin]]",
        'name = "two"',
        'path = "src/two.rs"',
        "",
        "[dependencies]",
        'foo = "1.0"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["foo"]);
    expect(result.records[0]).toMatchObject({ constraint: "1.0" });
  });

  it("does not read a table below an array the reader does not interpret", () => {
    const before = parseManifest(
      "Cargo.toml",
      [
        "[[dependencies]]",
        'note = "not interpreted"',
        "",
        "[dependencies.foo]",
        'version = "1.0"',
      ].join("\n"),
    );
    const after = parseManifest(
      "Cargo.toml",
      [
        "[[dependencies]]",
        'note = "not interpreted"',
        "",
        "[dependencies.foo]",
        'version = "9.0"',
      ].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
  });

  it("does not read a compound assignment that names an array", () => {
    const before = parseManifest(
      "Cargo.toml",
      [
        "[[dependencies.foo]]",
        'note = "unsupported"',
        "",
        "[dependencies]",
        'foo.version = "1.0"',
      ].join("\n"),
    );
    const after = parseManifest(
      "Cargo.toml",
      [
        "[[dependencies.foo]]",
        'note = "unsupported"',
        "",
        "[dependencies]",
        'foo.version = "9.0"',
      ].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
  });

  it("does not let a literal array name hide a supported table", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        ['["dependencies.foo"]'],
        'note = "unrelated"',
        "",
        "[dependencies.foo]",
        'version = "9.0"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["foo"]);
    expect(result.records[0]).toMatchObject({ constraint: "9.0" });
  });

  it("does not read a requirement array where a group table belongs", () => {
    const before = parseManifest(
      "pyproject",
      ["[project]", 'optional-dependencies = ["foo>=1.0"]'].join("\n"),
    );
    const after = parseManifest(
      "pyproject",
      ["[project]", 'optional-dependencies = ["foo>=9.0"]'].join("\n"),
    );
    expect(before.records).toHaveLength(0);
    expect(after.records).toHaveLength(0);
    expect(before.warnings.length).toBeGreaterThan(0);
    expect(after.warnings.length).toBeGreaterThan(0);
  });

  it("does not read a requirement table where an array belongs", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", 'dependencies = { foo = ">=9.0" }'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reads the inline spelling of an optional-dependency group table", () => {
    const before = parseManifest(
      "pyproject",
      ["[project]", 'optional-dependencies = { test = ["pytest>=7.0"] }'].join("\n"),
    );
    const after = parseManifest(
      "pyproject",
      ["[project]", 'optional-dependencies = { test = ["pytest>=8.0"] }'].join("\n"),
    );
    expect(before.records.map((record) => record.name)).toEqual(["pytest"]);
    expect(after.records.map((record) => record.name)).toEqual(["pytest"]);
    expect(before.warnings).toHaveLength(0);
  });

  it("gives an inline group the same identity as the separate table", () => {
    const inline = parseManifest(
      "pyproject",
      ["[project]", 'optional-dependencies = { test = ["pytest>=7.0"] }'].join("\n"),
    );
    const separate = parseManifest(
      "pyproject",
      ["[project.optional-dependencies]", 'test = ["pytest>=7.0"]'].join("\n"),
    );
    expect(inline.records[0]?.section).toBe(separate.records[0]?.section);
    expect(inline.records[0]?.section).toBe("project.optional-dependencies.test");
  });

  it("reports no change when only the spelling of a group changes", () => {
    const inline = parseManifest(
      "pyproject",
      ["[project]", 'optional-dependencies = { test = ["pytest>=7.0"] }'].join("\n"),
    );
    const separate = parseManifest(
      "pyproject",
      ["[project.optional-dependencies]", 'test = ["pytest>=7.0"]'].join("\n"),
    );
    expect(inline.records[0]?.section).toBe(separate.records[0]?.section);
  });

  it("diagnoses a non-requirement element inside an inline group", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", "optional-dependencies = { test = [123] }"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not diagnose ordinary metadata as a dependency list", () => {
    const result = parseManifest(
      "pyproject",
      [
        "[project]",
        'keywords = ["example"]',
        'authors = [{ name = "Example" }]',
        'dependencies = ["flask>=3"]',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask"]);
    expect(result.warnings).toHaveLength(0);
  });

  it("diagnoses a requirement element that is not a requirement", () => {
    const result = parseManifest("pyproject", ["[project]", "dependencies = [123]"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records for a comment with a double hyphen", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<!-- bad--comment -->",
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        "<version>9.0</version>",
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
