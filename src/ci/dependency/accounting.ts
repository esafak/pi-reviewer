/**
 * What the analysis can say about each qualifying upgrade.
 *
 * The harness publishes a disposition for every upgrade, whatever the model
 * reported: an upgrade is either researched, with a citation the harness
 * accepted, or unverifiable, with the reason the harness or the model gave.
 * The rule the module exists to hold is that **silence is not an answer** — a
 * model that researched nothing and said nothing is indistinguishable from
 * one that researched nothing and said so, and only the first is a
 * disposition.
 *
 * The state is derived from three independent sources, and the first one is
 * unconditional: the harness knows what it could not make reachable, so a
 * model's claim that it researched an upgrade with no readable candidate does
 * not override that.
 */

import type { DependencyChange } from "../../core/dependency/types.js";
import { upgradeId } from "../../core/dependency/upgrade-id.js";
import { validateResearch, type UpgradeResearch, type UpstreamResolution } from "./resolve.js";

/** One qualifying upgrade, and what the analysis can say about it. */
export interface UpgradeAccount {
  /** The harness-assigned upgrade id. */
  id: string;
  /** The package as the manifest writes it; absent for an upgrade the harness could not read. */
  name?: string;
  /** The manifest the upgrade was found in; absent for an upgrade it could not read. */
  manifest?: string;
  /** The citation the harness accepted, in the form the model reported it. */
  citation?: string;
  /** The repository-relative path a `local:` citation names, when it names one. */
  checkoutPath?: string;
  /** Why the upgrade is unverifiable; absent when it was researched. */
  unverifiable?: string;
}

/** The dispositions the analysis publishes, and the entries it discarded. */
export interface DependencyAccounting {
  /** One account per qualifying upgrade, in the order the detector found them. */
  accounts: UpgradeAccount[];
  /** The report entries the harness discarded, and why. */
  diagnostics: string[];
}

/**
 * Derives what the analysis can say about every qualifying upgrade.
 *
 * An upgrade is unverifiable when any of three things holds:
 *
 * 1. the harness has no readable candidate for it — this is unconditional,
 *    because the harness knows what it could not make reachable and a claim
 *    does not change that;
 * 2. the model reported it as unverified;
 * 3. the disposition is missing, conflicting, or invalid.
 *
 * An upgrade whose values the harness could not read is not in `changes` — the
 * profile leaves it out — but its resolution is, with the reason it was
 * dropped. It is therefore reported too: the analysis must not lose an
 * upgrade it could not read.
 */
export function accountForUpgrades(
  changes: readonly DependencyChange[],
  resolutions: readonly UpstreamResolution[],
  report: readonly UpgradeResearch[],
): DependencyAccounting {
  const ids = changes.map(upgradeId);
  const validation = validateResearch(report, resolutions, ids);
  const accepted = new Map(validation.accepted.map((entry) => [entry.id, entry]));
  const byId = new Map(resolutions.map((resolution) => [resolution.id, resolution]));

  const accounts: UpgradeAccount[] = [];
  for (const change of changes) {
    const id = upgradeId(change);
    const base = { id, name: change.name, manifest: change.manifest };
    const resolution = byId.get(id);
    const disposition = accepted.get(id);
    if (!resolution?.candidates.length) {
      accounts.push({
        ...base,
        unverifiable:
          resolution?.unresolved ?? "no readable upstream location was resolved for this upgrade",
      });
      continue;
    }
    if (!disposition) {
      accounts.push({
        ...base,
        unverifiable: "the report did not account for this upgrade",
      });
      continue;
    }
    if (disposition.status === "unverified") {
      accounts.push({ ...base, unverifiable: disposition.reason });
      continue;
    }
    const path = disposition.source.startsWith("local:")
      ? disposition.source.slice("local:".length)
      : undefined;
    accounts.push({
      ...base,
      citation: disposition.source,
      ...(path !== undefined ? { checkoutPath: path } : {}),
    });
  }

  // An upgrade the profile left out has no change to name it with, but its
  // resolution still says why it was dropped.
  for (const resolution of resolutions) {
    if (ids.includes(resolution.id)) continue;
    accounts.push({
      id: resolution.id,
      unverifiable:
        resolution.unresolved ?? "the harness could not read the values of this upgrade",
    });
  }

  return { accounts, diagnostics: [...validation.diagnostics] };
}
