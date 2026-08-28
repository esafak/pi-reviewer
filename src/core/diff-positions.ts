import type { ReviewComment } from "./output.js";

/**
 * Positionability analysis for review comments.
 *
 * GitHub's PR Reviews API only accepts inline comments whose (file, line, side)
 * is positionable on the diff at the review's commit_id:
 *   - the file must appear in the diff, and
 *   - the line must be a line shown inside a hunk (added/removed/context) for
 *     that side.
 * Any comment outside the hunks causes the ENTIRE review to be rejected with
 * 422. This module computes the positionable line sets from a unified diff so
 * the caller can split comments into "inline" (safe to attach) and "moved"
 * (kept in the review body instead).
 */

/** Positionable line sets for one file: which lines may receive a LEFT/RIGHT comment. */
export interface DiffPositions {
  left: Set<number>;
  right: Set<number>;
}

export type DiffPositionMap = Map<string, DiffPositions>;

/**
 * Parse a unified diff into per-file positionable line sets.
 *
 * For every hunk `@@ -l1,s1 +l2,s2 @@`, tracks the old-file and new-file line
 * numbers: a context line (space) exists on both sides, a `-` line only on the
 * old (LEFT) side, a `+` line only on the new (RIGHT) side. `\ No newline at
 * end of file` markers advance nothing.
 *
 * Handles the standard edge cases: brand-new files (`@@ -0,0 +1,n @@`),
 * deleted files (only LEFT lines), binary files (no hunks → empty sets), and
 * multiple hunks per file.
 */
export function parseDiffPositions(diff: string): DiffPositionMap {
  const map: DiffPositionMap = new Map();
  const sections = diff.split(/(?=^diff --git )/m).filter((s) => s.trim());

  for (const section of sections) {
    const header = section.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (!header) continue;
    const path = header[1];

    const left = new Set<number>();
    const right = new Set<number>();
    let curLeft = 0;
    let curRight = 0;

    for (const line of section.split("\n")) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        curLeft = Number(hunk[1]);
        curRight = Number(hunk[2]);
        continue;
      }
      // Skip header lines (index/---/+++/mode) that appear before the first hunk.
      if (curLeft === 0 && curRight === 0) continue;
      const c = line[0];
      if (c === "\\") continue; // "\ No newline at end of file"
      if (c === " ") {
        left.add(curLeft); curLeft += 1;
        right.add(curRight); curRight += 1;
      } else if (c === "-") {
        left.add(curLeft); curLeft += 1;
      } else if (c === "+") {
        right.add(curRight); curRight += 1;
      }
    }

    map.set(path, { left, right });
  }

  return map;
}

export interface PartitionResult {
  /** Comments whose (file, line, side) is positionable on the diff — safe to post inline. */
  inline: ReviewComment[];
  /** Comments that could not be attached to a diff line — kept for the review body. */
  moved: ReviewComment[];
}

/**
 * Split comments into positionable (inline) and non-positionable (moved) sets.
 *
 * Applies lossless dedup on comment identity `(file, line, side, body)` so an
 * accidentally duplicated comment emitted by the model is not posted twice.
 * Two distinct comments on the same line are both kept — GitHub accepts
 * multiple inline comments per line within a single review.
 */
export function partitionComments(
  comments: ReviewComment[],
  positions: DiffPositionMap,
): PartitionResult {
  const inline: ReviewComment[] = [];
  const moved: ReviewComment[] = [];
  const seen = new Set<string>();

  for (const comment of comments) {
    const key = `${comment.file}:${comment.line}:${comment.side}:${comment.body}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const pos = positions.get(comment.file);
    const positionable =
      pos !== undefined &&
      (comment.side === "LEFT" ? pos.left.has(comment.line) : pos.right.has(comment.line));

    if (positionable) inline.push(comment);
    else moved.push(comment);
  }

  return { inline, moved };
}
