/**
 * Where an upgrade sits in the diff.
 *
 * The harness anchors the findings it writes itself — the coverage warnings —
 * on the line the constraint changed on, so a reviewer sees them next to the
 * upgrade they are about. The map is built from the diff and the detected
 * changes alone, so it does not depend on anything the model reported: a
 * finding's anchor is a property of the pull request.
 *
 * The anchor is best-effort by design. A manifest the detector read whole may
 * have changed on a line the diff does not show (the change came from another
 * hunk, or the file section was dropped for size), and then the upgrade has no
 * position and its warning is published in the review body instead. An
 * approximate position would be worse than none: a warning on the wrong line
 * names a change the pull request did not make.
 */

import type { DependencyChange } from "../../core/dependency/types.js";
import { upgradeId } from "../../core/dependency/upgrade-id.js";

/** One upgrade and the diff line its constraint changed on. */
export interface DependencyAnchor {
  /** The harness-assigned upgrade id. */
  id: string;
  /** The manifest path the upgrade was found in. */
  manifest: string;
  /** The diff line the upgrade's version changed on, when positionable. */
  file?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
}

/** The added lines of one file in the diff. */
interface AddedLine {
  line: number;
  content: string;
}

/**
 * The added lines of every file section in a unified diff, by path.
 *
 * Only the right side is read: an upgrade the pull request makes is a line the
 * head has, and a changed line that only exists on the left side is the old
 * value the upgrade replaced.
 */
function addedLinesByPath(diff: string): Map<string, AddedLine[]> {
  const byPath = new Map<string, AddedLine[]>();
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const header = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!header) continue;
    const path = header[1]!;
    const lines: AddedLine[] = [];
    let newLine = 0;
    for (const line of section.split("\n")) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }
      if (newLine === 0) continue;
      const marker = line[0];
      if (marker === "\\") continue;
      if (marker === "+") {
        lines.push({ line: newLine, content: line.slice(1) });
        newLine += 1;
      } else if (marker === " ") {
        newLine += 1;
      }
    }
    byPath.set(path, lines);
  }
  return byPath;
}

/**
 * Builds the anchor of every detected upgrade.
 *
 * A declaration is matched on the line the manifest writes its key on. The
 * line that also carries the new constraint wins: a manifest may name the same
 * package in more than one section, and the constraint it now declares is what
 * tells the changed declaration from the one that did not change.
 */
export function buildDependencyAnchors(
  changes: readonly DependencyChange[],
  diff: string,
): DependencyAnchor[] {
  const added = addedLinesByPath(diff);
  return changes.map((change) => {
    const base: DependencyAnchor = { id: upgradeId(change), manifest: change.manifest };
    const lines = added.get(change.manifest);
    if (!lines || !change.name.length) return base;
    const named = lines.filter((line) => line.content.includes(change.name));
    if (!named.length) return base;
    const converted =
      change.to === undefined
        ? undefined
        : named.filter((line) => line.content.includes(change.to!));
    const anchor = converted?.[0] ?? named[0]!;
    return { ...base, file: change.manifest, line: anchor.line, side: "RIGHT" };
  });
}
