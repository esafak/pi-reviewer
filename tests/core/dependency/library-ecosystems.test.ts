import { describe, expect, it } from "vite-plus/test";

import { compareManifests } from "../../../src/core/dependency/compare.js";
import { isBreakingRelevant } from "../../../src/core/dependency/threshold.js";
import { manifestFormat, parseManifest } from "../../../src/core/dependency/manifests.js";

describe("manifestFormat — the library ecosystems", () => {
  it("recognizes the manifests the detector reads", () => {
    expect(manifestFormat("src/App.csproj")).toBe("csproj");
    expect(manifestFormat("src/App.fsproj")).toBe("csproj");
    expect(manifestFormat("Directory.Packages.props")).toBe("packages.props");
    expect(manifestFormat("src/Directory.Packages.props")).toBe("packages.props");
    expect(manifestFormat("packages.config")).toBe("packages.config");
    expect(manifestFormat("Gemfile")).toBe("Gemfile");
    expect(manifestFormat("api/Gemfile")).toBe("Gemfile");
    expect(manifestFormat("composer.json")).toBe("composer.json");
    expect(manifestFormat("api/composer.json")).toBe("composer.json");
    expect(manifestFormat("build.gradle")).toBe("build.gradle");
    expect(manifestFormat("app/build.gradle.kts")).toBe("build.gradle");
  });

  it("does not claim a lockfile or a source file", () => {
    expect(manifestFormat("Gemfile.lock")).toBeUndefined();
    expect(manifestFormat("composer.lock")).toBeUndefined();
    expect(manifestFormat("packages.lock.json")).toBeUndefined();
    expect(manifestFormat("gradle.lockfile")).toBeUndefined();
    expect(manifestFormat("src/index.ts")).toBeUndefined();
  });
});

describe("parseManifest — csproj", () => {
  it("reads a package reference that carries its version in an attribute", () => {
    const result = parseManifest(
      "csproj",
      [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <ItemGroup>",
        '    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      registry: "nuget",
      dialect: "semver",
      category: "library",
      name: "Newtonsoft.Json",
      constraint: "13.0.3",
    });
  });

  it("reads a package reference that carries its version in an element", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog">',
        "      <Version>3.1.1</Version>",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "3.1.1" });
  });

  it("reads a package version element", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "<ItemGroup>",
        '<PackageVersion Include="Serilog" Version="3.1.1" />',
        "</ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "3.1.1" });
  });

  it("reports a package whose version the item does not carry", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "<ItemGroup>",
        '<PackageReference Include="Serilog" />',
        "</ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("the package Serilog has no version");
  });

  it("reports a version override the reader does not read", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "<ItemGroup>",
        '<PackageReference Include="Serilog" VersionOverride="3.1.1" />',
        "</ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("VersionOverride");
  });

  it("warns about a document that is not XML", () => {
    const result = parseManifest("csproj", "not XML");
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("does not read a package the manifest does not declare in an item group", () => {
    // A package reference in an extension's own metadata is not a
    // declaration.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ProjectExtensions>",
        '    <PackageReference Include="Evil" Version="9.9.9" />',
        "  </ProjectExtensions>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("is not declared where the reader reads");
  });

  it("does not read a package the manifest declares below its item group", () => {
    // An item group in an extension's own metadata is metadata.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ProjectExtensions>",
        "    <ItemGroup>",
        '      <PackageReference Include="Fake" Version="9" />',
        "    </ItemGroup>",
        "  </ProjectExtensions>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("is not declared where the reader reads");
  });

  it("does not read a version that is not a literal", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog">',
        "      <Version>1<Metadata>x</Metadata>.0</Version>",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("not a literal");
  });

  it("reports an item that names no package", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Version="1.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("names no package");
  });

  it("does not read a document that is not a project file", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Metadata>",
        "  <ItemGroup>",
        '    <PackageReference Include="Fake" Version="9" />',
        "  </ItemGroup>",
        "</Metadata>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("not the manifest the reader reads");
  });

  it("does not read a package a conditional branch declares", () => {
    // Only one of the branches of a conditional build runs, and the
    // reader cannot say which.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <Choose>",
        "    <When>",
        "      <ItemGroup>",
        '        <PackageReference Include="Real" Version="1.0" />',
        "      </ItemGroup>",
        "    </When>",
        "  </Choose>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("conditional");
  });

  it("reports a version override beside a version the reader reads", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Real" Version="1" VersionOverride="2" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("VersionOverride");
  });

  it("reports a version override the item holds as an element", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="1.0.0">',
        "      <VersionOverride>10.0.0</VersionOverride>",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("VersionOverride");
  });

  it("does not read a package an otherwise branch declares", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <Choose>",
        "    <Otherwise>",
        "      <ItemGroup>",
        '        <PackageReference Include="Real" Version="1.0" />',
        "      </ItemGroup>",
        "    </Otherwise>",
        "  </Choose>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("conditional");
  });

  it("publishes nothing when the document is nested too deeply", () => {
    const deep = `<Project>${"<X>".repeat(6000)}${"</X>".repeat(6000)}</Project>`;
    const result = parseManifest("csproj", deep);
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("nested too deeply");
  });

  it("reads the version an update sets", () => {
    // An update sets the version the package resolves to, so the version
    // it carries is the one the package has.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="3.0" />',
        '    <PackageReference Update="Serilog" Version="6.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "6.0" });
  });

  it("reads a version an update declares on its own", () => {
    const result = parseManifest(
      "packages.props",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageVersion Update="Serilog" Version="6.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "6.0" });
  });

  it("does not read a package an update overrides", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="1" />',
        '    <PackageReference Update="Serilog" VersionOverride="4" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("VersionOverride");
  });

  it("does not read a package an update makes conditional", () => {
    // The reader cannot say which version the project has.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageVersion Include="Serilog" Version="3" />',
        '    <PackageVersion Update="Serilog" Version="4" Condition="false" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("conditional");
  });

  it("does not read a package an item removes", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="1" />',
        '    <PackageReference Remove="Serilog" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("removed");
  });

  it("does not read a package a removal names in another case", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="3.0" />',
        '    <PackageReference Remove="serilog" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a package a conditional group declares", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup Condition=\"'$(TargetFramework)' == 'net8.0'\">",
        '    <PackageReference Include="Serilog" Version="3.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("conditional");
  });

  it("does not read a package two framework groups declare", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup Condition=\"'$(TargetFramework)' == 'net8.0'\">",
        '    <PackageReference Include="Serilog" Version="3.0" />',
        "  </ItemGroup>",
        "  <ItemGroup Condition=\"'$(TargetFramework)' == 'net9.0'\">",
        '    <PackageReference Include="Serilog" Version="4.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("reads a package an update changes the metadata of", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="4.0" />',
        '    <PackageReference Update="Serilog" PrivateAssets="all" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "4.0" });
  });

  it("does not read a package whose version is conditional", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog">',
        "      <Version Condition=\"'$(TargetFramework)' == 'net8.0'\">4.0</Version>",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("conditional");
  });

  it("reads the version the child metadata sets", () => {
    // The child metadata is the later spelling, and it wins.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="A" Version="1.0">',
        "      <Version>2.0</Version>",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "A", constraint: "2.0" });
  });

  it("does not read a package whose child version is empty", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="A" Version="1">',
        "      <Version />",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("has no version");
  });

  it("reads the version an include that follows an update carries", () => {
    // The update comes first, and it has no package to update yet.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Update="A" Version="2" />',
        '    <PackageReference Include="A" Version="1" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "A", constraint: "1" });
  });

  it("does not read a package an update clears", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="A" Version="1" />',
        '    <PackageReference Update="A" Version="" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("has no version");
  });

  it("reads the version the last of several updates sets", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageVersion Update="A" Version="1" />',
        '    <PackageVersion Update="A" Version="2" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ name: "A", constraint: "2" });
  });

  it("does not read a package whose name is a property reference", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="$(LoggingPackage)" Version="9.0.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("names a package the reader does not read");
  });

  it("does not read a package whose name is an item expression", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="@(References)" Version="1.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a package the manifest excludes", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Exclude="Serilog" Version="4.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("excluded");
  });

  it("does not read a package a mutation that names any package may touch", () => {
    for (const mutation of [
      '<PackageReference Update="@(PackageReference)" Version="4.0.0" />',
      '<PackageReference Remove="*" />',
    ]) {
      const result = parseManifest(
        "csproj",
        [
          "<Project>",
          "  <ItemGroup>",
          '    <PackageReference Include="Serilog" Version="3.0.0" />',
          `    ${mutation}`,
          "  </ItemGroup>",
          "</Project>",
        ].join("\n"),
      );
      expect(result.records, mutation).toHaveLength(0);
    }
  });

  it("does not read a package an override sits beside", () => {
    // The override is a version the reader does not read, so the package
    // is not read either: another declaration of it may name the version
    // the override replaces.
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="2.0.0" />',
        '    <PackageReference Include="Serilog" Version="2.0.0" VersionOverride="4.0.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("VersionOverride");
  });

  it("does not read a package whose standalone update override is later replaced", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Update="Serilog" Version="2.0.0" VersionOverride="4.0.0" />',
        '    <PackageReference Update="Serilog" Version="2.0.0" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("VersionOverride");
  });

  it("does not read a package an update declares more than one version for", () => {
    const result = parseManifest(
      "csproj",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageReference Include="Serilog" Version="3.0" />',
        '    <PackageReference Update="Serilog">',
        "      <Version Condition=\"'$(TargetFramework)' == 'net8.0'\">8.0</Version>",
        "      <Version Condition=\"'$(TargetFramework)' == 'net9.0'\">9.0</Version>",
        "    </PackageReference>",
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("more than one version");
  });

  it("reads the version an update that changes the metadata keeps", () => {
    const result = parseManifest(
      "packages.props",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageVersion Update="Serilog" Version="4.0" />',
        '    <PackageVersion Update="Serilog" PrivateAssets="all" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "4.0" });
  });
});

