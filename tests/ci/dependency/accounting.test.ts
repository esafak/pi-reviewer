import { describe, expect, it } from "vite-plus/test";

import { accountForUpgrades } from "../../../src/ci/dependency/accounting.js";
import type { DependencyChange } from "../../../src/core/dependency/types.js";
import { upgradeId } from "../../../src/core/dependency/upgrade-id.js";

function change(name: string): DependencyChange {
  return {
    registry: "npm",
    dialect: "semver",
    category: "library",
    name,
    section: "dependencies",
    from: "^18.0.0",
    to: "^19.0.0",
    fromVersion: "18.0.0",
    toVersion: "19.0.0",
    kind: "major",
    manifest: "package.json",
  };
}

describe("accountForUpgrades", () => {
  it("names the model's silence when the upgrade was in the section", () => {
    const react = change("react");
    const accounting = accountForUpgrades(
      [react],
      [{ id: upgradeId(react), candidates: [{ id: "c-1", via: "manifest", repo: "a/b" }] }],
      [],
    );

    expect(accounting.accounts).toEqual([
      expect.objectContaining({
        id: upgradeId(react),
        unverifiable: "the report did not account for this upgrade",
      }),
    ]);
  });

  it("names the section's own bound when the model never saw the upgrade", () => {
    const react = change("react");
    const accounting = accountForUpgrades(
      [react],
      [{ id: upgradeId(react), candidates: [{ id: "c-1", via: "manifest", repo: "a/b" }] }],
      [],
      [
        {
          id: upgradeId(react),
          cause: "over-limit",
          reason: "the upgrade is beyond the section's limit",
        },
      ],
    );

    expect(accounting.accounts).toEqual([
      expect.objectContaining({
        id: upgradeId(react),
        // A harness limit is not the model's omission: the reason says which.
        unverifiable:
          "the analysis section did not carry this upgrade — the upgrade is beyond the section's limit",
      }),
    ]);
  });
});
