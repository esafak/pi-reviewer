import type { VersionChangeKind, VersionDialect } from "./types.js";

/** The comparators a constraint may carry. At most one is permitted. */
export type Comparator = ">=" | ">" | "==" | "=" | "~=" | "^" | "~" | "~>";

const COMPARATORS: readonly Comparator[] = [">=", ">", "==", "=", "~=", "^", "~", "~>"];

/** A constraint split into its parts. */
export interface ParsedConstraint {
  /** The comparator, when the constraint carried one. */
  comparator?: Comparator;
  /** The version text. */
  version: string;
}

/**
 * A release qualifier, in the dialect's own terms.
 *
 * The label is what the dialect calls it: a PEP 440 pre-release label, or
 * a semver identifier list. The number is the sequence number a dialect
 * gives, and the text is the verbatim form, which the comparison
 * representative keeps.
 */
export interface Qualifier {
  /** The dialect's label for the qualifier. */
  label: string;
  /** The sequence number, when the dialect gives one. */
  number?: number;
  /** The verbatim text. */
  text: string;
}

/** One segment of a PEP 440 local version label. */
export interface LocalSegment {
  /** A numeric segment sorts above an alphanumeric one. */
  numeric: boolean;
  /** The digits of a numeric segment, without leading zeros. */
  digits?: string;
  /** The text of an alphanumeric segment. */
  text?: string;
}

/** A version the comparison can order. */
export interface ParsedVersion {
  /** The grammar the version was read with. */
  dialect: VersionDialect;
  /**
   * The PEP 440 epoch. It is the highest-order version component, so a
   * change to it outranks every other difference.
   */
  epoch: number;
  major: number;
  minor: number;
  patch: number;
  /**
   * The number of release components the version was written with, so `1.2`
   * and `1.2.0` stay distinguishable even though they compare equal.
   */
  components: 1 | 2 | 3;
  /** The pre-release qualifier. */
  pre?: Qualifier;
  /** The post-release qualifier. */
  post?: Qualifier;
  /** The dev-release qualifier. */
  dev?: Qualifier;
  /** The build metadata, which does not participate in ordering. */
  build?: string;
  /** The local version, whose segments are compared separately. */
  local?: LocalSegment[];
  /** The comparison excludes the bound itself. */
  exclusive: boolean;
}

const SEMVER_VERSION =
  /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const NUMERIC_VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const PEP440_VERSION =
  /^(?:(\d+)!)?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:(a|b|c|rc|alpha|beta|pre|preview)[.-]?(\d*))?(?:\.post(?:release)?[.-]?(\d*))?(?:\.dev[.-]?(\d*))?(?:\+([0-9A-Za-z.-]+))?$/;

/** The PEP 440 pre-release labels, in the order they rank. */
const PEP440_PRE_LABELS = ["a", "b", "rc"] as const;

/**
 * Splits a constraint into its comparator and its version.
 *
 * Only the syntax a registry actually writes is accepted: at most one
 * comparator, and then a version. A stacked comparator, a URL, and an
 * arbitrary `name@version` are all rejected rather than read as a
 * version. The protocol and alias prefixes a manifest may use are stripped
 * by the manifest's own parser, so a constraint that reaches here is one
 * version with at most one comparator.
 */
export function parseConstraint(
  _dialect: VersionDialect,
  raw: string,
): ParsedConstraint | undefined {
  let body = raw.trim();
  if (!body) return undefined;
  let comparator: Comparator | undefined;
  for (const candidate of COMPARATORS) {
    if (!body.startsWith(candidate)) continue;
    // A longer comparator that also matches wins, so `~>` is not read as
    // `~`. A longer comparator that does not match is irrelevant, so `>` is
    // not skipped in favour of `>=`.
    if (
      COMPARATORS.some(
        (other) => other !== candidate && other.length > candidate.length && body.startsWith(other),
      )
    )
      continue;
    comparator = candidate;
    body = body.slice(candidate.length).trim();
    break;
  }
  if (!body) return undefined;
  // A second comparator means the constraint is not one this grammar reads.
  if (COMPARATORS.some((candidate) => body.startsWith(candidate))) return undefined;
  return { ...(comparator ? { comparator } : {}), version: body };
}

