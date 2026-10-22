import { execFileSync } from "node:child_process";

import { compareManifests } from "../../core/dependency/compare.js";
import {
  UNSUPPORTED_MANIFESTS,
  isSupportedManifest,
  manifestFormat,
  parseManifest,
} from "../../core/dependency/manifests.js";
import type { DependencyChange, DependencyRecord } from "../../core/dependency/types.js";
import { gitEnv } from "../../core/git-env.js";

/** A file's presence at one end of a range. */
export interface ChangedPath {
  status: "added" | "modified" | "deleted" | "renamed";
  /** The path before the change. */
  oldPath?: string;
  /** The path after the change. */
  newPath?: string;
}

/** The paths that changed, and whether the diff could be read. */
export interface ChangedPathsResult {
  paths: ChangedPath[];
  /** The diff could not be read, so nothing is known about the range. */
  error?: string;
}

/** A manifest read at one revision. */
export interface ManifestSnapshot {
  text?: string;
  /** The path does not exist at that revision. */
  missing: boolean;
  /** The read failed; the manifest was not seen. */
  error?: string;
}

/** What the detector found in a range. */
export interface DependencyDetection {
  changes: DependencyChange[];
  /** Manifests that changed but are not read. */
  unsupported: string[];
  /** Coverage gaps: read failures, parse warnings, unresolvable constraints. */
  warnings: string[];
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function isRevision(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

/**
 * Reads a file at a revision.
 *
 * A path that does not exist there is missing, not an error: a manifest
 * added in the range has no before-snapshot. A read that fails is an error,
 * and it is visible coverage — never silently an empty manifest.
 */
export function readFileAtRevision(
  cwd: string,
  revision: string,
  filePath: string,
): ManifestSnapshot {
  if (!isRevision(revision)) return { missing: false, error: "invalid revision" };
  try {
    const text = execFileSync("git", ["show", `${revision}:${filePath}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_MANIFEST_BYTES,
      // The error is read to tell a path that is absent from a read that
      // failed, so stderr is captured rather than discarded.
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES)
      return { missing: false, error: "manifest exceeds the size limit" };
    return { text, missing: false };
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
    if (/does not exist|exists on disk, but not in|no such path/i.test(stderr))
      return { missing: true };
    return { missing: false, error: "manifest could not be read at that revision" };
  }
}

/**
 * The paths that changed between two revisions.
 *
 * The name-status output is NUL-delimited so a path containing a space or a
 * quote survives, and renames are detected so a manifest that moved is read
 * from its old path before the change and its new path after it.
 */
export function changedPaths(
  cwd: string,
  fromRevision: string,
  toRevision: string,
): ChangedPathsResult {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["diff", "--name-status", "-z", "--find-renames", fromRevision, toRevision],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_MANIFEST_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        env: gitEnv(),
      },
    );
  } catch {
    // A diff that could not be read means nothing is known about the range,
    // which is not the same as nothing having changed.
    return { paths: [], error: "the changed paths could not be read" };
  }
  const fields = output.split("\0").filter((field) => field.length > 0);
  const paths: ChangedPath[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) continue;
    const code = status[0];
    if (code === "R") {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      index += 2;
      if (!oldPath || !newPath) continue;
      paths.push({ status: "renamed", oldPath, newPath });
      continue;
    }
    const filePath = fields[index + 1];
    index += 1;
    if (!filePath) continue;
    if (code === "A") paths.push({ status: "added", newPath: filePath });
    else if (code === "D") paths.push({ status: "deleted", oldPath: filePath });
    else paths.push({ status: "modified", oldPath: filePath, newPath: filePath });
  }
  return { paths };
}

/** Whether a path is on the unsupported inventory. */
function isUnsupportedManifest(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return UNSUPPORTED_MANIFESTS.some(
    (candidate) =>
      candidate === name || (candidate.startsWith("*") && name.endsWith(candidate.slice(1))),
  );
}

/**
 * Finds the dependency changes in a range.
 *
 * The diff only says which manifests changed. Each one is then read whole
 * at both ends of the range, because a unified diff carries limited context:
 * a section header, an artifact identifier, or the enclosing table can sit
 * outside the hunk.
 */
export function detectDependencyChanges(
  cwd: string,
  fromRevision: string,
  toRevision: string,
): DependencyDetection {
  const changes: DependencyChange[] = [];
  const unsupported: string[] = [];
  const warnings: string[] = [];
  const diff = changedPaths(cwd, fromRevision, toRevision);
  if (diff.error) {
    warnings.push(diff.error);
    return { changes, unsupported, warnings };
  }
  for (const changed of diff.paths) {
    const beforePath = changed.oldPath;
    const afterPath = changed.newPath;
    if (!beforePath && !afterPath) continue;
    const path = afterPath ?? beforePath;
    if (!path) continue;
    // Each side is judged on its own: a manifest that moved to a name the
    // detector does not read is a removal, and one that moved to a name it
    // does read is an addition.
    const beforeIsManifest = beforePath ? isSupportedManifest(beforePath) : false;
    const afterIsManifest = afterPath ? isSupportedManifest(afterPath) : false;
    for (const side of [beforePath, afterPath]) {
      if (side && isUnsupportedManifest(side) && !unsupported.includes(side))
        unsupported.push(side);
    }
    if (!beforeIsManifest && !afterIsManifest) continue;
    const before = beforePath
      ? readFileAtRevision(cwd, fromRevision, beforePath)
      : { missing: true as const };
    const after = afterPath
      ? readFileAtRevision(cwd, toRevision, afterPath)
      : { missing: true as const };
    if (before.error) warnings.push(`${beforePath}: ${before.error}`);
    if (after.error) warnings.push(`${afterPath}: ${after.error}`);
    if (before.error || after.error) continue;
    const beforeRecords =
      beforeIsManifest && before.text !== undefined
        ? parseRecords(beforePath ?? path, before.text, warnings)
        : [];
    const afterRecords =
      afterIsManifest && after.text !== undefined
        ? parseRecords(afterPath ?? path, after.text, warnings)
        : [];
    // The two sides are only comparable when they are the same format; a
    // manifest that changed shape is a removal plus an addition.
    const beforeFormat = beforePath ? manifestFormat(beforePath) : undefined;
    const afterFormat = afterPath ? manifestFormat(afterPath) : undefined;
    if (beforeFormat && afterFormat && beforeFormat !== afterFormat) {
      changes.push(...compareManifests(beforeRecords, [], path));
      changes.push(...compareManifests([], afterRecords, path));
      continue;
    }
    const found = compareManifests(beforeRecords, afterRecords, path);
    for (const change of found) {
      if (change.kind === "unresolved")
        warnings.push(
          `${path}: ${change.name} has a version that cannot be compared (${change.from ?? ""} → ${change.to ?? ""})`,
        );
    }
    changes.push(...found);
  }
  return { changes, unsupported, warnings };
}

function parseRecords(manifest: string, text: string, warnings: string[]): DependencyRecord[] {
  const format = manifestFormat(manifest);
  if (!format) return [];
  const parsed = parseManifest(format, text, manifest);
  for (const warning of parsed.warnings) warnings.push(`${manifest}: ${warning}`);
  return parsed.records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