describe("parseManifest — Directory.Packages.props", () => {
  it("reads the package versions it declares", () => {
    const result = parseManifest(
      "packages.props",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      registry: "nuget",
      dialect: "semver",
      name: "Newtonsoft.Json",
      constraint: "13.0.3",
    });
  });

  it("reads a package the file updates", () => {
    const result = parseManifest(
      "packages.props",
      [
        "<Project>",
        "  <ItemGroup>",
        '    <PackageVersion Update="Serilog" Version="3.1.1" />',
        "  </ItemGroup>",
        "</Project>",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({ name: "Serilog", constraint: "3.1.1" });
  });
});

describe("parseManifest — packages.config", () => {
  it("reads the packages the legacy format declares", () => {
    const result = parseManifest(
      "packages.config",
      [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<packages>",
        '  <package id="Newtonsoft.Json" version="13.0.3" targetFramework="net48" />',
        "</packages>",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      registry: "nuget",
      dialect: "semver",
      name: "Newtonsoft.Json",
      constraint: "13.0.3",
    });
  });
});

describe("parseManifest — Gemfile", () => {
  it("reads a pinned gem and a ranged gem", () => {
    const result = parseManifest(
      "Gemfile",
      ['source "https://rubygems.org"', 'gem "rails", "7.0.4"', 'gem "rspec", "~> 3.12"'].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails", "rspec"]);
    expect(result.records[0]).toMatchObject({
      registry: "rubygems",
      dialect: "semver",
      category: "library",
      constraint: "7.0.4",
    });
    expect(result.records[1].constraint).toBe("~> 3.12");
  });

  it("keeps a gem with more than one requirement as one constraint", () => {
    const result = parseManifest("Gemfile", ['gem "rails", ">= 7.0", "< 8.0"'].join("\n"));
    expect(result.records[0].constraint).toBe(">= 7.0, < 8.0");
  });

  it("ignores a gem that is written in a comment", () => {
    const result = parseManifest("Gemfile", ['# gem "rails", "7.0.4"'].join("\n"));
    expect(result.records).toHaveLength(0);
  });

  it("reports a gem the project does not pin", () => {
    const result = parseManifest("Gemfile", ['gem "puma"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("gem puma has no version");
  });

  it("does not read a gem the registry does not publish", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "demo", git: "https://example.test/demo.git"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("which is not read");
  });

  it("reports a directive the reader does not read", () => {
    const result = parseManifest("Gemfile", ["gemspec"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("gemspec");
  });

  it("does not read a gem out of a heredoc", () => {
    // A heredoc is a string, and a string may hold a declaration that
    // means nothing.
    const result = parseManifest(
      "Gemfile",
      ["TEXT = <<~DOC", '  gem "rails", "8.0"', "DOC", 'gem "rspec", "~> 3.12"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rspec"]);
    expect(result.warnings.join("\n")).toContain("heredoc");
  });

  it("does not read a gem out of a block comment", () => {
    const result = parseManifest(
      "Gemfile",
      ["=begin", 'gem "rails", "8.0"', "=end", 'gem "rspec", "~> 3.12"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rspec"]);
  });

  it("does not read a computed version as a literal", () => {
    const result = parseManifest("Gemfile", ['gem "rails", "7.0" + suffix'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("version the reader does not read");
  });

  it("does not read a gem that comes from a source", () => {
    // The gems inside the block are published by the repository, not by
    // the registry, and the registry has no release notes for them.
    const result = parseManifest(
      "Gemfile",
      [
        'git "https://example.test/fork.git" do',
        '  gem "rails", "8.0"',
        "end",
        'gem "rspec", "~> 3.12"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rspec"]);
    expect(result.warnings.join("\n")).toContain("comes from a source");
  });

  it("reads a gem a group declares", () => {
    // The group is not part of the gem's identity, and the block it opens
    // is not a source.
    const result = parseManifest(
      "Gemfile",
      ["group :development do", '  gem "rspec", "~> 3.12"', "end"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rspec"]);
    expect(result.warnings).toEqual([]);
  });

  it("reads a gem the public source publishes", () => {
    const result = parseManifest(
      "Gemfile",
      ['source "https://rubygems.org"', 'gem "rails", "8.0"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("does not read a gem a private source publishes", () => {
    const result = parseManifest(
      "Gemfile",
      ['source "https://gems.example.test"', 'gem "rails", "8.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("comes from a source");
  });

  it("publishes nothing when the file cannot be read", () => {
    // A string the file never closes means the reader no longer knows
    // where the declarations are.
    const result = parseManifest(
      "Gemfile",
      ['gem "rails", "7.0', 'gem "rspec", "~> 3.12"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("does not read a gem out of a percent string", () => {
    const result = parseManifest(
      "Gemfile",
      ["description = %q{", 'gem "fake", "1.0"', "}"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("percent string");
  });

  it("does not read a gem out of a labelled block comment", () => {
    const result = parseManifest(
      "Gemfile",
      ["=begin documentation", 'gem "fake", "1.0"', "=end", 'gem "real", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
  });

  it("does not read a gem out of the second of two heredocs", () => {
    const result = parseManifest(
      "Gemfile",
      ["puts <<A, <<B", "first", "A", 'gem "fake", "1.0"', "B"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("publishes nothing when a call is never closed", () => {
    const result = parseManifest("Gemfile", ['gem "real", "1"', 'gem("broken", "2"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("does not read a gem a brace block sources", () => {
    const result = parseManifest(
      "Gemfile",
      ['git("https://example.test/fork") {', '  gem "fake", "9"', "}", 'gem "real", "1"'].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
    expect(result.warnings.join("\n")).toContain("comes from a source");
  });

  it("does not read a gem a private source publishes", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "private-gem", "1", source: "https://private.example.test"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("comes from a source");
  });

  it("does not read a gem a computed source publishes", () => {
    // The address of the source is computed, so the reader cannot know
    // that it is the public registry.
    const result = parseManifest(
      "Gemfile",
      ['source "https://rubygems.org" + ".evil.example"', 'gem "real", "1"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("reads a gem the parenthesised public source publishes", () => {
    const result = parseManifest(
      "Gemfile",
      ['source("https://rubygems.org")', 'gem "real", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
  });

  it("reads a gem a public source block publishes", () => {
    const result = parseManifest(
      "Gemfile",
      ['source "https://rubygems.org" do', '  gem "rack", "1"', "end"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem a private source declared later publishes", () => {
    // The source takes the gems of the whole file, whatever order the
    // file declares them in.
    const result = parseManifest(
      "Gemfile",
      ['gem "rack", "1"', 'source "https://private.example"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("takes its gems from a source");
  });

  it("does not read a gem out of a nested percent string", () => {
    const result = parseManifest(
      "Gemfile",
      ["x = %q{ outer {", "}", 'gem "fake", "9"', "} + %q{suffix}", 'gem "rack", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem out of a regular expression", () => {
    const result = parseManifest(
      "Gemfile",
      ["x = /", 'gem "fake", "9"', "/", 'gem "rack", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem out of the data section", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "rack", "1"', "__END__", 'gem "fake", "9"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("reads a gem a labelled block comment precedes", () => {
    const result = parseManifest(
      "Gemfile",
      ["=begin label", "documentation", "=end label", 'gem "rack", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("reads a gem a multi-line string precedes", () => {
    const result = parseManifest(
      "Gemfile",
      ['message = "hello', 'world"', 'gem "rack", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("publishes nothing when a delimiter does not match", () => {
    const result = parseManifest("Gemfile", ['gem "rack", "1"', "x = ([)]"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("does not read a gem whose name interpolates", () => {
    // An interpolation holds a string of its own, and the reader cannot
    // say where it ends, so the file is reported rather than read.
    const result = parseManifest("Gemfile", ['gem "#{package}", "1"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("does not read a gem out of an interpolation that runs on", () => {
    const result = parseManifest(
      "Gemfile",
      [
        'source "https://rubygems.org"',
        'x = "#{ "',
        "gem 'phantom', '1.0.0'",
        '" }"',
        'gem "rack", "3.0.0"',
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("does not read a gem whose name interpolates a variable", () => {
    const result = parseManifest("Gemfile", ['gem "rack#@suffix", "1"'].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("name the reader does not read");
  });

  it("does not read a gem out of a command string", () => {
    const result = parseManifest(
      "Gemfile",
      ["message = `echo hello", 'gem "fake", "9"', "`", 'gem "rack", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem out of the second of two percent strings", () => {
    const result = parseManifest(
      "Gemfile",
      ["x = %q{hi} + %q|", 'gem "fake", "9"', "|", 'gem "rack", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem out of two percent strings that span lines", () => {
    const result = parseManifest(
      "Gemfile",
      ["x = %q|", "text", "| + %q|", 'gem "fake", "9.0"', "|"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("reads a gem that carries a percent literal in an option", () => {
    // The percent literal is a value of another option, and it does not
    // hide the gem.
    const result = parseManifest(
      "Gemfile",
      ['gem "capybara", "~> 3.40", require: %w[capybara/rspec]'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["capybara"]);
    expect(result.records[0].constraint).toBe("~> 3.40");
  });

  it("does not read a backtick inside a string as a command", () => {
    const result = parseManifest(
      "Gemfile",
      ['message = "Use ` for command substitution"', 'gem "rails", "7.0"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("does not run out of stack on a file that holds many percent strings", () => {
    const result = parseManifest("Gemfile", `x = ${Array(18000).fill("%q{a}").join(" + ")}`);
    expect(result.records).toHaveLength(0);
  });

  it("does not read a heredoc a closing percent delimiter opens", () => {
    const result = parseManifest(
      "Gemfile",
      ["x = %q|", "hello", "| + <<~DOC", 'gem "fake", "9"', "DOC", 'gem "rack", "3"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("reads a gem a multiline percent literal carries", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "capybara", "~> 3.40", require: %w[', "  capybara/rspec", "]", 'gem "rack", "3"'].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["capybara", "rack"]);
  });

  it("does not read a backtick a percent literal holds", () => {
    const result = parseManifest("Gemfile", ["x = %q|`|", 'gem "rack", "3"'].join("\n"));
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a percent literal's brackets as code", () => {
    const result = parseManifest(
      "Gemfile",
      ["message = %q|a [ character|", "gem 'rails', '7.0'"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("reads a gem that carries an options hash", () => {
    const result = parseManifest(
      "Gemfile",
      ["gem 'rspec', '~> 3.13', :require => false", "gem 'rails', '7.0', {require: false}"].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rspec", "rails"]);
  });

  it("does not read a gem a source option names", () => {
    for (const options of [
      ':git => "https://github.com/acme/rails.git"',
      '{git: "https://github.com/acme/rails.git"}',
      ':source => "https://private.example"',
    ]) {
      const result = parseManifest("Gemfile", `gem "rails", "7.0", ${options}`);
      expect(result.records, options).toHaveLength(0);
    }
  });

  it("reads a gem a public source option names", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "rails", "7.0", :source => "https://rubygems.org"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("does not read a gem a source after a regular expression takes", () => {
    const result = parseManifest(
      "Gemfile",
      ['x = /abc/; source "https://private.example"', "gem 'rails', '7.0'"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("publishes nothing when a regular expression is never closed", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "real", "1.0"', "x = /abc/ + /never closed"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a gem out of a percent string with an interpolation", () => {
    const result = parseManifest(
      "Gemfile",
      ['note = %Q|#{ "|', "gem 'phantom', '9.0'", '%Q| text " }|'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("does not read a declaration out of a triple-quoted interpolation", () => {
    const result = parseManifest(
      "build.gradle",
      [
        'def s = """${ \'\'\'"""',
        'dependencies { implementation("phantom:lib:9") }',
        "''' }\"\"\"",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("does not read a gem out of a percent string that interpolates", () => {
    const result = parseManifest(
      "Gemfile",
      ["x = %Q!", "#{ %q!", 'gem "phantom", "9"', "# ! }", "!"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("reads a gem a comment that names an interpolation precedes", () => {
    // A comment holds no string, and the text it holds is not an
    // interpolation.
    const result = parseManifest(
      "Gemfile",
      ["=begin", "Documentation uses #{name} syntax.", "=end", 'gem "rails", "8.0.0"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("reads a gem a raw percent string precedes", () => {
    // The raw form's extent is known, and the text it holds is only text.
    const result = parseManifest(
      "Gemfile",
      ["note = %q[#{name}]", 'gem "rails", "8.0.0"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("does not read a gem an interpolating percent string precedes", () => {
    const result = parseManifest(
      "Gemfile",
      ["note = %Q[#{name}]", 'gem "rails", "8.0.0"'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("does not read a declaration out of a slashy property name", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "def example = [:]./Example build:",
        "dependencies {",
        '  implementation "example:phantom:9.0"',
        "}",
        "End of example/",
        "dependencies {",
        '  implementation "org.slf4j:slf4j-api:2.0.16"',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["org.slf4j:slf4j-api"]);
  });

  it("reads a gem a block comment that carries a quote precedes", () => {
    const result = parseManifest(
      "Gemfile",
      [
        'gem "rack", "3.0"',
        "=begin It's a block comment",
        "Example dependency declarations go here.",
        "=end",
        'gem "rails", "7.0"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack", "rails"]);
  });

  it("reads a gem a raw heredoc precedes", () => {
    // A heredoc written with single quotes is a raw one: its text is the
    // text between the terminators.
    const result = parseManifest(
      "Gemfile",
      [
        'gem "rack", "3.0"',
        "example = <<'RUBY'",
        'gem "rails", "#{version}"',
        "RUBY",
        'gem "rails", "7.0"',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack", "rails"]);
  });

  it("reads a gem a heredoc whose terminator is indented precedes", () => {
    // The plain form ends the heredoc at the first column, so an indented
    // terminator does not end it.
    const result = parseManifest(
      "Gemfile",
      ["example = <<'RUBY'", "  RUBY", 'gem "fake", "9.0"', "RUBY", 'gem "rails", "7.0"'].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("reads a gem a heredoc whose terminator carries a space precedes", () => {
    // The terminator's trailing space is a character of the line, and
    // the line is not the terminator.
    const result = parseManifest(
      "Gemfile",
      ["notes = <<-TEXT", "TEXT ", 'gem "phantom", "9.0"', "TEXT", 'gem "rack", "3.0"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("reads a gem a quoted heredoc delimiter precedes", () => {
    // The delimiter is read whole: an `END` line does not end a heredoc
    // whose delimiter is `END-DOC`.
    const result = parseManifest(
      "Gemfile",
      ['notes = <<"END-DOC"', "END", 'gem "phantom", "9.0"', "END-DOC", 'gem "rack", "3.0"'].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("reads a gem a quoted heredoc delimiter with a space precedes", () => {
    const result = parseManifest(
      "Gemfile",
      ["notes = <<'END DOC'", "END", 'gem "phantom", "2.0"', "END DOC", 'gem "real", "1.0"'].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
  });

  it("reads a gem a quoted heredoc delimiter with a quote precedes", () => {
    const result = parseManifest(
      "Gemfile",
      [
        "notes = <<\"END 'NOTES'\"",
        "gem 'phantom', '9.0'",
        "END 'NOTES'",
        "gem 'rails', '7.0'",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("reads a dependency a Kotlin raw string precedes", () => {
    // A Kotlin raw string processes no escape, so the backslash before
    // the terminator is a character of the string.
    const result = parseManifest(
      "build.gradle",
      [
        'val windowsPath = """C:\\tools\\"""',
        "dependencies {",
        '    implementation("org.slf4j:slf4j-api:2.0.16")',
        "}",
      ].join("\n"),
      "app/build.gradle.kts",
    );
    expect(result.records.map((record) => record.name)).toEqual(["org.slf4j:slf4j-api"]);
  });

  it("reads a dependency a Kotlin escaped quote precedes", () => {
    // Only a raw string processes no escape: an ordinary one does.
    const result = parseManifest(
      "build.gradle",
      [
        'val quote = "\\""',
        "dependencies {",
        '    implementation("org.slf4j:slf4j-api:2.0.16")',
        "}",
      ].join("\n"),
      "app/build.gradle.kts",
    );
    expect(result.records.map((record) => record.name)).toEqual(["org.slf4j:slf4j-api"]);
  });

  it("reads a dependency an Android build field precedes", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "android {",
        "    defaultConfig {",
        '        buildConfigField("String", "API_URL", "\\"https://example.com\\"")',
        "    }",
        "}",
        "dependencies {",
        '    implementation("org.slf4j:slf4j-api:2.0.16")',
        "}",
      ].join("\n"),
      "app/build.gradle.kts",
    );
    expect(result.records.map((record) => record.name)).toEqual(["org.slf4j:slf4j-api"]);
  });

  it("reads a gem a group on one line declares", () => {
    const result = parseManifest(
      "Gemfile",
      ['group(:development) { gem "rubocop", "~> 1.0" }'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rubocop"]);
  });

  it("does not read a gem a source block on one line takes", () => {
    const result = parseManifest(
      "Gemfile",
      [
        "source 'https://rubygems.org'",
        "git('https://github.com/acme/rails.git') { gem 'rails', '9.0' }",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("comes from a source");
  });

  it("does not read a gem a nested source block takes", () => {
    const result = parseManifest(
      "Gemfile",
      ["git('https://example.org/rails.git') { group(:development) { gem 'rails', '9.0' } }"].join(
        "\n",
      ),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("comes from a source");
  });

  it("reads two gems a block on one line declares", () => {
    const result = parseManifest(
      "Gemfile",
      ["group(:development) { gem 'rails', '9.0'; gem 'rack', '3.0' }"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails", "rack"]);
  });

  it("publishes nothing when the file is nested too deeply", () => {
    const result = parseManifest(
      "Gemfile",
      `${"group(:test) { ".repeat(3000)}gem 'x', '1'${" }".repeat(3000)}`,
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("nested too deeply");
  });

  it("publishes nothing when the file's blocks are nested too deeply", () => {
    const result = parseManifest(
      "Gemfile",
      `${"group do\n".repeat(20000)}gem 'x', '1'\n${"end\n".repeat(20000)}`,
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\\n")).toContain("nested too deeply");
  });

  it("publishes nothing when the build file is nested too deeply", () => {
    const result = parseManifest("build.gradle", `${"a {".repeat(20000)}${"}".repeat(20000)}`);
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("nested too deeply");
  });

  it("does not read a declaration out of a string in an operand position", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    def docs = /text; implementation 'fake:fake:9'; text/",
        "    implementation 'real:real:1'",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real:real"]);
  });

  it("does not read a declaration out of a string beside a concatenation", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    def docs = \"prefix\" + $/text; implementation 'fake:fake:9'; text/$",
        "    implementation 'real:real:1'",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real:real"]);
  });

  it("does not read a declaration out of a string beside an operator", () => {
    for (const operator of ["&&", "||", "*"]) {
      const result = parseManifest(
        "build.gradle",
        [
          "dependencies {",
          `    def docs = true ${operator} /text; implementation 'fake:fake:9'; text/`,
          "    implementation 'real:real:1'",
          "}",
        ].join("\n"),
      );
      expect(
        result.records.map((record) => record.name),
        operator,
      ).toEqual(["real:real"]);
    }
  });

  it("does not read a declaration out of a string beside a negation", () => {
    for (const [open, close] of [
      ["/", "/"],
      ["$/", "/$"],
    ]) {
      const result = parseManifest(
        "build.gradle",
        [
          "dependencies {",
          `    def docs = ! ${open}text; implementation 'g:phantom:1.0'; text${close}`,
          "    implementation 'real:real:1'",
          "}",
        ].join("\n"),
      );
      expect(
        result.records.map((record) => record.name),
        open,
      ).toEqual(["real:real"]);
    }
  });

  it("does not read a declaration out of a dollar-slashy string in an argument", () => {
    // The dollar-slashy pair opens a string wherever it appears.
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    println $/text; dependencies { implementation "phantom:artifact:1.0" }; text/$',
        "    implementation 'real:real:1'",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real:real"]);
  });

  it("does not read a declaration out of an interpolation", () => {
    // An interpolation holds a string of its own, and the reader cannot
    // say where it ends, so the file is reported rather than read.
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    def text = "${; dependencies { implementation \'phantom:artifact:9.0\' }; "}"',
        "    implementation 'real:real:1'",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("interpolation");
  });

  it("does not read a declaration out of an escaped triple quote", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "def note = '''",
        "\\'''",
        "dependencies { implementation 'fake:artifact:9.0' }",
        "\\'''",
        "'''",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a declaration out of a slashy interpolation", () => {
    for (const [open, close] of [
      ["/", "/"],
      ["$/", "/$"],
    ]) {
      const result = parseManifest(
        "build.gradle",
        [
          `def note = ${open}\${''' ${open}`,
          "dependencies { implementation 'fake:artifact:9.0' }",
          `/ '''}/${close}`,
        ].join("\n"),
      );
      expect(result.records, open).toHaveLength(0);
      expect(result.warnings.join("\n"), open).toContain("interpolation");
    }
  });

  it("reports a block comment that is never closed", () => {
    const result = parseManifest("Gemfile", ["=begin", "documentation"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("block comment is never closed");
  });

  it("reads a file that holds many divisions in its time", () => {
    // Reading a file stays linear in its length: the divisions are the
    // text the reader must look at, and nothing else may grow with them.
    const divisions = "a / b ".repeat(1000);
    const result = parseManifest("Gemfile", `${divisions}\ngem 'rack', '3'`);
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("reads a file that holds many braces in its time", () => {
    // The reader must not read the statement's source once per brace.
    const braces = "{},".repeat(4000);
    const result = parseManifest(
      "Gemfile",
      [`source "https://rubygems.org"; x = [${braces}{}]`, 'gem "rails", "7.0"'].join("\n"),
    );
    expect(result.records.length).toBeLessThanOrEqual(1);
  });

  it("reads a build file that holds many divisions in its time", () => {
    // Reading a build file stays linear in its length: the divisions are
    // the text the reader must look at, and nothing else may grow with
    // them.
    const divisions = "a / ".repeat(4000);
    const result = parseManifest(
      "build.gradle",
      [`def ratio = ${divisions}1`, 'dependencies { implementation "g:a:1" }'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("reads a build file that holds a long statement in its time", () => {
    // A statement that continues over many lines is one statement, and
    // the reader must not look at its text again for every line.
    const continuation = "1 +\n".repeat(4000);
    const result = parseManifest(
      "build.gradle",
      [`def x = ${continuation}1`, 'dependencies { implementation "g:a:1" }'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("reads a build file that holds a long header in its time", () => {
    // The reader must not look at a header it does not understand more
    // than once.
    const header = "a".repeat(40000);
    const result = parseManifest(
      "build.gradle",
      [`def x = ${header} + { 1 }`, 'dependencies { implementation "g:a:1.0" }'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("reads a build file that holds a long qualified header in its time", () => {
    // A header of many segments is read once, not once per segment.
    const header = "a.".repeat(20000);
    const result = parseManifest(
      "build.gradle",
      [`${header}dependencies { implementation "g:a:1.0" }`].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("does not read a gem out of a source a symbol key names", () => {
    for (const options of [
      '{:git => "https://example.com/a"}',
      '{:source => "https://private.example.com"}',
    ]) {
      const result = parseManifest("Gemfile", `gem "a", "1.0", ${options}`);
      expect(result.records, options).toHaveLength(0);
    }
  });

  it("does not read a gem out of a regular expression", () => {
    const result = parseManifest(
      "Gemfile",
      ['x = /hello; gem "phantom", "9.0"; goodbye/'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a gem out of a regular expression an operator opens", () => {
    for (const operator of ["&&", "||", "!"]) {
      const result = parseManifest(
        "Gemfile",
        [`enabled = true ${operator} /text; gem "phantom", "1.0"; text/`, "gem 'rack', '3'"].join(
          "\n",
        ),
      );
      expect(
        result.records.map((record) => record.name),
        operator,
      ).toEqual(["rack"]);
    }
  });

  it("does not read a gem out of a regular expression a command opens", () => {
    // The slash may divide or it may open a regular expression, and the
    // reader cannot say which: its text is masked either way.
    const result = parseManifest(
      "Gemfile",
      ['puts /text; gem "phantom", "1.0"; text/', "gem 'rack', '3'"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem out of a regular expression that runs on", () => {
    const result = parseManifest(
      "Gemfile",
      ["puts /text", 'gem "phantom", "1.0"', "text/", 'gem "rails", "7.0"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("does not read a gem out of a percent string with an unpaired delimiter", () => {
    const result = parseManifest(
      "Gemfile",
      ['value = %!text; gem "phantom", "1.0"; text!', "gem 'rack', '3'"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not read a gem out of a command string", () => {
    const result = parseManifest(
      "Gemfile",
      ['x = `echo hello; gem "phantom", "9.0"; echo goodbye`'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("reads a gem a regular expression with a bracket precedes", () => {
    const result = parseManifest("Gemfile", ["x = /[)]/", "gem 'rails', '7.0'"].join("\n"));
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("reads a gem a source that opens a block does not take", () => {
    const result = parseManifest(
      "Gemfile",
      [
        'source "https://rubygems.org"',
        'source("https://private.example.com") {',
        '  gem "internal", "1.0"',
        "}",
        "gem 'rails', '7.0'",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("reads a gem a public source hash names", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "rails", "7.0", {source: "https://rubygems.org"}'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("decodes the escapes a gem's name carries", () => {
    const result = parseManifest("Gemfile", ['gem "ra\\x69ls", "7.0"'].join("\n"));
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("keeps the escapes a raw string carries", () => {
    // A single-quoted string is a raw string: its backslashes are
    // characters of the text.
    const result = parseManifest("Gemfile", ["gem 'ra\\x69ls', '7.0'"].join("\n"));
    expect(result.records.map((record) => record.name)).toEqual(["ra\\x69ls"]);
  });

  it("does not read a gem an escaped quote declares", () => {
    const result = parseManifest(
      "Gemfile",
      ['gem "rails", "7", require: "foo\\"; gem \'phantom\', \'2\'; \\"bar"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["rails"]);
  });

  it("keeps the character an escape precedes", () => {
    const result = parseManifest("Gemfile", ['gem "rails", "\\n70"'].join("\n"));
    expect(result.records[0]?.constraint).toBe("\n70");
  });

  it("does not read a gem a masked requirement hides", () => {
    // The requirement the reader does not read is not an empty one, and
    // the declaration is reported rather than read.
    const result = parseManifest("Gemfile", ["gem 'rails', '>= 7', %q(>= 9)"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("version the reader does not read");
  });

  it("reads a gem a regular expression with a quote precedes", () => {
    const result = parseManifest("Gemfile", ["pattern = /[\"']/", "gem 'rack', '3'"].join("\n"));
    expect(result.records.map((record) => record.name)).toEqual(["rack"]);
  });

  it("does not run out of stack on a file that holds many command strings", () => {
    const result = parseManifest("Gemfile", `x = ${"`a`; ".repeat(12000)}`);
    expect(result.records).toHaveLength(0);
  });

  it("reads two gems one line holds", () => {
    const result = parseManifest("Gemfile", ["gem 'a', '1.0'; gem 'b', '2.0'"].join("\n"));
    expect(result.records.map((record) => record.name)).toEqual(["a", "b"]);
  });

  it("does not read a gem a source after a percent literal takes", () => {
    const result = parseManifest(
      "Gemfile",
      ["message = %q|", "hello", "|; source 'https://private.example'", "gem 'rails', '7.0'"].join(
        "\n",
      ),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a gem out of a comment an `=endless` line ends", () => {
    // The `=end` marker is a word of its own.
    const result = parseManifest(
      "Gemfile",
      ["=begin", "=endless", 'gem "fake", "9"', "=end", 'gem "real", "1"'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["real"]);
  });

  it("publishes nothing when a brace does not match", () => {
    const result = parseManifest("Gemfile", ['gem "rack", "1"', "foo({)}"].join("\n"));
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });
});

describe("parseManifest — composer.json", () => {
  it("reads the requirements of both sections", () => {
    const result = parseManifest(
      "composer.json",
      JSON.stringify({
        require: { "monolog/monolog": "^3.0" },
        "require-dev": { "phpunit/phpunit": "^10.0" },
      }),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "monolog/monolog",
      "phpunit/phpunit",
    ]);
    expect(result.records[0]).toMatchObject({
      registry: "packagist",
      dialect: "semver",
      category: "library",
      section: "require",
      constraint: "^3.0",
    });
    expect(result.records[1].section).toBe("require-dev");
  });

  it("does not read a requirement on the platform as a package", () => {
    const result = parseManifest(
      "composer.json",
      JSON.stringify({ require: { php: ">=8.1", "ext-json": "*", "monolog/monolog": "^3.0" } }),
    );
    expect(result.records.map((record) => record.name)).toEqual(["monolog/monolog"]);
    expect(result.warnings.join("\n")).toContain("php");
  });

  it("warns about a manifest that is not valid JSON", () => {
    const result = parseManifest("composer.json", "{not json");
    expect(result.records).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseManifest — build.gradle", () => {
  it("reads the Groovy map spelling", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation group: 'com.google.guava', name: 'guava', version: '33.0.0'",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      registry: "maven",
      dialect: "maven",
      category: "library",
      name: "com.google.guava:guava",
      constraint: "33.0.0",
    });
  });

  it("reads the Kotlin named arguments", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    implementation(group = "com.google.guava", name = "guava", version = "33.0.0")',
        "}",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "com.google.guava:guava",
      constraint: "33.0.0",
    });
  });

  it("reads a coordinate string", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", "    implementation 'com.google.guava:guava:33.0.0'", "}"].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "com.google.guava:guava",
      constraint: "33.0.0",
    });
  });

  it("keeps a version that is a variable as it was written", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", "    implementation 'com.google.guava:guava:${guavaVersion}'", "}"].join(
        "\n",
      ),
    );
    expect(result.records[0]).toMatchObject({
      name: "com.google.guava:guava",
      constraint: "${guavaVersion}",
    });
  });

  it("does not read a project or a file dependency", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation project(':core')",
        "    implementation files('libs/demo.jar')",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("is not read");
  });

  it("does not read the buildscript classpath", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "buildscript {",
        "    dependencies {",
        "        classpath 'com.android.tools.build:gradle:8.0.0'",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("buildscript");
  });

  it("reads a declaration that spans several lines", () => {
    // The Kotlin script and the Groovy script are the same format: the
    // path says which one it is, and the reader reads both.
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation(",
        '        group = "com.google.guava",',
        '        name = "guava",',
        '        version = "33.0.0"',
        "    )",
        "}",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "com.google.guava:guava",
      constraint: "33.0.0",
    });
  });

  it("reads two declarations one line holds", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", '    implementation "g:a:1.0"; implementation "g:b:2.0"', "}"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a", "g:b"]);
  });

  it("reads a declaration a trailing comment follows", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    implementation("g:a:1.0") // a comment',
        '    implementation("g:b:2.0")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a", "g:b"]);
  });

  it("reads a declaration a configuration closure follows", () => {
    // The closure configures the declaration; it declares nothing.
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    implementation("g:a:1.0") {',
        '        exclude(group = "x", module = "y")',
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("keeps a computed version as it was written", () => {
    // A computed version is not a version the project pins, and the
    // comparison cannot read it.
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    implementation(group = "g", name = "a", version = "1.0" + patch)',
        "}",
      ].join("\n"),
    );
    expect(result.records[0]).toMatchObject({
      name: "g:a",
      constraint: '"1.0" + patch',
    });
  });

  it("publishes nothing when the build file cannot be read", () => {
    // A block the file never closes means the reader no longer knows
    // where the declarations are.
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", '    implementation("g:a:1.0")'].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("publishes nothing when a bracket is never closed", () => {
    const result = parseManifest(
      "build.gradle",
      ['dependencies { implementation "g:real:1" }', "def list = ["].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("does not read a declaration out of a slashy string", () => {
    // A slashy string holds text, and the text is not code.
    const result = parseManifest(
      "build.gradle",
      [
        "def description = /",
        "dependencies {",
        '    implementation "g:fake:9"',
        "}",
        "/",
        'dependencies { implementation "g:real:1" }',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
  });

  it("does not read a coordinate that interpolates", () => {
    // The build decides which artifact the coordinate names, and the
    // manifest does not say.
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", '    implementation("g:${artifact}:1")', "}"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("is not read");
  });

  it("does not read a declaration out of a dollar-slashy string", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "def s = $/",
        'dependencies { implementation "fake:a:9" }',
        "/$",
        'dependencies { implementation "g:a:1" }',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("reads a declaration a regular expression precedes", () => {
    const result = parseManifest(
      "build.gradle",
      ["def pattern = ~/foo/", 'dependencies { implementation "g:a:1" }'].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("publishes nothing when a brace is never closed", () => {
    const result = parseManifest(
      "build.gradle",
      ['dependencies { implementation "g:real:1" }', "foo({)"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("does not read a call that names no configuration", () => {
    // Printing a coordinate declares nothing.
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", '    println("g:fake:9")', '    implementation("g:real:1")', "}"].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
    expect(result.warnings.join("\n")).toContain("configuration the reader does not know");
  });

  it("reads a dependency a control-flow block declares", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    if (JavaVersion.current().isJava9Compatible()) {",
        "        implementation 'javax.xml.bind:jaxb-api:2.3.1'",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["javax.xml.bind:jaxb-api"]);
  });

  it("does not read a declaration out of a nested block comment", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "/* outer /* inner */",
        'dependencies { implementation("g:fake:9") }',
        "*/",
        'dependencies { implementation("g:real:1") }',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
  });

  it("publishes nothing when a delimiter does not match", () => {
    const result = parseManifest(
      "build.gradle",
      ['dependencies { implementation "g:a:1" }', "x = ([)]"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("could not be read");
  });

  it("does not read a call the configurations block does not declare", () => {
    // A call in a `configurations` block that creates no configuration
    // creates none, and a configuration that does not exist holds no
    // dependency.
    const result = parseManifest(
      "build.gradle",
      [
        "configurations {",
        '    println("hello")',
        "}",
        "dependencies {",
        '    println("g:fake:9")',
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("reads a dependency a plugin's configuration holds", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    androidTestImplementation("androidx.test:runner:1.6.2")',
        '    debugImplementation("com.squareup.leakcanary:leakcanary-android:2.14")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "androidx.test:runner",
      "com.squareup.leakcanary:leakcanary-android",
    ]);
  });

  it("reads a dependency a delegated configuration holds", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "val smokeTest by configurations.creating",
        "dependencies {",
        '    smokeTest("org.junit.jupiter:junit-jupiter:5.11.0")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "org.junit.jupiter:junit-jupiter",
    ]);
  });

  it("reads a dependency the handler adds to a named configuration", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "configurations { smokeTest }",
        "dependencies {",
        '    add("smokeTest", "org.junit.jupiter:junit-jupiter:5.11.0")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "org.junit.jupiter:junit-jupiter",
    ]);
  });

  it("does not report a control-flow header as an unknown configuration", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", "    if (true) {", '        implementation "g:real:1"', "    }", "}"].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
    expect(result.warnings).toEqual([]);
  });

  it("does not read a declaration out of a dollar-slashy string", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "def message = $/",
        "$/$$",
        'dependencies { implementation "g:fake:9" }',
        "$/",
        "/$",
        'dependencies { implementation "g:real:1" }',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
  });

  it("does not read a declaration out of an escaped dollar-slashy string", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "def message = $/",
        "$/$",
        'dependencies { implementation "g:fake:9" }',
        "$/",
        "/$",
        'dependencies { implementation "g:real:1" }',
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
  });

  it("reads a dependency an Android configuration holds", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")',
        '    ksp("com.google.dagger:dagger-compiler:2.56.2")',
        '    lintChecks("com.example:checks:1.0")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "com.android.tools:desugar_jdk_libs",
      "com.google.dagger:dagger-compiler",
      "com.example:checks",
    ]);
  });

  it("reads a dependency a configuration created outside the block holds", () => {
    const result = parseManifest(
      "build.gradle",
      ['configurations.create("smokeTest")', "dependencies {", '    smokeTest("g:a:1")', "}"].join(
        "\n",
      ),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("reads a dependency a literal configuration name holds", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "val smokeTest by configurations.creating",
        "dependencies {",
        '    "smokeTest"("g:a:1")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("does not read a call that registers a task as a configuration", () => {
    const result = parseManifest(
      "build.gradle",
      [
        'tasks.register("println")',
        "dependencies {",
        '    println("g:fake:9")',
        '    implementation("g:real:1")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:real"]);
  });

  it("does not read a declaration whose closure sets the version", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation('org.slf4j:slf4j-api:1.7.36') {",
        "        version { strictly '2.0.16' }",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("sets its version in a closure");
  });

  it("does not read a declaration whose closure assigns the version", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", '    implementation("g:a:1.0") { version = "2.0" }', "}"].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("sets its version in a closure");
  });

  it("does not read a call that registers a task inside the configurations block", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "configurations {",
        '    tasks.register("println")',
        "}",
        "dependencies {",
        '    println("fake:fake:9.0")',
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
  });

  it("does not read a declaration whose closure sets the version behind a comment", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    implementation("g:a:1.0") {',
        "        // }",
        '        version = "2.0"',
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("sets its version in a closure");
  });

  it("reads a declaration whose closure only mentions a version in a comment", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    implementation("g:a:1.0") {',
        "        // retain version",
        '        exclude(group = "x")',
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("decodes the escapes a coordinate carries", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", '    implementation("org.example:lib\\u0031:1.0")', "}"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["org.example:lib1"]);
  });

  it("reads a declaration whose closure only names a version in a string", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation('g:a:1') { exclude group: 'version', module: 'y' }",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["g:a"]);
  });

  it("does not read a declaration whose nested closure sets the version", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation('g:a:1') {",
        "        if (true) {",
        "            version { strictly('2') }",
        "        }",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("sets its version in a closure");
  });

  it("reads a dependency a qualified source set holds", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "kotlin {",
        "    sourceSets {",
        "        commonMain.dependencies {",
        '            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")',
        "        }",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "org.jetbrains.kotlinx:kotlinx-coroutines-core",
    ]);
  });

  it("reads a dependency an Android configuration holds", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", "    androidTestUtil 'androidx.test:orchestrator:1.5.1'", "}"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["androidx.test:orchestrator"]);
  });

  it("reads a dependency a plugin's configuration family holds", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        '    kspCommonMainMetadata("com.google.devtools.ksp:symbol-processing-api:2.0.0")',
        '    kspJvm("com.google.dagger:dagger-compiler:2.56.2")',
        '    kaptAndroidTest("com.google.dagger:dagger-compiler:2.56.2")',
        "}",
      ].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual([
      "com.google.devtools.ksp:symbol-processing-api",
      "com.google.dagger:dagger-compiler",
      "com.google.dagger:dagger-compiler",
    ]);
  });

  it("does not read a declaration whose closure sets the version through a receiver", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", "    implementation('g:a:1') { dep -> dep.version = '3' }", "}"].join(
        "\n",
      ),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("sets its version in a closure");
  });

  it("does not read a declaration whose closure constrains the version", () => {
    const result = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation('g:a:1.0') {",
        "        versionConstraint.require('2.0')",
        "    }",
        "}",
      ].join("\n"),
    );
    expect(result.records).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("sets its version in a closure");
  });

  it("decodes the escapes a Groovy string carries", () => {
    const result = parseManifest(
      "build.gradle",
      ["dependencies {", "    implementation('org.example:lib\\u0031:1.0')", "}"].join("\n"),
    );
    expect(result.records.map((record) => record.name)).toEqual(["org.example:lib1"]);
  });
});

describe("the comparison — the library ecosystems", () => {
  it("reports a major bump of a NuGet package", () => {
    const before = parseManifest(
      "csproj",
      [
        '<Project><ItemGroup><PackageReference Include="Serilog" Version="3.0.0" /></ItemGroup></Project>',
      ].join("\n"),
    ).records;
    const after = parseManifest(
      "csproj",
      [
        '<Project><ItemGroup><PackageReference Include="Serilog" Version="4.0.0" /></ItemGroup></Project>',
      ].join("\n"),
    ).records;
    const changes = compareManifests(before, after, "App.csproj");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      registry: "nuget",
      name: "Serilog",
      kind: "major",
      from: "3.0.0",
      to: "4.0.0",
      manifest: "App.csproj",
    });
    expect(isBreakingRelevant(changes[0]!)).toBe(true);
  });

  it("does not analyze a minor bump of a library", () => {
    const before = parseManifest("Gemfile", ['gem "rails", "7.0.4"'].join("\n")).records;
    const after = parseManifest("Gemfile", ['gem "rails", "7.1.0"'].join("\n")).records;
    const changes = compareManifests(before, after, "Gemfile");
    expect(changes[0]!.kind).toBe("minor");
    expect(isBreakingRelevant(changes[0]!)).toBe(false);
  });

  it("reports one transition for a package two configurations declare", () => {
    const before = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation 'com.google.guava:guava:33.0.0'",
        "    testImplementation 'com.google.guava:guava:33.0.0'",
        "}",
      ].join("\n"),
    ).records;
    const after = parseManifest(
      "build.gradle",
      [
        "dependencies {",
        "    implementation 'com.google.guava:guava:34.0.0'",
        "    testImplementation 'com.google.guava:guava:34.0.0'",
        "}",
      ].join("\n"),
    ).records;
    const changes = compareManifests(before, after, "build.gradle");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ name: "com.google.guava:guava", kind: "major" });
  });

  it("reports a version the comparison cannot read as unresolved", () => {
    const before = parseManifest(
      "build.gradle",
      ["dependencies {", "    implementation 'com.google.guava:guava:33.0.0'", "}"].join("\n"),
    ).records;
    const after = parseManifest(
      "build.gradle",
      ["dependencies {", "    implementation 'com.google.guava:guava:${guavaVersion}'", "}"].join(
        "\n",
      ),
    ).records;
    const changes = compareManifests(before, after, "build.gradle");
    expect(changes[0]!.kind).toBe("unresolved");
    expect(isBreakingRelevant(changes[0]!)).toBe(false);
  });
});
