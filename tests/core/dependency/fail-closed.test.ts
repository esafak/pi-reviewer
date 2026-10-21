import { describe, expect, it } from "vite-plus/test";

import { parseManifest } from "../../../src/core/dependency/manifests.js";
import { classifyVersionChange } from "../../../src/core/dependency/versions.js";

describe("a reader that must not invent a version", () => {
  it("does not read a version out of a string in an inline table", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", `foo = { path = "x\\", version = \\"9.0", version = "1.0" }`].join("\n"),
    );
    expect(result.records[0]?.constraint).not.toBe("9.0");
  });

  it("publishes no records when an inline table is uncertain", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", `foo = { version = "1.0", path = "vendor\\q" }`].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when a statement has trailing content", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = "1.0" trailing-junk'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when array elements are not separated", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", 'dependencies = ["flask>=1" "httpx>=2"]'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not read the assignments under an array of tables", () => {
    const result = parseManifest("Cargo.toml", ["[[dependencies]]", 'foo = "9.0"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records for a tag with invalid attributes", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project broken=>",
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

  it("publishes no records for an unquoted attribute value", () => {
    const result = parseManifest(
      "pom.xml",
      ["<project>", "<broken a=a />", "</project>"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("the remaining fail-closed paths", () => {
  it("publishes no records when a skipped region has a syntax error", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[[bin]]", 'name = "unterminated', "[dependencies]", 'foo = "9.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when a statement has no value", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[package]", "broken line", "[dependencies]", 'foo = "9.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records when an array element is not separated", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[package.metadata]",
        'ignored = [{ note = "ok" } "\\q"]',
        "[dependencies]",
        'foo = "9.0"',
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("publishes no records for a repeated comma in an inline table", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { version = "9.0",, path = "vendor/foo" }'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reads an empty array in an inline table", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", 'foo = { version = "1.0", features = [] }'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "foo", constraint: "1.0" });
  });

  it("publishes no records for a repeated attribute", () => {
    const result = parseManifest(
      "pom.xml",
      [
        '<project x="1" x="2">',
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

  it("publishes no records for attributes that are not separated", () => {
    const result = parseManifest(
      "pom.xml",
      [
        '<project x="1"y="2">',
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

describe("version components that cannot be represented", () => {
  it("rejects a release component beyond the exact integer range", () => {
    expect(classifyVersionChange("semver", "1.0.0", "9007199254740992.0.0")?.kind).toBe(
      "unresolved",
    );
  });

  it("rejects a PEP 440 epoch beyond the exact integer range", () => {
    expect(
      classifyVersionChange("pep440", "9007199254740993!1.0", "9007199254740992!2.0")?.kind,
    ).toBe("unresolved");
  });

  it("rejects a PEP 440 suffix number beyond the exact integer range", () => {
    expect(classifyVersionChange("pep440", "1.0rc1", "1.0rc9007199254740993")?.kind).toBe(
      "unresolved",
    );
  });
});

describe("PEP 440 across post-release numbers", () => {
  it("orders a development release of a later post-release after an earlier one", () => {
    expect(classifyVersionChange("pep440", "1.0rc1.post1", "1.0rc1.post2.dev1")?.kind).toBe(
      "patch",
    );
  });
});
