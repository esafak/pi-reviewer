import { describe, expect, it } from "vite-plus/test";

import { compareManifests, recordIdentity } from "../../../src/core/dependency/compare.js";
import type { DependencyRecord } from "../../../src/core/dependency/types.js";

function record(overrides: Partial<DependencyRecord> = {}): DependencyRecord {
  return {
    registry: "npm",
    dialect: "semver",
    category: "library",
    name: "react",
    section: "dependencies",
    constraint: "^1.0.0",
    ...overrides,
  };
}

describe("compareManifests", () => {
  it("reports a major change", () => {
    const changes = compareManifests(
      [record()],
      [record({ constraint: "^2.0.0" })],
      "package.json",
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "major",
      name: "react",
      from: "^1.0.0",
      to: "^2.0.0",
      manifest: "package.json",
    });
  });

  it("reports nothing for an unchanged dependency", () => {
    expect(compareManifests([record()], [record()], "package.json")).toHaveLength(0);
  });

  it("pairs a reordered entry by name", () => {
    const before = [record({ name: "a" }), record({ name: "b" })];
    const after = [record({ name: "b" }), record({ name: "a" })];
    expect(compareManifests(before, after, "package.json")).toHaveLength(0);
  });

  it("pairs a reordered entry by name even when the constraints differ", () => {
    // A positional pairing would report two changes here, and the one it
    // would report for `b` would start at the wrong constraint, so the
    // fixture distinguishes the pairing from the order.
    const before = [
      record({ name: "a", constraint: "^1.0.0" }),
      record({ name: "b", constraint: "^2.0.0" }),
    ];
    const after = [
      record({ name: "b", constraint: "^3.0.0" }),
      record({ name: "a", constraint: "^1.0.0" }),
    ];
    const changes = compareManifests(before, after, "package.json");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "major", name: "b", from: "^2.0.0", to: "^3.0.0" });
  });

  it("reports one change when two sections hold the same package", () => {
    const before = [
      record({ section: "dependencies", constraint: "^1.0.0" }),
      record({ section: "peerDependencies", constraint: "^1.0.0" }),
    ];
    const after = [
      record({ section: "dependencies", constraint: "^2.0.0" }),
      record({ section: "peerDependencies", constraint: "^1.0.0" }),
    ];
    const changes = compareManifests(before, after, "package.json");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: "major", section: "dependencies" });
  });

  it("pairs a moved entry by name", () => {
    const changes = compareManifests(
      [record()],
      [record({ section: "devDependencies" })],
      "package.json",
    );
    // A section change is an identity change, so it is a removal and an
    // addition rather than a version change.
    expect(changes.map((change) => change.kind).sort()).toEqual(["added", "removed"]);
  });

  it("reports the same package in two sections as two records", () => {
    const before = [record({ section: "dependencies", constraint: "^1.0.0" })];
    const after = [
      record({ section: "dependencies", constraint: "^2.0.0" }),
      record({ section: "peerDependencies", constraint: "^1.0.0" }),
    ];
    const changes = compareManifests(before, after, "package.json");
    expect(changes).toHaveLength(2);
    expect(changes.filter((change) => change.kind === "added")).toHaveLength(1);
    expect(changes.filter((change) => change.kind === "major")).toHaveLength(1);
  });

  it("reports an added dependency", () => {
    const changes = compareManifests([], [record({ name: "new" })], "package.json");
    expect(changes[0]).toMatchObject({ kind: "added", name: "new" });
  });

  it("reports a removed dependency", () => {
    const changes = compareManifests([record()], [], "package.json");
    expect(changes[0]).toMatchObject({ kind: "removed", name: "react" });
  });

  it("treats a Go major path transition as one module", () => {
    const before = [
      record({ registry: "go", dialect: "go", name: "example.com/m", constraint: "v1.2.3" }),
    ];
    const after = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v2.0.0" }),
    ];
    const changes = compareManifests(before, after, "go.mod");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "major",
      name: "example.com/m/v2",
      previousName: "example.com/m",
    });
  });

  it("reports nothing for an unchanged constraint it cannot compare", () => {
    // A wildcard names no version, so the constraint cannot be compared —
    // and an unchanged constraint is not a change either way.
    for (const constraint of ["*", "1.x", "${lib.version}"]) {
      const before = [record({ name: "foo", constraint })];
      const after = [record({ name: "foo", constraint })];
      expect(compareManifests(before, after, "package.json"), constraint).toHaveLength(0);
    }
  });

  it("reports a Go path transition even when the constraint did not change", () => {
    // The path carries the major, so the version changed even though the
    // constraint the manifest wrote did not.
    const before = [
      record({ registry: "go", dialect: "go", name: "example.com/m", constraint: "v1.0.0" }),
    ];
    const after = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v1.0.0" }),
    ];
    const changes = compareManifests(before, after, "go.mod");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "major",
      name: "example.com/m/v2",
      previousName: "example.com/m",
    });
  });

  it("treats a Go major path transition in the other direction as one module", () => {
    const before = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v2.0.0" }),
    ];
    const after = [
      record({ registry: "go", dialect: "go", name: "example.com/m", constraint: "v1.2.3" }),
    ];
    const changes = compareManifests(before, after, "go.mod");
    expect(changes).toHaveLength(1);
    // Moving back to the first major is a descending change.
    expect(changes[0]).toMatchObject({
      kind: "downgrade",
      name: "example.com/m",
      previousName: "example.com/m/v2",
    });
  });

  it("pairs an exact Go major first and then the remaining transition", () => {
    const before = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v2.0.0" }),
      record({ registry: "go", dialect: "go", name: "example.com/m/v3", constraint: "v3.0.0" }),
    ];
    const after = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v2.1.0" }),
      record({ registry: "go", dialect: "go", name: "example.com/m/v4", constraint: "v4.0.0" }),
    ];
    const changes = compareManifests(before, after, "go.mod");
    expect(changes).toHaveLength(2);
    const exact = changes.find((change) => change.name === "example.com/m/v2");
    const crossMajor = changes.find((change) => change.name === "example.com/m/v4");
    expect(exact).toMatchObject({ kind: "minor", from: "v2.0.0", to: "v2.1.0" });
    expect(crossMajor).toMatchObject({
      kind: "major",
      previousName: "example.com/m/v3",
      from: "v3.0.0",
      to: "v4.0.0",
    });
  });

  it("reports an ambiguous Go pairing as an addition and a removal", () => {
    const before = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v2.0.0" }),
      record({ registry: "go", dialect: "go", name: "example.com/m/v3", constraint: "v3.0.0" }),
    ];
    const after = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v4", constraint: "v4.0.0" }),
    ];
    const changes = compareManifests(before, after, "go.mod");
    expect(changes.map((change) => change.kind).sort()).toEqual(["added", "removed", "removed"]);
  });

  it("keeps an unrelated Go module an addition and a removal", () => {
    const before = [
      record({ registry: "go", dialect: "go", name: "example.com/other", constraint: "v1.0.0" }),
    ];
    const after = [
      record({ registry: "go", dialect: "go", name: "example.com/m/v2", constraint: "v2.0.0" }),
    ];
    const changes = compareManifests(before, after, "go.mod");
    expect(changes.map((change) => change.kind).sort()).toEqual(["added", "removed"]);
  });
});

describe("recordIdentity", () => {
  it("strips a Go major path suffix", () => {
    expect(recordIdentity(record({ registry: "go", name: "example.com/m/v2" }))).toBe(
      "example.com/m",
    );
  });

  it("leaves other registries alone", () => {
    expect(recordIdentity(record({ name: "@scope/pkg" }))).toBe("@scope/pkg");
  });
});
