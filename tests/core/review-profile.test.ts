import { describe, expect, it } from "vite-plus/test";

import type { DependencyChange } from "../../src/core/dependency/types.js";
import { upgradeId } from "../../src/core/dependency/upgrade-id.js";
import { buildDependencyProfile } from "../../src/core/review-profile.js";
import {
  DEPENDENCY_CANDIDATE_LIMIT,
  DEPENDENCY_SECTION_LIMIT,
  dependencyUpgradeSet,
} from "../../src/core/dependency/prompt-section.js";
import type { UpstreamResolution } from "../../src/ci/dependency/resolve.js";

/** One detected upgrade, as the detector reports it. */
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

/** The resolution the harness produced for an upgrade. */
function resolution(target: DependencyChange): UpstreamResolution {
  return {
    id: upgradeId(target),
    candidates: [
      { id: `${upgradeId(target)}-1`, via: "registry-metadata", repo: "facebook/react" },
    ],
  };
}

describe("buildDependencyProfile", () => {
  it("keeps an upgrade whose values the harness can read", () => {
    const target = change();
    const profile = buildDependencyProfile([target], [resolution(target)]);

    expect(profile.kind).toBe("dependency");
    if (profile.kind !== "dependency") throw new Error("expected the dependency profile");
    expect(profile.changes).toEqual([target]);
    expect(profile.resolutions[0]?.candidates).toHaveLength(1);
  });

  it("drops an upgrade whose values the harness cannot read", () => {
    // A package name is written by the manifest, so it is held to a shape the
    // harness can render.
    const target = change({ name: "<script>alert(1)</script>" });
    const profile = buildDependencyProfile([target], [resolution(target)]);

    if (profile.kind !== "dependency") throw new Error("expected the dependency profile");
    expect(profile.changes).toEqual([]);
    // The upgrade is reported as coverage rather than analyzed against a
    // value the harness could not read, and the reason names the value.
    expect(profile.resolutions[0]?.candidates).toEqual([]);
    expect(profile.resolutions[0]?.unresolved).toBe(
      "the package name is not a value the harness can render",
    );
  });

  it("keeps an upgrade the section cannot carry, with the resolution it came with", () => {
    const changes = Array.from({ length: DEPENDENCY_SECTION_LIMIT + 2 }, (_, index) =>
      change({ name: `package-${index}` }),
    );

    const profile = buildDependencyProfile(
      changes,
      changes.map((target) => resolution(target)),
    );

    // The upgrade is still one the harness knows about, so it stays in the
    // profile and it keeps the resolution it came with: a resolution the
    // harness emptied would make an upgrade it can read look like one it
    // cannot.
    expect(profile.changes).toHaveLength(changes.length);
    expect(profile.resolutions.every((entry) => entry.candidates.length > 0)).toBe(true);
    // The section builder omits it again, for the same reason.
    const set = dependencyUpgradeSet(profile.changes, profile.resolutions);
    expect(set.upgrades).toHaveLength(DEPENDENCY_SECTION_LIMIT);
    expect(set.omitted).toHaveLength(2);
    expect(set.omitted[0]?.reason).toBe("the upgrade is beyond the section's limit");
  });

  it("agrees with the prompt builder about an upgrade the section cannot carry", () => {
    // A package's metadata can name a location whose URL is enormous. The
    // profile and the section builder must omit the same upgrade, or the
    // section would carry a record that says it does not belong there.
    const changes = [change({ name: "package-huge" }), change({ name: "package-small" })];
    const resolutions = [
      {
        id: upgradeId(changes[0]!),
        candidates: [
          {
            id: `${upgradeId(changes[0]!)}-1`,
            via: "registry-metadata" as const,
            url: `https://example.com/${"n".repeat(130_000)}`,
          },
        ],
      },
      resolution(changes[1]!),
    ];

    const profile = buildDependencyProfile(changes, resolutions);
    const set = dependencyUpgradeSet(profile.changes, profile.resolutions);

    expect(set.upgrades.map((upgrade) => upgrade.name)).toEqual(["package-small"]);
    expect(set.omitted.map((entry) => entry.reason)).toEqual([
      "the upgrade is beyond the section's size limit",
    ]);
  });

  it("keeps the upgrade it can read when another one cannot", () => {
    const readable = change({ name: "vue" });
    const unreadable = change({ name: "vue<script>" });
    const profile = buildDependencyProfile(
      [readable, unreadable],
      [resolution(readable), resolution(unreadable)],
    );

    if (profile.kind !== "dependency") throw new Error("expected the dependency profile");
    expect(profile.changes).toEqual([readable]);
    expect(
      profile.resolutions.find((entry) => entry.id === upgradeId(readable))?.candidates,
    ).toHaveLength(1);
  });
});

