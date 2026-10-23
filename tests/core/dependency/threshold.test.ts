import { describe, expect, it } from "vite-plus/test";

import { isBreakingRelevant } from "../../../src/core/dependency/threshold.js";
import type { DependencyChange } from "../../../src/core/dependency/types.js";

describe("isBreakingRelevant", () => {
  const change = (overrides: Partial<DependencyChange>): DependencyChange => ({
    registry: "npm",
    dialect: "semver",
    category: "library",
    name: "react",
    section: "dependencies",
    kind: "minor",
    manifest: "package.json",
    ...overrides,
  });

  it("analyzes a library major change", () => {
    expect(isBreakingRelevant(change({ kind: "major" }))).toBe(true);
  });

  it("analyzes a library pre-1.0 minor change", () => {
    expect(isBreakingRelevant(change({ kind: "pre-1.0-minor" }))).toBe(true);
  });

  it("does not analyze a library minor change", () => {
    expect(isBreakingRelevant(change({ kind: "minor" }))).toBe(false);
  });

  it("analyzes a tool minor change", () => {
    expect(isBreakingRelevant(change({ kind: "minor", category: "tool" }))).toBe(true);
  });

  it("does not analyze a patch change", () => {
    expect(isBreakingRelevant(change({ kind: "patch" }))).toBe(false);
    expect(isBreakingRelevant(change({ kind: "patch", category: "tool" }))).toBe(false);
  });

  it("does not analyze an addition, a removal, a downgrade, or an unresolved change", () => {
    for (const kind of ["added", "removed", "downgrade", "unresolved"] as const) {
      expect(isBreakingRelevant(change({ kind }))).toBe(false);
    }
  });
});
