import type { DependencyChange } from "./dependency/types.js";
import { upgradeId } from "./dependency/upgrade-id.js";
import { dependencyUpgradeSet } from "./dependency/prompt-section.js";
import type { UpstreamResolution } from "../ci/dependency/resolve.js";

/**
 * What the reviewer is being asked to do.
 *
 * The code profile reviews a diff. The dependency profile reviews the
 * upgrades a pull request makes, against the upstream locations the harness
 * resolved for them: the question is not what the diff says, but whether the
 * upstream release notes break the code that consumes the new version.
 *
 * The profile is the one thing that tells the prompt which instructions
 * apply, so the two modes cannot contradict each other in the same prompt.
 */
export type ReviewProfile =
  | { kind: "code" }
  | { kind: "dependency"; changes: DependencyChange[]; resolutions: UpstreamResolution[] };

/** The profile that reviews a diff. */
export type CodeProfile = Extract<ReviewProfile, { kind: "code" }>;

/** The profile that reviews dependency upgrades against their upstreams. */
export type DependencyProfile = Extract<ReviewProfile, { kind: "dependency" }>;

/**
 * Builds the dependency profile from the qualifying changes and their
 * resolutions.
 *
 * The caller decides what qualifies: a patch bump is coverage, not an
 * upgrade, and the threshold belongs to the mode's flow rather than to the
 * profile.
 *
 * An upgrade whose values the harness cannot read is left out of the
 * profile, and its resolution is marked unresolved: the harness could not
 * read the upgrade, so it reports it as coverage rather than analyzing it
 * against a value it does not trust. Such a resolution names an upgrade
 * that is absent from `changes`, and its `unresolved` reason is the
 * coverage the check reports.
 *
 * An upgrade the section cannot carry — because the section is bounded —
 * stays in the profile, with the resolution it came with: the section
 * builder omits it again for the same reason, and a resolution the harness
 * emptied would make an upgrade it can read look like one it cannot.
 * `dependencyUpgradeSet` is the single source of truth for that omission.
 */
export function buildDependencyProfile(
  changes: readonly DependencyChange[],
  resolutions: readonly UpstreamResolution[],
): DependencyProfile {
  const set = dependencyUpgradeSet(changes, resolutions);
  const unreadable = new Set(
    set.omitted.filter((entry) => entry.cause === "unreadable").map((entry) => entry.id),
  );
  const reasons = new Map(
    set.omitted
      .filter((entry) => entry.cause === "unreadable")
      .map((entry) => [entry.id, entry.reason]),
  );
  return {
    kind: "dependency",
    changes: changes.filter((change) => !unreadable.has(upgradeId(change))),
    resolutions: resolutions.map((resolution) => {
      const reason = reasons.get(resolution.id);
      if (reason === undefined) return resolution;
      return { id: resolution.id, candidates: [], unresolved: reason };
    }),
  };
}
