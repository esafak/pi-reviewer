import { describe, expect, it } from "vite-plus/test";

import { parseManifest } from "../../../src/core/dependency/manifests.js";

describe("TOML constructs", () => {
  it("reads a table header whose whitespace is syntactic", () => {
    // The whitespace around a bare segment is syntactic, so a header
    // written with spaces names the same table as one written without.
    const result = parseManifest(
      "Cargo.toml",
      ["[ dependencies ]", 'serde = "1"', "", "[ target . cfg ]", 'name = "x"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["serde"]);
    expect(result.warnings.join("\n")).toContain("Cargo.toml table [target.cfg] is not read");
  });

  it("keeps an escaped quote and a comma inside a requirement string", () => {
    const result = parseManifest(
      "pyproject",
      [
        "[project]",
        "dependencies = [",
        '  "flask>=2; os_name == \\"a,b\\"",',
        '  "httpx>=1"',
        "]",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask", "httpx"]);
    expect(result.records[0].constraint).toBe(">=2");
  });

  it("ends a dependency table at an array of tables", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[dependencies]",
        'serde = "1"',
        "",
        "[[bin]]",
        'name = "server"',
        'path = "src/main.rs"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["serde"]);
  });

  it("does not read a header inside a multi-line string", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[package]",
        'description = """',
        "[dependencies]",
        'fake = "9.0"',
        '"""',
        "",
        "[dependencies]",
        'real = "1.0"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
  });

  it("warns about an array of tables it does not read", () => {
    const result = parseManifest("Cargo.toml", ["[[bin]]", 'name = "server"'].join("\n"));
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reads a poetry inline table", () => {
    const result = parseManifest(
      "pyproject",
      ["[tool.poetry.dependencies]", 'flask = "^3.0"'].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "flask", constraint: "^3.0" });
  });
});

describe("a reader that lost its place", () => {
  it("publishes no records when a multi-line string is never closed", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[package]", 'description = """', "[dependencies]", 'fake = "9.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("closes a multi-line string on an escaped delimiter", () => {
    const result = parseManifest(
      "Cargo.toml",
      [
        "[package]",
        'description = """',
        '\\"""',
        "[dependencies]",
        'fake = "9.0"',
        '"""',
        "",
        "[dependencies]",
        'real = "1.0"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
  });

  it("reads every entry of an inline table", () => {
    const result = parseManifest(
      "pyproject",
      ["[tool.poetry]", 'dependencies = { flask = ">=2", httpx = ">=1" }'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["flask", "httpx"]);
  });

  it("does not read a version out of a path", () => {
    const result = parseManifest(
      "Cargo.toml",
      ["[dependencies]", `foo = { path = 'vendor/version = "9.0"', version = "1.0" }`].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "foo", constraint: "1.0" });
  });

  it("reports an invalid unicode escape as coverage", () => {
    const result = parseManifest(
      "pyproject",
      ["[project]", 'description = "\\UFFFFFFFF"', 'dependencies = ["flask>=1"]'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("XML", () => {
  it("reads a dependency whose value is character data", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<dependency>",
        "<groupId><![CDATA[g]]></groupId>",
        "<artifactId>a</artifactId>",
        "<version>2.0</version>",
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "g:a", constraint: "2.0" });
  });

  it("does not mistake a comment inside character data for a comment", () => {
    const result = parseManifest(
      "pom.xml",
      ["<project>", "<description><![CDATA[<!--]]></description>", "</project>"].join("\n"),
    );
    expect(result.warnings).toHaveLength(0);
    expect(result.records).toHaveLength(0);
  });

  it("decodes a character reference", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        "<version>1&#46;0</version>",
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "g:a", constraint: "1.0" });
  });

  it("reads a tag whose attribute holds a greater-than sign", () => {
    const result = parseManifest(
      "pom.xml",
      [
        "<project>",
        "<dependency>",
        "<groupId>g</groupId>",
        "<artifactId>a</artifactId>",
        '<version note="x>y">1.0</version>',
        "</dependency>",
        "</project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "g:a", constraint: "1.0" });
  });

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