/**
 * The major version suffix a Go module path names.
 *
 * A Go module's major version lives in its path: `example.com/m/v2` is the
 * second major of `example.com/m`. The path is authoritative, so it sets
 * the major of the comparison representative.
 *
 * The suffix is returned as it is written, because a major that is not an
 * exact integer cannot be compared at all: the version is unresolved rather
 * than guessed at.
 */
export function goModuleMajorSuffix(modulePath: string | undefined): string | undefined {
  if (!modulePath) return undefined;
  const match = /\/v(\d+)$/.exec(modulePath);
  return match?.[1];
}

/**
 * Extracts a comparable version from a constraint.
 *
 * Only a constraint with a single lower bound has one. A wildcard, a
 * compound range, a native bracket range, and a dynamic value do not, and
 * are reported as unresolved rather than guessed at.
 *
 * The module path is the entry's own, and it matters to the Go dialect: a
 * `/vN` suffix sets the major of the comparison representative, because the
 * path is where a Go module keeps its major version. The raw constraint is
 * never rewritten — only the representative is.
 */
export function parseVersion(
  dialect: VersionDialect,
  raw: string,
  modulePath?: string,
): ParsedVersion | undefined {
  const constraint = parseConstraint(dialect, raw);
  if (!constraint) return undefined;
  const version = parseVersionText(dialect, constraint.version);
  if (!version) return undefined;
  let major: number | undefined;
  if (dialect === "go") {
    const suffix = goModuleMajorSuffix(modulePath);
    if (suffix !== undefined) {
      const value = Number(suffix);
      // A major beyond the exact range would be rounded, and a rounded
      // major compares as equal to a different one.
      if (!Number.isSafeInteger(value)) return undefined;
      major = value;
    }
  }
  // The path sets the major, and the rest of the version is the text's.
  const parsed = major === undefined ? version : { ...version, major };
  // An exclusive lower bound excludes the version it names, which is
  // recorded but does not by itself make two constraints differ.
  return constraint.comparator === ">" ? { ...parsed, exclusive: true } : parsed;
}

function parseVersionText(dialect: VersionDialect, raw: string): ParsedVersion | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  // A wildcard is never a version.
  if (text.includes("*")) return undefined;
  // A `v` prefix is a tag convention, not part of the version. PEP 440 has
  // no such prefix, so it is only stripped where a tag would carry one.
  const body = dialect === "pep440" ? text : text.replace(/^v(?=\d)/, "");
  if (dialect === "pep440") return parsePep440(body);
  if (dialect === "maven" || dialect === "tool") {
    const match = NUMERIC_VERSION.exec(body);
    if (!match) return undefined;
    return numericVersion(dialect, match);
  }
  const match = SEMVER_VERSION.exec(body);
  if (!match) return undefined;
  const version = semverVersion(dialect, match);
  return version;
}

/**
 * Compares two unsigned integers written as digit strings.
 *
 * A version number may be longer than a JavaScript safe integer, so the
 * digits are compared by length and then by value, never by `Number`.
 */
export function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A numeric identifier must have no leading zero. */
function isCanonicalNumber(digits: string): boolean {
  return digits.length === 1 || !digits.startsWith("0");
}

/** A release component must be an exact integer. */
function releaseComponent(digits: string | undefined): number | undefined {
  if (digits === undefined) return 0;
  const value = Number(digits);
  // A component beyond the exact range would be rounded, and a rounded
  // version compares as equal to a different one.
  return Number.isSafeInteger(value) ? value : undefined;
}

function numericVersion(
  dialect: VersionDialect,
  match: RegExpExecArray,
): ParsedVersion | undefined {
  const major = releaseComponent(match[1]);
  const minor = releaseComponent(match[2]);
  const patch = releaseComponent(match[3]);
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const components = (match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1) as 1 | 2 | 3;
  return {
    dialect,
    epoch: 0,
    major,
    minor,
    patch,
    components,
    exclusive: false,
  };
}