describe("dependencyUpgradeSet", () => {
  it("bounds the section and reports the upgrades it left out", () => {
    const changes = Array.from({ length: DEPENDENCY_SECTION_LIMIT + 3 }, (_, index) =>
      change({ name: `package-${index}` }),
    );

    const set = dependencyUpgradeSet(
      changes,
      changes.map((target) => resolution(target)),
    );

    expect(set.upgrades).toHaveLength(DEPENDENCY_SECTION_LIMIT);
    expect(set.omitted).toHaveLength(3);
    expect(set.omitted[0]?.reason).toContain("limit");
  });

  it("reports an upgrade with no readable location as unresolved", () => {
    const target = change();

    const set = dependencyUpgradeSet(
      [target],
      [{ id: upgradeId(target), candidates: [], unresolved: "no registry describes it" }],
    );

    expect(set.upgrades).toHaveLength(1);
    expect(set.upgrades[0]?.unresolved).toBe("no registry describes it");
  });

  it("bounds the candidates one upgrade carries", () => {
    const target = change();
    const candidates = Array.from({ length: DEPENDENCY_CANDIDATE_LIMIT + 4 }, (_, index) => ({
      id: `${upgradeId(target)}-${index + 1}`,
      via: "registry-metadata" as const,
      url: `https://example.com/notes/${index + 1}`,
    }));

    const set = dependencyUpgradeSet([target], [{ id: upgradeId(target), candidates }]);

    expect(set.upgrades[0]?.candidates).toHaveLength(DEPENDENCY_CANDIDATE_LIMIT);
    expect(set.upgrades[0]?.candidates_omitted).toBe(4);
  });

  it("bounds the section by size as well as by count", () => {
    // A package's metadata can name a location whose URL is enormous, and
    // one record can be large on its own.
    const changes = Array.from({ length: 3 }, (_, index) => change({ name: `package-${index}` }));

    const set = dependencyUpgradeSet(
      changes,
      changes.map((target) => ({
        id: upgradeId(target),
        candidates: [
          {
            id: `${upgradeId(target)}-1`,
            via: "registry-metadata" as const,
            url: `https://example.com/${"n".repeat(80_000)}`,
          },
        ],
      })),
    );

    expect(set.upgrades.length).toBeLessThan(changes.length);
    expect(set.omitted.some((entry) => entry.reason.includes("size limit"))).toBe(true);
  });

  it("drops an upgrade whose package to look up is unreadable", () => {
    const target = change({ name: "npm:renovate", resolvedName: "<script>alert(1)</script>" });

    const set = dependencyUpgradeSet([target], [resolution(target)]);

    expect(set.upgrades).toHaveLength(0);
    expect(set.omitted[0]?.cause).toBe("unreadable");
    expect(set.omitted[0]?.reason).toContain("package name to look up");
  });

  it("keeps a constraint a git shorthand carries", () => {
    // An npm dependency on a GitHub repository writes the fragment beside
    // the version, and the report has to name it.
    const target = change({ from: "github:owner/repo#semver:^2.0.0" });

    const set = dependencyUpgradeSet([target], [resolution(target)]);

    expect(set.upgrades).toHaveLength(1);
    expect(set.upgrades[0]?.from).toBe("github:owner/repo#semver:^2.0.0");
  });

  it("keeps a section whose name carries a space", () => {
    const target = change({ section: "my group" });

    const set = dependencyUpgradeSet([target], [resolution(target)]);

    expect(set.upgrades).toHaveLength(1);
    expect(set.upgrades[0]?.section).toBe("my group");
  });

  it("drops a value that carries an invisible character", () => {
    // A bidirectional mark reorders the text around it, and a C1 control is
    // not text at all.
    const target = change({ manifest: "apps/\u202eevil/package.json" });

    const set = dependencyUpgradeSet([target], [resolution(target)]);

    expect(set.upgrades).toHaveLength(0);
    expect(set.omitted[0]?.cause).toBe("unreadable");
  });

  it("keeps a manifest path that carries a space", () => {
    // A git tree holds a directory whose name carries a space.
    const target = change({ manifest: "apps/My App/package.json" });

    const set = dependencyUpgradeSet([target], [resolution(target)]);

    expect(set.upgrades).toHaveLength(1);
    expect(set.upgrades[0]?.manifest).toBe("apps/My App/package.json");
  });

  it("drops a manifest path that escapes the checkout", () => {
    const target = change({ manifest: "../package.json" });

    const set = dependencyUpgradeSet([target], [resolution(target)]);

    expect(set.upgrades).toHaveLength(0);
    expect(set.omitted[0]?.cause).toBe("unreadable");
  });

  it("agrees with the prompt builder about the upgrades it carries", () => {
    // The profile builder drops the upgrades it cannot read, and the prompt
    // builder re-derives the set from what the profile carries: the two must
    // not disagree about which upgrades the section holds.
    const unreadable = change({ name: "package-unreadable<script>" });
    const readable = Array.from({ length: DEPENDENCY_SECTION_LIMIT }, (_, index) =>
      change({ name: `package-${index}` }),
    );
    const changes = [unreadable, ...readable];

    const profile = buildDependencyProfile(
      changes,
      changes.map((target) => resolution(target)),
    );
    const set = dependencyUpgradeSet(profile.changes, profile.resolutions);

    expect(set.upgrades).toHaveLength(DEPENDENCY_SECTION_LIMIT);
    expect(set.omitted).toHaveLength(0);
    // The unreadable upgrade is out of the section and out of the profile,
    // and its resolution names the cause.
    expect(profile.changes).toHaveLength(DEPENDENCY_SECTION_LIMIT);
    const dropped = profile.resolutions.find((entry) => entry.candidates.length === 0);
    expect(dropped?.unresolved).toBe("the package name is not a value the harness can render");
  });

  it("drops a candidate the reader would refuse", () => {
    const target = change();

    const set = dependencyUpgradeSet(
      [target],
      [
        {
          id: upgradeId(target),
          candidates: [
            { id: `${upgradeId(target)}-1`, via: "registry-metadata", repo: "not-a-repo" },
            {
              id: `${upgradeId(target)}-2`,
              via: "registry-metadata",
              url: "http://example.com/notes",
            },
          ],
        },
      ],
    );

    expect(set.upgrades[0]?.candidates).toEqual([]);
    expect(set.upgrades[0]?.unresolved).toContain("no readable upstream location");
  });

  it("keeps a URL candidate whose path is a URL pathname", () => {
    // The resolver reports the pathname of a URL location, and it starts
    // with a separator: the location is readable, and only the hint is not a
    // repository path.
    const target = change();

    const set = dependencyUpgradeSet(
      [target],
      [
        {
          id: upgradeId(target),
          candidates: [
            {
              id: `${upgradeId(target)}-1`,
              via: "registry-metadata",
              url: "https://example.com/en/latest/",
              path: "/en/latest/",
            },
          ],
        },
      ],
    );

    expect(set.upgrades[0]?.candidates).toHaveLength(1);
    expect(set.upgrades[0]?.candidates[0]?.url).toBe("https://example.com/en/latest/");
    expect(set.upgrades[0]?.unresolved).toBeUndefined();
  });

  it("keeps a repository candidate whose path carries a space", () => {
    // A git tree holds a file called "Release Notes.md", and the repository
    // is readable with or without the hint.
    const target = change();

    const set = dependencyUpgradeSet(
      [target],
      [
        {
          id: upgradeId(target),
          candidates: [
            {
              id: `${upgradeId(target)}-1`,
              via: "registry-metadata",
              repo: "owner/repo",
              path: "Release Notes.md",
            },
          ],
        },
      ],
    );

    expect(set.upgrades[0]?.candidates).toHaveLength(1);
    expect(set.upgrades[0]?.candidates[0]?.path).toBe("Release Notes.md");
  });

  it("drops a path hint that traverses out of its location", () => {
    const target = change();

    const set = dependencyUpgradeSet(
      [target],
      [
        {
          id: upgradeId(target),
          candidates: [
            {
              id: `${upgradeId(target)}-1`,
              via: "registry-metadata",
              repo: "owner/repo",
              path: "../../etc/passwd",
            },
          ],
        },
      ],
    );

    expect(set.upgrades[0]?.candidates).toHaveLength(1);
    expect(set.upgrades[0]?.candidates[0]?.path).toBeUndefined();
  });
});
