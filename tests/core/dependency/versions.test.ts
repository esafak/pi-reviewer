import { describe, expect, it } from "vite-plus/test";

import {
  classifyVersionChange,
  compareVersions,
  parseVersion,
} from "../../../src/core/dependency/versions.js";

describe("parseVersion", () => {
  it("parses a bare version in each dialect", () => {
    expect(parseVersion("semver", "1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("maven", "1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("tool", "22.1.0")).toMatchObject({ major: 22, minor: 1, patch: 0 });
  });

  it("parses a two-component version and records that it is short", () => {
    const version = parseVersion("tool", "3.11");
    expect(version).toMatchObject({ major: 3, minor: 11, patch: 0, components: 2 });
  });

  it("parses a v-prefixed tag", () => {
    expect(parseVersion("go", "v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("semver", "v2.0.0")).toMatchObject({ major: 2 });
  });

  it("accepts an inclusive lower bound", () => {
    expect(parseVersion("semver", ">=1.2.3")).toMatchObject({ major: 1, exclusive: false });
    expect(parseVersion("semver", "=1.2.3")).toMatchObject({ major: 1 });
    expect(parseVersion("pep440", "==1.2.3")).toMatchObject({ major: 1 });
    expect(parseVersion("pep440", "~=1.4.2")).toMatchObject({ major: 1, minor: 4 });
    expect(parseVersion("semver", "^1.2.3")).toMatchObject({ major: 1 });
    expect(parseVersion("semver", "~1.2.3")).toMatchObject({ major: 1 });
    expect(parseVersion("semver", "~> 2.3")).toMatchObject({ major: 2, minor: 3 });
  });

  it("accepts an exclusive lower bound and records the exclusivity", () => {
    expect(parseVersion("semver", ">1.2.3")).toMatchObject({ major: 1, exclusive: true });
  });

  it("rejects an upper-bound-only constraint", () => {
    expect(parseVersion("semver", "<=1.2.3")).toBeUndefined();
    expect(parseVersion("semver", "<1.2.3")).toBeUndefined();
  });

  it("rejects what the Go dialect does not read", () => {
    // The Go dialect reads a version, with or without the tag's `v`.
    expect(parseVersion("go", "1.2.3")).toMatchObject({ major: 1 });
    expect(parseVersion("go", "v1.2")).toMatchObject({ major: 1, minor: 2 });
    expect(parseVersion("go", "1.2.x")).toBeUndefined();
    expect(parseVersion("go", "v1.2.3.4")).toBeUndefined();
    expect(parseVersion("go", "latest")).toBeUndefined();
  });

  it("rejects a wildcard", () => {
    expect(parseVersion("semver", "1.x")).toBeUndefined();
    expect(parseVersion("semver", "1.*")).toBeUndefined();
    expect(parseVersion("semver", "*")).toBeUndefined();
  });

  it("rejects a compound range", () => {
    expect(parseVersion("semver", ">=1.0.0 <2.0.0")).toBeUndefined();
    expect(parseVersion("semver", "1.0 || 2.0")).toBeUndefined();
  });

  it("rejects a native bracket range", () => {
    expect(parseVersion("maven", "[1.0,2.0)")).toBeUndefined();
  });

  it("rejects a dynamic value", () => {
    expect(parseVersion("semver", "latest")).toBeUndefined();
    expect(parseVersion("semver", "workspace:*")).toBeUndefined();
    expect(parseVersion("semver", "file:../local")).toBeUndefined();
    expect(parseVersion("semver", "https://example.com/pkg.tgz")).toBeUndefined();
  });

  it("rejects a stacked comparator", () => {
    expect(parseVersion("semver", ">=^2.0.0")).toBeUndefined();
  });

  it("rejects a URL", () => {
    expect(parseVersion("semver", "https://example.com/pkg@2.0.0")).toBeUndefined();
  });

  it("rejects an arbitrary name and version", () => {
    expect(parseVersion("tool", "junk@2.0")).toBeUndefined();
  });

  it("rejects a protocol prefix, which a manifest parser strips", () => {
    expect(parseVersion("semver", "workspace:^2.0.0")).toBeUndefined();
    expect(parseVersion("semver", "npm:real-package@^2.0.0")).toBeUndefined();
  });

  it("rejects a value that is not a version", () => {
    expect(parseVersion("maven", "${foo.version}")).toBeUndefined();
    expect(parseVersion("semver", "not-a-version")).toBeUndefined();
  });

  it("parses a PEP 440 pre-release and a post-release", () => {
    expect(parseVersion("pep440", "2.0b1")).toMatchObject({
      major: 2,
      pre: { label: "b", number: 1, text: "b1" },
    });
    expect(parseVersion("pep440", "2.0.post1")).toMatchObject({
      major: 2,
      post: { label: "post", number: 1, text: "post1" },
    });
    expect(parseVersion("pep440", "2.0.dev1")).toMatchObject({
      major: 2,
      dev: { label: "dev", number: 1, text: "dev1" },
    });
  });

  it("parses a PEP 440 epoch", () => {
    expect(parseVersion("pep440", "1!2.0")).toMatchObject({ epoch: 1, major: 2 });
  });
});

describe("PEP 440 ordering", () => {
  // The chain PEP 440 gives as its example of the relative ordering of
  // every permitted suffix.
  const chain = [
    "1.dev0",
    "1.0.dev456",
    "1.0a1",
    "1.0a2.dev456",
    "1.0a12.dev456",
    "1.0a12",
    "1.0b1.dev456",
    "1.0b2",
    "1.0b2.post345.dev456",
    "1.0b2.post345",
    "1.0rc1.dev456",
    "1.0rc1",
    "1.0",
    "1.0+abc.5",
    "1.0+abc.7",
    "1.0+5",
    "1.0.post456.dev34",
    "1.0.post456",
    "1.0.15",
    "1.1.dev1",
  ];

  it("orders every permitted suffix as the specification does", () => {
    for (let index = 1; index < chain.length; index += 1) {
      const before = chain[index - 1];
      const after = chain[index];
      const change = classifyVersionChange("pep440", before, after);
      // Every step in the chain is an upgrade; the kind varies with how far
      // the step moves.
      expect(`${before} -> ${after}: ${change?.kind}`).not.toContain("downgrade");
      expect(`${before} -> ${after}: ${change?.kind}`).not.toContain("unresolved");
    }
  });

  it("reads a pre-release before the final release", () => {
    expect(classifyVersionChange("pep440", "1.0a1", "1.0")?.kind).toBe("patch");
  });

  it("reads a post-release after the final release", () => {
    expect(classifyVersionChange("pep440", "1.0", "1.0.post1")?.kind).toBe("patch");
  });
});

describe("semver validation", () => {
  it("rejects a leading zero in a release component", () => {
    expect(parseVersion("semver", "01.0.0")).toBeUndefined();
  });

  it("rejects a leading zero in a numeric identifier", () => {
    expect(parseVersion("semver", "1.0.0-01")).toBeUndefined();
  });

  it("rejects an empty identifier", () => {
    expect(parseVersion("semver", "1.0.0-a..b")).toBeUndefined();
  });

  it("compares a numeric identifier beyond a safe integer", () => {
    expect(
      classifyVersionChange("semver", "1.0.0-9007199254740992", "1.0.0-9007199254740993")?.kind,
    ).toBe("patch");
    expect(
      classifyVersionChange("semver", "1.0.0-9007199254740993", "1.0.0-9007199254740992")?.kind,
    ).toBe("downgrade");
  });

  it("orders a Go pre-release with the semver rules", () => {
    expect(classifyVersionChange("go", "v1.0.0-rc.2", "v1.0.0-rc.1")?.kind).toBe("downgrade");
    expect(classifyVersionChange("go", "v1.0.0-rc.1", "v1.0.0-rc.2")?.kind).toBe("patch");
  });

  it("keeps the pre-release separator in a Go representative", () => {
    const change = classifyVersionChange("go", "v1.0.0-rc.1", "v1.0.0-rc.2");
    expect(change?.fromVersion).toBe("1.0.0-rc.1");
    expect(change?.toVersion).toBe("1.0.0-rc.2");
  });
});

describe("compareVersions", () => {
  it("orders a pre-release below the final release", () => {
    const pre = parseVersion("pep440", "2.0b1");
    const final = parseVersion("pep440", "2.0");
    expect(pre && final && compareVersions(pre, final)).toBeLessThan(0);
  });

  it("orders a post-release above the final release", () => {
    const final = parseVersion("pep440", "2.0");
    const post = parseVersion("pep440", "2.0.post1");
    expect(final && post && compareVersions(final, post)).toBeLessThan(0);
  });

  it("orders by the epoch first", () => {
    const one = parseVersion("pep440", "1!2.0");
    const two = parseVersion("pep440", "2!2.0");
    expect(one && two && compareVersions(one, two)).toBeLessThan(0);
  });
});

describe("classifyVersionChange", () => {
  it("classifies a major change", () => {
    expect(classifyVersionChange("semver", "1.2.3", "2.0.0")?.kind).toBe("major");
  });

  it("classifies a pre-1.0 minor change", () => {
    expect(classifyVersionChange("semver", "0.1.0", "0.2.0")?.kind).toBe("pre-1.0-minor");
  });

  it("classifies a minor change", () => {
    expect(classifyVersionChange("semver", "1.2.3", "1.3.0")?.kind).toBe("minor");
  });

  it("classifies a patch change", () => {
    expect(classifyVersionChange("semver", "1.2.3", "1.2.4")?.kind).toBe("patch");
  });

  it("classifies a downgrade as a downgrade", () => {
    expect(classifyVersionChange("semver", "2.0.0", "1.0.0")?.kind).toBe("downgrade");
  });

  it("classifies a pre-release promotion as a patch", () => {
    expect(classifyVersionChange("pep440", "2.0b1", "2.0")?.kind).toBe("patch");
  });

  it("classifies an epoch change as a major change", () => {
    expect(classifyVersionChange("pep440", "1!2.0", "2!2.0")?.kind).toBe("major");
  });

  it("is unresolved when either side cannot be compared", () => {
    expect(classifyVersionChange("semver", "1.x", "2.0.0")?.kind).toBe("unresolved");
    expect(classifyVersionChange("semver", undefined, "2.0.0")?.kind).toBe("unresolved");
    expect(classifyVersionChange("maven", "1.0.0", "${foo.version}")?.kind).toBe("unresolved");
  });

  it("keeps the release component count in the representative", () => {
    const change = classifyVersionChange("semver", "1.0", "2.0");
    expect(change?.fromVersion).toBe("1.0");
    expect(change?.toVersion).toBe("2.0");
  });

  it("keeps the epoch in the representative", () => {
    const change = classifyVersionChange("pep440", "1!2.0", "2!2.0");
    expect(change?.fromVersion).toBe("1!2.0");
    expect(change?.toVersion).toBe("2!2.0");
  });

  it("keeps the qualifier in the representative", () => {
    const change = classifyVersionChange("pep440", "2.0rc1", "2.0rc2");
    expect(change?.fromVersion).toBe("2.0rc1");
    expect(change?.toVersion).toBe("2.0rc2");
  });

  it("tells a PEP 440 pre-release label apart", () => {
    const change = classifyVersionChange("pep440", "2.0b1", "2.0a1");
    expect(change?.kind).toBe("downgrade");
    expect(change?.fromVersion).toBe("2.0b1");
    expect(change?.toVersion).toBe("2.0a1");
  });

  it("keeps a combined pre-release and dev-release in the representative", () => {
    const change = classifyVersionChange("pep440", "2.0rc1.dev2", "2.0rc1");
    expect(change?.fromVersion).toBe("2.0rc1.dev2");
  });

  it("orders semver pre-releases by their identifiers", () => {
    expect(classifyVersionChange("semver", "1.0.0-alpha.9", "1.0.0-beta.1")?.kind).toBe("patch");
    expect(classifyVersionChange("semver", "1.0.0-alpha.1", "1.0.0-alpha.0.2")?.kind).toBe(
      "downgrade",
    );
  });

  it("treats a semver post identifier as an ordinary pre-release", () => {
    expect(classifyVersionChange("semver", "1.0.0-post.1", "1.0.0")?.kind).toBe("patch");
  });

  it("classifies a descending pre-release as a downgrade", () => {
    expect(classifyVersionChange("pep440", "2.0rc2", "2.0rc1")?.kind).toBe("downgrade");
  });

  it("classifies a descending post-release as a downgrade", () => {
    expect(classifyVersionChange("pep440", "2.0.post2", "2.0.post1")?.kind).toBe("downgrade");
  });

  it("classifies a descending semver pre-release as a downgrade", () => {
    expect(classifyVersionChange("semver", "2.0.0-beta.2", "2.0.0-alpha.1")?.kind).toBe(
      "downgrade",
    );
  });

  it("reports the normalized versions it compared", () => {
    const change = classifyVersionChange("semver", "1.2.3", "2.0.0");
    expect(change?.fromVersion).toBe("1.2.3");
    expect(change?.toVersion).toBe("2.0.0");
  });

  it("does not treat an exclusivity change as a version change", () => {
    // The bound changed, not the version, so there is no version change.
    expect(classifyVersionChange("semver", ">1.2.3", ">=1.2.3")).toBeUndefined();
  });

  it("classifies a two-component change as a minor change", () => {
    expect(classifyVersionChange("tool", "3.11", "3.12")).toMatchObject({
      kind: "minor",
      fromVersion: "3.11",
      toVersion: "3.12",
    });
  });

  it("classifies a permissive range that crosses a major as a major change", () => {
    expect(classifyVersionChange("semver", "~> 2.3", "~> 3.0")).toMatchObject({
      kind: "major",
      fromVersion: "2.3",
      toVersion: "3.0",
    });
  });

  it("lets a Go module path set the major of the comparison representative", () => {
    const change = classifyVersionChange("go", "v1.9.0", "v2.0.0", {
      from: "example.com/m",
      to: "example.com/m/v2",
    });
    expect(change).toMatchObject({ kind: "major", fromVersion: "1.9.0", toVersion: "2.0.0" });
  });

  it("refuses a Go path whose major is not an exact integer", () => {
    // A major beyond the exact range would be rounded, and a rounded major
    // compares as equal to a different one.
    expect(parseVersion("go", "v1.0.0", "example.com/m/v9007199254740992")).toBeUndefined();
  });

  it("keeps the raw constraint when the path sets the major", () => {
    // The representative is a comparison artifact; the constraint is what
    // the manifest wrote.
    expect(parseVersion("go", "v1.0.0", "example.com/m/v2")).toMatchObject({ major: 2 });
  });
});