function semverVersion(dialect: VersionDialect, match: RegExpExecArray): ParsedVersion | undefined {
  const base = numericVersion(dialect, match);
  if (!base) return undefined;
  const pre = match[4];
  const build = match[5];
  // A release component may not carry a leading zero.
  for (const digits of [match[1], match[2], match[3]]) {
    if (digits !== undefined && !isCanonicalNumber(digits)) return undefined;
  }
  if (pre !== undefined && !isValidSemverIdentifiers(pre, true)) return undefined;
  if (build !== undefined && !isValidSemverIdentifiers(build, false)) return undefined;
  return {
    ...base,
    ...(pre === undefined ? {} : { pre: { label: pre, text: pre } satisfies Qualifier }),
    ...(build === undefined ? {} : { build }),
  };
}

/**
 * Semver identifiers are dot-separated and never empty.
 *
 * A purely numeric **pre-release** identifier may not carry a leading
 * zero. Build metadata has no such rule, so a numeric build identifier
 * with a leading zero is valid.
 */
function isValidSemverIdentifiers(text: string, preRelease: boolean): boolean {
  return text.split(".").every((identifier) => {
    if (identifier.length === 0) return false;
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    if (!preRelease) return true;
    if (/^\d+$/.test(identifier)) return isCanonicalNumber(identifier);
    return true;
  });
}

function parsePep440(raw: string): ParsedVersion | undefined {
  const match = PEP440_VERSION.exec(raw);
  if (!match) return undefined;
  const [, epoch, major, minor, patch, preLabel, preNumber, post, dev, local] = match;
  // Every numeric component must be an exact integer, as in the semver
  // dialect: a component beyond the exact range would be rounded, and a
  // rounded version compares as equal to a different one.
  const epochValue = releaseComponent(epoch);
  const majorValue = releaseComponent(major);
  const minorValue = releaseComponent(minor);
  const patchValue = releaseComponent(patch);
  if (epochValue === undefined || majorValue === undefined) return undefined;
  if (minorValue === undefined || patchValue === undefined) return undefined;
  const components = (patch !== undefined ? 3 : minor !== undefined ? 2 : 1) as 1 | 2 | 3;
  const normalizedPre = preLabel === undefined ? undefined : normalizePep440PreLabel(preLabel);
  const base = {
    dialect: "pep440" as const,
    epoch: epochValue,
    major: majorValue,
    minor: minorValue,
    patch: patchValue,
    components,
    exclusive: false,
  };
  const localSegments = local === undefined ? undefined : parseLocalSegments(local);
  if (local !== undefined && !localSegments) return undefined;
  // A suffix number beyond the exact range is not comparable.
  for (const digits of [preNumber, post, dev]) {
    if (digits === undefined || digits === "") continue;
    if (releaseComponent(digits) === undefined) return undefined;
  }
  return {
    ...base,
    ...(normalizedPre === undefined
      ? {}
      : {
          pre: {
            label: normalizedPre,
            ...(preNumber === undefined || preNumber === "" ? {} : { number: Number(preNumber) }),
            text: `${normalizedPre}${preNumber ?? ""}`,
          } satisfies Qualifier,
        }),
    ...(post === undefined
      ? {}
      : {
          post: {
            label: "post",
            ...(post === "" ? {} : { number: Number(post) }),
            text: `post${post}`,
          } satisfies Qualifier,
        }),
    ...(dev === undefined
      ? {}
      : {
          dev: {
            label: "dev",
            ...(dev === "" ? {} : { number: Number(dev) }),
            text: `dev${dev}`,
          } satisfies Qualifier,
        }),
    ...(localSegments === undefined ? {} : { local: localSegments }),
  };
}

function normalizePep440PreLabel(label: string): string {
  if (label === "a" || label === "alpha") return "a";
  if (label === "b" || label === "beta") return "b";
  return "rc";
}

/** A local version label is dot-separated segments, each numeric or text. */
function parseLocalSegments(label: string): LocalSegment[] | undefined {
  if (!/^[A-Za-z0-9.]+$/.test(label)) return undefined;
  const segments = label.split(".");
  const parsed: LocalSegment[] = [];
  for (const segment of segments) {
    if (segment.length === 0) return undefined;
    if (/^\d+$/.test(segment)) {
      parsed.push({ numeric: true, digits: segment.replace(/^0+(?=\d)/, "") });
      continue;
    }
    parsed.push({ numeric: false, text: segment.toLowerCase() });
  }
  return parsed;
}

