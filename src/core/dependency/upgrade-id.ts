import { createHash } from "node:crypto";

import type { DependencyChange } from "./types.js";

/**
 * The harness-assigned id for an upgrade.
 *
 * The id names one upgrade in one manifest and one section: the same package
 * can be upgraded in several sections and in several workspace manifests,
 * and a name alone cannot tell them apart. It is derived from the manifest
 * path, the registry, the package name, and the section, so the same
 * upgrade receives the same id on every run.
 */
export function upgradeId(change: DependencyChange): string {
  const identity = JSON.stringify([change.manifest, change.registry, change.name, change.section]);
  return `u-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`;
}
