import type { DependencyChange, DependencyRecord } from "./types.js";
import { classifyVersionChange, goModuleMajorSuffix } from "./versions.js";

/**
 * The identity a record is paired by when nothing else matches.
 *
 * A Go module's major version lives in its path, so `example.com/m` and
 * `example.com/m/v2` are one module at two majors. Every other registry
 * keeps its identity in the name.
 */
export function recordIdentity(record: DependencyRecord): string {
  if (record.registry === "go") return record.name.replace(/\/v\d+$/, "");
  return record.name;
}

/** The identity two records share exactly. */
function exactKey(record: DependencyRecord): string {
  return `${record.name}\u0000${record.section}`;
}

/** The identity two records share once a major path suffix is ignored. */
function normalizedKey(record: DependencyRecord): string {
  return `${recordIdentity(record)}\u0000${record.section}`;
}

/**
 * Compares two revisions of one manifest.
 *
 * Records are paired by identity and section, never by position: a manifest
 * that reorders its entries describes the same dependencies. A record whose
 * constraint is unchanged is not a change at all.
 *
 * Pairing happens in two passes. The first pairs records that kept their
 * exact name and section. The second pairs what is left by their normalized
 * identity, which is how a Go module's major path transition is recognized
 * without also matching a module against an unrelated one. A group with
 * more than one candidate on a side cannot be paired without guessing, so
 * it is reported as removals and additions.
 *
 * A manifest may declare the same package more than once, so the first pass
 * pairs the declarations whose version did not change before it pairs the
 * rest. A reordering is then not a change, and a declaration that changed
 * is paired with the one it replaced.
 */
export function compareManifests(
  before: DependencyRecord[],
  after: DependencyRecord[],
  manifest: string,
): DependencyChange[] {
  const changes: DependencyChange[] = [];
  const pairedAfter = new Set<DependencyRecord>();
  const unmatchedBefore: DependencyRecord[] = [];

  const afterByExact = new Map<string, DependencyRecord[]>();
  for (const record of after) {
    const key = exactKey(record);
    const bucket = afterByExact.get(key);
    if (bucket) bucket.push(record);
    else afterByExact.set(key, [record]);
  }
  const beforeByExact = new Map<string, DependencyRecord[]>();
  for (const record of before) {
    const key = exactKey(record);
    const bucket = beforeByExact.get(key);
    if (bucket) bucket.push(record);
    else beforeByExact.set(key, [record]);
  }
  for (const [key, beforeRecords] of beforeByExact) {
    const afterRecords = afterByExact.get(key) ?? [];
    // An exact match needs one record on each side. Two records that share
    // a name and a section cannot be told apart, and pairing the first of
    // them would decide by iteration order.
    if (beforeRecords.length === 1 && afterRecords.length === 1) {
      pairedAfter.add(afterRecords[0]);
      changes.push(...comparePair(beforeRecords[0], afterRecords[0], manifest));
      continue;
    }
    // A manifest may declare the same package more than once: a workflow
    // that pins one action in two steps. The declarations whose version did
    // not change are paired first, so a reordering is not a change, and the
    // declarations that are left changed are paired when they all carry the
    // same version: every one of them changed to the other version, and
    // that is one transition rather than one per declaration.
    const unmatchedAfterRecords = [...afterRecords];
    const unmatchedBeforeRecords: DependencyRecord[] = [];
    for (const before of beforeRecords) {
      const index = unmatchedAfterRecords.findIndex(
        (after) => after.constraint === before.constraint,
      );
      if (index === -1) {
        unmatchedBeforeRecords.push(before);
        continue;
      }
      const [after] = unmatchedAfterRecords.splice(index, 1);
      pairedAfter.add(after);
      changes.push(...comparePair(before, after, manifest));
    }
    if (unmatchedBeforeRecords.length && unmatchedAfterRecords.length) {
      const beforeVersion = unmatchedBeforeRecords[0]!.constraint;
      const afterVersion = unmatchedAfterRecords[0]!.constraint;
      const homogeneous =
        unmatchedBeforeRecords.every((entry) => entry.constraint === beforeVersion) &&
        unmatchedAfterRecords.every((entry) => entry.constraint === afterVersion);
      if (homogeneous) {
        const pairs = Math.min(unmatchedBeforeRecords.length, unmatchedAfterRecords.length);
        for (let index = 0; index < pairs; index += 1) {
          const after = unmatchedAfterRecords[index]!;
          pairedAfter.add(after);
          // The transition is one change, however many declarations carry it.
          if (index === 0) {
            changes.push(...comparePair(unmatchedBeforeRecords[index]!, after, manifest));
          }
        }
        // The declarations that have no counterpart are reported as removals
        // and additions.
        unmatchedBeforeRecords.splice(0, pairs);
      }
    }
    unmatchedBefore.push(...unmatchedBeforeRecords);
  }

  const leftoverAfter = after.filter((record) => !pairedAfter.has(record));
  const afterByNormalized = new Map<string, DependencyRecord[]>();
  for (const record of leftoverAfter) {
    const key = normalizedKey(record);
    const bucket = afterByNormalized.get(key);
    if (bucket) bucket.push(record);
    else afterByNormalized.set(key, [record]);
  }
  const beforeByNormalized = new Map<string, DependencyRecord[]>();
  for (const record of unmatchedBefore) {
    const key = normalizedKey(record);
    const bucket = beforeByNormalized.get(key);
    if (bucket) bucket.push(record);
    else beforeByNormalized.set(key, [record]);
  }
  const stillUnmatched: DependencyRecord[] = [];
  for (const record of unmatchedBefore) {
    const bucket = afterByNormalized.get(normalizedKey(record));
    const candidates = beforeByNormalized.get(normalizedKey(record));
    // A cross-major match needs exactly one candidate on each side; two
    // records that share an identity cannot be told apart, and guessing
    // which one moved would invent an upgrade that never happened.
    if (bucket && bucket.length === 1 && candidates && candidates.length === 1) {
      pairedAfter.add(bucket[0]);
      changes.push(...comparePair(record, bucket[0], manifest));
      continue;
    }
    stillUnmatched.push(record);
  }

  changes.push(...removals(stillUnmatched, manifest));
  changes.push(
    ...additions(
      after.filter((record) => !pairedAfter.has(record)),
      manifest,
    ),
  );
  return changes;
}