/**
 * Orders two semver qualifiers by their identifiers: numeric identifiers
 * compare numerically and rank below alphanumeric ones, and a shorter list
 * ranks below a longer one that starts with it.
 */
function compareSemverQualifiers(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (oneNumeric && twoNumeric) {
      const difference = compareDigits(one, two);
      if (difference !== 0) return difference;
      continue;
    }
    if (oneNumeric !== twoNumeric) return oneNumeric ? -1 : 1;
    if (one !== two) return one < two ? -1 : 1;
  }
  return 0;
}

/**
 * The level a PEP 440 version sits at, and the values that order versions
 * within the level.
 *
 * Within a release segment, PEP 440 orders the suffixes as `.devN`, `aN`,
 * `bN`, `rcN`, no suffix, `.postN`, and a development release of a
 * pre-release or a post-release sorts immediately before the release it
 * belongs to.
 */
interface Pep440Level {
  /** Which part of the release segment the version sits in. */
  level: number;
  /** The pre-release label rank, or the post-release number. */
  a: number;
  /** The pre-release number. */
  b: number;
  /** The stage within the pre-release group, or the post-release stage. */
  c: number;
  /** The post-release number. */
  d: number;
  /** The development-release number. */
  e: number;
}

/**
 * The stages within the pre-release group.
 *
 * A pre-release's own development release sorts before it, and the
 * development release of its post-release sorts between it and that
 * post-release.
 */
const PEP440_PRE_STAGE = {
  devOfPre: 0,
  pre: 1,
  devOfPost: 2,
  post: 3,
} as const;

function pep440Level(version: ParsedVersion): Pep440Level {
  const devNumber = version.dev?.number ?? 0;
  if (version.pre !== undefined) {
    const label = PEP440_PRE_LABELS.indexOf(
      version.pre.label as (typeof PEP440_PRE_LABELS)[number],
    );
    const rank = label < 0 ? PEP440_PRE_LABELS.length : label;
    const number = version.pre.number ?? 0;
    if (version.post !== undefined) {
      // The development release belongs to the post-release, which is the
      // last segment present.
      return {
        level: 1,
        a: rank,
        b: number,
        c: version.post.number ?? 0,
        d: version.dev === undefined ? PEP440_PRE_STAGE.post : PEP440_PRE_STAGE.devOfPost,
        e: devNumber,
      };
    }
    return {
      level: 1,
      a: rank,
      b: number,
      c: 0,
      d: version.dev === undefined ? PEP440_PRE_STAGE.pre : PEP440_PRE_STAGE.devOfPre,
      e: devNumber,
    };
  }
  if (version.post !== undefined) {
    return {
      level: 3,
      a: version.post.number ?? 0,
      b: 0,
      c: version.dev === undefined ? 1 : 0,
      d: 0,
      e: devNumber,
    };
  }
  if (version.dev !== undefined) return { level: 0, a: 0, b: 0, c: 0, d: 0, e: devNumber };
  return { level: 2, a: 0, b: 0, c: 0, d: 0, e: 0 };
}

/** Compares two local version labels, segment by segment. */
function compareLocal(a: LocalSegment[], b: LocalSegment[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const one = a[index];
    const two = b[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one.numeric !== two.numeric) return one.numeric ? 1 : -1;
    if (one.numeric) {
      const difference = compareDigits(one.digits ?? "", two.digits ?? "");
      if (difference !== 0) return difference;
      continue;
    }
    if (one.text !== two.text) return (one.text ?? "") < (two.text ?? "") ? -1 : 1;
  }
  return 0;
}

/** Orders the qualifiers of two versions in the dialect's own terms. */
function compareQualifiers(a: ParsedVersion, b: ParsedVersion): number {
  if (a.dialect === "semver" || a.dialect === "go") {
    // A pre-release orders below the final release, and two pre-releases
    // are compared by their identifiers.
    if (a.pre === undefined && b.pre === undefined) return 0;
    if (a.pre === undefined) return 1;
    if (b.pre === undefined) return -1;
    return compareSemverQualifiers(a.pre.text, b.pre.text);
  }
  const one = pep440Level(a);
  const two = pep440Level(b);
  if (one.level !== two.level) return one.level < two.level ? -1 : 1;
  if (one.a !== two.a) return one.a < two.a ? -1 : 1;
  if (one.b !== two.b) return one.b < two.b ? -1 : 1;
  if (one.c !== two.c) return one.c < two.c ? -1 : 1;
  if (one.d !== two.d) return one.d < two.d ? -1 : 1;
  if (one.e !== two.e) return one.e < two.e ? -1 : 1;
  const aLocal = a.local ?? [];
  const bLocal = b.local ?? [];
  if (aLocal.length === 0 && bLocal.length === 0) return 0;
  if (aLocal.length === 0) return -1;
  if (bLocal.length === 0) return 1;
  return compareLocal(aLocal, bLocal);
}

