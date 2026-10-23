import { describe, expect, it } from "vite-plus/test";

import type { DependencyChange } from "../../../src/core/dependency/types.js";
import { upgradeId } from "../../../src/core/dependency/upgrade-id.js";

/**
 * One detected upgrade, as the detector reports it.
 *
 * The fixture carries the fields the prompt reads, so a test can change one
 * of them without restating the rest.
 */
function change(overrides: Partial<DependencyChange> = {}): DependencyChange {
  return {
    registry: "npm",
    dialect: "semver",
    category: "library",
    name: "react",
    section: "dependencies",
    from: "^18.2.0",
    to: "^19.0.0",
    kind: "major",
    manifest: "package.json",
    ...overrides,
  };
}

describe("upgradeId", () => {
  it("gives two sections of one manifest two different ids", () => {
    const dependencies = change({ section: "dependencies" });
    const devDependencies = change({ section: "devDependencies" });

    expect(upgradeId(dependencies)).not.toBe(upgradeId(devDependencies));
  });

  it("gives the same upgrade the same id on two runs", () => {
    const target = change();

    expect(upgradeId(target)).toBe(upgradeId(change()));
  });

  it("gives two manifests that pin the same package two different ids", () => {
    const root = change({ manifest: "package.json" });
    const workspace = change({ manifest: "apps/web/package.json" });

    expect(upgradeId(root)).not.toBe(upgradeId(workspace));
  });

  it("names the id so it can be cited", () => {
    expect(upgradeId(change())).toMatch(/^u-[0-9a-f]{12}$/);
  });
});