function comparePair(
  before: DependencyRecord,
  after: DependencyRecord,
  manifest: string,
): DependencyChange[] {
  // An unchanged constraint is not a change. The one exception is the Go
  // path suffix, which is where the major lives: an entry that moved to a
  // `/vN` path changed its major even when the constraint it wrote did not.
  if (before.constraint === after.constraint) {
    const beforeMajor = goModuleMajorSuffix(before.name);
    const afterMajor = goModuleMajorSuffix(after.name);
    if (beforeMajor === afterMajor) return [];
  }
  const classified = classifyVersionChange(
    after.dialect,
    before.constraint,
    after.constraint,
    // The entries' own identities, because a Go module keeps its major
    // version in its path.
    { from: before.name, to: after.name },
  );
  // The version did not change, so there is no version change to report.
  if (!classified) return [];
  return [
    {
      registry: after.registry,
      dialect: after.dialect,
      category: after.category,
      name: after.name,
      section: after.section,
      ...(after.resolvedName ? { resolvedName: after.resolvedName } : {}),
      from: before.constraint,
      to: after.constraint,
      ...(classified.fromVersion ? { fromVersion: classified.fromVersion } : {}),
      ...(classified.toVersion ? { toVersion: classified.toVersion } : {}),
      kind: classified.kind,
      manifest,
      ...(before.name !== after.name ? { previousName: before.name } : {}),
    },
  ];
}

function removals(records: DependencyRecord[], manifest: string): DependencyChange[] {
  return records.map((record) => ({
    registry: record.registry,
    dialect: record.dialect,
    category: record.category,
    name: record.name,
    section: record.section,
    ...(record.resolvedName ? { resolvedName: record.resolvedName } : {}),
    from: record.constraint,
    kind: "removed" as const,
    manifest,
  }));
}

function additions(records: DependencyRecord[], manifest: string): DependencyChange[] {
  return records.map((record) => ({
    registry: record.registry,
    dialect: record.dialect,
    category: record.category,
    name: record.name,
    section: record.section,
    ...(record.resolvedName ? { resolvedName: record.resolvedName } : {}),
    to: record.constraint,
    kind: "added" as const,
    manifest,
  }));
}
