import type { DependencyChange } from "./types.js";

/**
 * The breaking-change threshold.
 *
 * A library is analyzed on a major change and on a minor change below
 * `1.0`, where semver gives no protection. A tool is also analyzed on a
 * minor change: runtimes break across minor versions, so `python 3.11` to
 * `3.12` and `go 1.21` to `1.22` are analyzed even though neither is a
 * major change.
 */
export function isBreakingRelevant(change: DependencyChange): boolean {
  if (change.kind === "major" || change.kind === "pre-1.0-minor") return true;
  return change.category === "tool" && change.kind === "minor";
}