/**
 * Orders two versions. The release tuple comes first, then the qualifier,
 * which orders below or above the final release according to its dialect.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return compareQualifiers(a, b);
}

/**
 * Renders the comparison representative: the version as it was written.
 *
 * The representative is not a published version — a two-component `1.2` may
 * have no `1.2.0` release — so it is never used as an endpoint path. It
 * keeps the release components, the epoch, and the qualifiers, because
 * those are what make two representatives comparable.
 */
export function formatVersion(version: ParsedVersion): string {
  const release =
    version.components === 3
      ? `${version.major}.${version.minor}.${version.patch}`
      : version.components === 2
        ? `${version.major}.${version.minor}`
        : `${version.major}`;
  const epoch = version.epoch > 0 ? `${version.epoch}!` : "";
  if (version.dialect === "semver" || version.dialect === "go") {
    const pre = version.pre ? `-${version.pre.text}` : "";
    const build = version.build ? `+${version.build}` : "";
    return `${epoch}${release}${pre}${build}`;
  }
  const pre = version.pre ? version.pre.text : "";
  const post = version.post ? `.${version.post.text}` : "";
  const dev = version.dev ? `.${version.dev.text}` : "";
  const local = version.local
    ? `+${version.local.map((segment) => segment.digits ?? segment.text).join(".")}`
    : "";
  return `${epoch}${release}${pre}${post}${dev}${local}`;
}

/** The module paths two entries carry, when the dialect reads them. */
export interface ModulePaths {
  /** The path of the entry the change starts at. */
  from?: string;
  /** The path of the entry the change ends at. */
  to?: string;
}

/** How a constraint change was classified. */
export interface VersionChange {
  kind: VersionChangeKind;
  /** The comparison representative on the side that has one. */
  fromVersion?: string;
  toVersion?: string;
}

/**
 * Classifies a constraint change.
 *
 * A descending change is a downgrade, not an upgrade. A change that cannot
 * be compared is unresolved, never a silent patch.
 *
 * `undefined` means the version did not change: the two constraints name
 * the same version, so there is no version change to report. The
 * exclusivity is what makes that visible — `>1.2.3` and `>=1.2.3` are the
 * same version, and the bound that changed is not the version.
 *
 * The module paths are the entries' own, and they matter to the Go dialect:
 * a `/vN` suffix sets the major of the comparison representative.
 */
export function classifyVersionChange(
  dialect: VersionDialect,
  from: string | undefined,
  to: string | undefined,
  modulePaths?: ModulePaths,
): VersionChange | undefined {
  if (from === undefined || to === undefined) return { kind: "unresolved" };
  const before = parseVersion(dialect, from, modulePaths?.from);
  const after = parseVersion(dialect, to, modulePaths?.to);
  if (!before || !after) return { kind: "unresolved" };
  const fromVersion = formatVersion(before);
  const toVersion = formatVersion(after);
  if (fromVersion === toVersion) return undefined;
  const order = compareVersions(before, after);
  if (order === 0) return { kind: "patch", fromVersion, toVersion };
  if (order > 0) return { kind: "downgrade", fromVersion, toVersion };
  if (after.epoch !== before.epoch) return { kind: "major", fromVersion, toVersion };
  if (after.major !== before.major) return { kind: "major", fromVersion, toVersion };
  if (after.major === 0 && after.minor !== before.minor)
    return { kind: "pre-1.0-minor", fromVersion, toVersion };
  if (after.minor !== before.minor) return { kind: "minor", fromVersion, toVersion };
  return { kind: "patch", fromVersion, toVersion };
}
