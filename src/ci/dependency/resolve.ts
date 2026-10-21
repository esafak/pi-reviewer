import { createHash } from "node:crypto";

import type { DependencyChange } from "../../core/dependency/types.js";
import { fetchPackageSource } from "../registry/source.js";
import { isGitHubRepository } from "../github-research/repository.js";
import { prepareResearch, type ReaderCapabilities } from "../research-preparation.js";
import { checkUrlAdmissibility } from "../web-fetch/admissibility.js";
import { findMirror } from "./mirrors.js";
import { findToolSource } from "./tool-sources.js";

/** What a candidate is and how it was found. */
export interface UpstreamCandidateBase {
  /** The candidate id the model cites when it reports where it read the notes. */
  id: string;
  /** How the candidate was found, for the report and the prompt. */
  via: "registry-metadata" | "manifest" | "tool-table" | "mirror";
  /** The specific source within the location, when known. */
  path?: string;
}

/**
 * A location the model can open.
 *
 * The union requires at least one location, so a candidate with neither
 * cannot be written. The `repo` is what the model reads with `github_read`;
 * the `url` is what it reads with the bounded URL reader. A candidate may
 * carry both, in which case either reader opens it.
 */
export type UpstreamCandidate =
  | (UpstreamCandidateBase & { repo: string; url?: string })
  | (UpstreamCandidateBase & { repo?: undefined; url: string });

/** The upstream locations the harness resolved for one upgrade. */
export interface UpstreamResolution {
  /** The harness-assigned upgrade id this resolution belongs to. */
  id: string;
  /** The candidate locations, best first. Empty when unresolved. */
  candidates: UpstreamCandidate[];
  /** Why no candidate was found, when there is none. */
  unresolved?: string;
}

/**
 * What the model reported about one upgrade.
 *
 * `source` names where the release notes were read — a candidate id from the
 * `<dependency_changes>` section, or a repository-relative path in the
 * checkout. `reason` says why the breaking changes could not be determined.
 */
export type UpgradeResearch =
  | { id: string; status: "researched"; source: string }
  | { id: string; status: "unverified"; reason: string };

/** The limits the resolver spends its lookups under. */
export interface ResolveOptions {
  /** The maximum number of registry requests the resolver may make. */
  maxRequests?: number;
  /** The resolver's wall-clock budget, in milliseconds. */
  wallMs?: number;
  /** The maximum number of lookups in flight at once. */
  maxConcurrency?: number;
  /** The clock the budget reads. */
  now?: () => number;
}

const DEFAULT_MAX_REQUESTS = 24;
const DEFAULT_WALL_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;

/** The GitHub hosts a repository name may be read from. */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * The schemes a GitHub source may be written with.
 *
 * A remote is written with one of these; anything else — a `file:` path, a
 * `mailto:` — names no repository, whatever else it mentions.
 */
const GITHUB_SOURCE_PROTOCOLS = new Set(["https:", "http:", "git+https:", "ssh:"]);

/**
 * Strips the spelling a remote is written with.
 *
 * A trailing slash and a `.git` suffix are spelling, not identity, and
 * either may come last: `owner/repo.git/` is the same remote as
 * `owner/repo`.
 */
function trimRemote(raw: string): string {
  let value = raw.trim();
  while (value.endsWith("/")) value = value.slice(0, -1);
  while (value.endsWith(".git")) value = value.slice(0, -".git".length);
  return value;
}

/**
 * The repository part of a name, without the suffix a remote carries.
 *
 * The suffix belongs to the repository and to nothing else: a file inside a
 * repository may end in `.git` and keeps its name.
 */
function repositoryPart(part: string): string | undefined {
  let value = part;
  while (value.endsWith(".git")) value = value.slice(0, -".git".length);
  return value.length ? value : undefined;
}

/**
 * The `owner/repo` shape of a repository, without the suffix a remote
 * carries.
 *
 * The name is validated after the suffix is removed, because removing it can
 * leave nothing: `owner/.git` is not a repository. The name is held to the
 * contract the research tool accepts, so a candidate the reader would refuse
 * is never offered.
 */
function normalizeRepository(value: string): string | undefined {
  const [owner, name] = value.split("/");
  if (!owner || !name) return undefined;
  const part = repositoryPart(name);
  if (!part || !isGitHubRepository(owner, part)) return undefined;
  return `${owner}/${part}`;
}

/**
 * The file path a GitHub URL names.
 *
 * The path is decoded, because the reader asks for it by name, and a decoded
 * path is checked: an escape that stands for a separator names another
 * file, and a `..` segment names a file outside the repository.
 */
function repositoryPath(segments: readonly string[]): string | undefined {
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (!value.length || value === "." || value === "..") return undefined;
    if (value.includes("/")) return undefined;
    decoded.push(value);
  }
  return decoded.length ? decoded.join("/") : undefined;
}

/** A repository a source names. */
interface GitHubRepository {
  /** The repository, in the `owner/repo` shape. */
  repo: string;
  /** The path within the repository, when the source names one. */
  path?: string;
}

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

/** The run-scoped budget the resolver spends its lookups under. */
interface Budget {
  readonly signal: AbortSignal;
  charge(): void;
}

function createBudget(options: ResolveOptions): Budget {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const wallMs = options.wallMs ?? DEFAULT_WALL_MS;
  const now = options.now ?? (() => Date.now());
  const started = now();
  let requests = 0;
  return {
    signal: AbortSignal.timeout(wallMs),
    charge() {
      if (requests >= maxRequests) throw new Error("the upstream lookup budget is exhausted");
      if (now() - started >= wallMs)
        throw new Error("the upstream lookup time budget is exhausted");
      requests += 1;
    },
  };
}

/** A location, before it is given an id. */
interface Location {
  repo?: string;
  url?: string;
  path?: string;
}

/**
 * The repository a source names, when it names one on GitHub.
 *
 * The spellings a package author writes are all read: a URL, a `git+` URL, a
 * scp-style remote, and the `github:` shorthand. The repository is returned
 * in the `owner/repo` shape the research tool takes.
 *
 * Only the schemes a remote is written with are read, and the repository is
 * held to the shape GitHub gives a repository: a source that names something
 * else — a `file:` path that happens to mention the host, a path with an
 * escape in it — names no repository.
 */
function githubRepository(raw: string): GitHubRepository | undefined {
  const value = raw.trim();
  if (!value.length) return undefined;
  const shorthand = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  if (shorthand) {
    const repo = normalizeRepository(shorthand[1]!);
    return repo ? { repo } : undefined;
  }
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(value);
  if (scp && GITHUB_HOSTS.has(scp[1]!.toLowerCase())) {
    const repo = normalizeRepository(scp[2]!);
    return repo ? { repo } : undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!GITHUB_SOURCE_PROTOCOLS.has(url.protocol)) return undefined;
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const owner = segments[0]!;
  const name = repositoryPart(segments[1]!);
  if (!name || !isGitHubRepository(owner, name)) return undefined;
  const repo = `${owner}/${name}`;
  // A URL that names a file in the repository also names the file. The
  // reference is part of the URL's shape, not part of the path, and the path
  // is the file's name as the reader will ask for it.
  const kind = segments[2];
  const path =
    kind === "blob" || kind === "raw" || kind === "tree"
      ? repositoryPath(segments.slice(4))
      : undefined;
  return path ? { repo, path } : { repo };
}

/**
 * The `owner/repo` shape of a repository the harness knows.
 *
 * The mirror table writes a repository the way it is named at its source —
 * `github.com/owner/repo` — and the shape the research tool takes is
 * `owner/repo`.
 */
function githubSlug(value: string): string | undefined {
  const trimmed = trimRemote(value);
  if (!trimmed.length) return undefined;
  const withoutHost = trimmed.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  const [owner, name] = withoutHost.split("/");
  if (!owner || !name || !isGitHubRepository(owner, name)) return undefined;
  return `${owner}/${name}`;
}

/**
 * The location a raw source names.
 *
 * A GitHub URL becomes a repository the research tool can open, and carries
 * the URL as well so either reader opens it. Any other web URL becomes a URL
 * candidate, and the reader's own rules decide whether it may be opened. A
 * source that names no location at all — a `mailto:`, a `git://` remote, a
 * `file:` path — is not a location the model can open.
 *
 * A GitHub URL that names no repository names nothing the model can read:
 * the shape of a repository is what GitHub itself allows, so a URL outside
 * it names no project.
 */
function classifyLocation(raw: string): Location | undefined {
  const value = raw.trim();
  if (!value.length) return undefined;
  const repository = githubRepository(value);
  if (repository) {
    return {
      repo: repository.repo,
      url: `https://github.com/${repository.repo}`,
      ...(repository.path ? { path: repository.path } : {}),
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (GITHUB_HOSTS.has(url.hostname.toLowerCase())) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const path = url.pathname === "/" ? "" : url.pathname;
  return { url: value, ...(path.length ? { path } : {}) };
}

/** The registries whose packages are described by a package registry. */
const REGISTRY_BACKED = new Set([
  "npm",
  "pypi",
  "crates",
  "go",
  "maven",
  "nuget",
  "rubygems",
  "packagist",
]);

/**
 * The repository a manifest names, in the `owner/repo` shape.
 *
 * A manifest writes the repository with its reference and sometimes with a
 * subpath: `owner/repo@v4` and `owner/repo/path/to/action`. Neither is part
 * of the repository's identity.
 */
function manifestRepository(name: string): string | undefined {
  const trimmed = name.trim().replace(/^github:/, "");
  const withoutRef =
    trimmed.includes("@") && !trimmed.startsWith("@")
      ? trimmed.slice(0, trimmed.lastIndexOf("@"))
      : trimmed;
  const segments = withoutRef.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  return githubSlug(`${segments[0]}/${segments[1]}`);
}

/** Whether a candidate can be opened, and why it cannot. */
export interface CandidateUsability {
  /** The candidate can be opened by one of the run's readers. */
  usable: boolean;
  /** Why no reader can open it. */
  reason?: string;
}

/** Whether a candidate can be opened by the readers this run has. */
function usability(candidate: UpstreamCandidate, readers: ReaderCapabilities): CandidateUsability {
  const reasons: string[] = [];
  if (candidate.repo) {
    if (readers.github) return { usable: true };
    reasons.push("the GitHub research tools are not available");
  }
  if (candidate.url) {
    if (!readers.url) {
      reasons.push("the URL reader is not available");
    } else {
      const check = checkUrlAdmissibility(candidate.url);
      if (check.ok) return { usable: true };
      reasons.push(check.reason);
    }
  }
  if (!reasons.length) reasons.push("the location names no readable target");
  return { usable: false, reason: reasons.join("; ") };
}

/** The source the registry reported for a package, cached by its identity. */
interface SourceEntry {
  locations: readonly string[];
  reason?: string;
}

/**
 * Resolves the candidate upstream locations for every qualifying upgrade.
 *
 * The harness resolves a **candidate list**, not a single answer: the
 * candidates come from registry metadata or from the manifest, never from
 * matching a package name against a search index, and the model confirms a
 * candidate actually publishes the package before trusting its notes.
 *
 * The lookup asks for the package's **current** metadata rather than for the
 * upgrade's target version. A package's upstream rarely changes between
 * releases, and the comparison representative the comparison used is never
 * used as a path segment: a version that was never published is not a
 * document.
 *
 * A failing or unattempted lookup is coverage, never a run failure.
 *
 * The readers default to the shared preparation's answer, so the tools this
 * run registers and the locations the resolver offers cannot disagree.
 */
export async function resolveUpstreams(
  changes: readonly DependencyChange[],
  upgrades: readonly string[],
  readers: ReaderCapabilities = prepareResearch().readers,
  options: ResolveOptions = {},
): Promise<UpstreamResolution[]> {
  const budget = createBudget(options);
  const byId = new Map(changes.map((change) => [upgradeId(change), change]));
  // The cache holds the pending lookup rather than its result, so two
  // manifests that pin the same package cost one request even when they are
  // resolved at the same time.
  const cache = new Map<string, Promise<SourceEntry>>();

  const sourceFor = async (change: DependencyChange): Promise<SourceEntry> => {
    const packageName = change.resolvedName ?? change.name;
    const key = `${change.registry} ${packageName}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = (async (): Promise<SourceEntry> => {
      try {
        const source = await fetchPackageSource(change.registry, packageName, {
          signal: budget.signal,
          charge: () => budget.charge(),
        });
        return {
          locations: source.locations,
          ...(source.reason ? { reason: source.reason } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "the lookup failed";
        return { locations: [], reason: message };
      }
    })();
    cache.set(key, pending);
    return pending;
  };

  const resolveOne = async (id: string): Promise<UpstreamResolution> => {
    const change = byId.get(id);
    if (!change) return { id, candidates: [], unresolved: "the upgrade has no detected change" };
    const packageName = change.resolvedName ?? change.name;
    const locations: Location[] = [];
    let reason: string | undefined;
    let via: UpstreamCandidate["via"] = "registry-metadata";

    if (change.registry === "github") {
      // The manifest names the repository outright, so no lookup is needed.
      via = "manifest";
      const repo = manifestRepository(packageName);
      if (repo) locations.push({ repo, url: `https://github.com/${repo}` });
      else reason = "the manifest does not name a GitHub repository";
    } else if (change.registry === "aqua") {
      // The aqua registry describes its own recipes, and a recipe is not a
      // repository: the tool table names the tools it knows, and the harness
      // never substitutes a different project for one it could not identify.
      reason = "the aqua registry describes a recipe, and no repository publishes it";
    } else if (!REGISTRY_BACKED.has(change.registry)) {
      // A tool pin that no registry describes is answered by the tool table.
      via = "tool-table";
      const repository = findToolSource(packageName);
      const slug = repository ? githubSlug(repository) : undefined;
      if (slug) locations.push({ repo: slug, url: `https://github.com/${slug}` });
      else reason = "no registry describes this tool and the tool table does not cover it";
    } else {
      const mirror = findMirror(change.registry, packageName);
      const mirrorSlug = mirror ? githubSlug(mirror) : undefined;
      if (mirrorSlug) {
        via = "mirror";
        locations.push({ repo: mirrorSlug, url: `https://github.com/${mirrorSlug}` });
      } else {
        const source = await sourceFor(change);
        reason = source.reason;
        for (const raw of source.locations) {
          const location = classifyLocation(raw);
          if (location) locations.push(location);
          else reason ??= `the registry reported a source the model cannot open: ${raw}`;
        }
      }
    }

    // The same location twice is one candidate, and the more specific of the
    // two spellings carries the path.
    const byKey = new Map<string, Location>();
    for (const location of locations) {
      const key = location.repo ? `repo:${location.repo}` : `url:${location.url}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.path && location.path) existing.path = location.path;
        continue;
      }
      byKey.set(key, location);
    }

    const candidates: UpstreamCandidate[] = [];
    for (const location of byKey.values()) {
      candidates.push({
        id: `${id}-${candidates.length + 1}`,
        via,
        ...(location.path ? { path: location.path } : {}),
        ...(location.repo ? { repo: location.repo } : {}),
        ...(location.url ? { url: location.url } : {}),
      } as UpstreamCandidate);
    }

    const usable = candidates.filter((candidate) => usability(candidate, readers).usable);
    if (usable.length) return { id, candidates: usable };
    const blockers = candidates
      .map((candidate) => {
        const reason = usability(candidate, readers).reason;
        const location = candidate.repo ?? candidate.url;
        return location && reason ? `${location}: ${reason}` : reason;
      })
      .filter((value): value is string => Boolean(value));
    return {
      id,
      candidates: [],
      unresolved: blockers.length
        ? blockers.join("; ")
        : (reason ?? "no upstream location was found"),
    };
  };

  const results: UpstreamResolution[] = Array.from({ length: upgrades.length });
  let next = 0;
  const limit = Math.max(
    1,
    Math.min(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY, upgrades.length),
  );
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const index = next++;
      if (index >= upgrades.length) return;
      const id = upgrades[index]!;
      // One upgrade that cannot be resolved is coverage for that upgrade, not
      // a failure of the resolution.
      results[index] = await resolveOne(id).catch((error: unknown) => ({
        id,
        candidates: [],
        unresolved: error instanceof Error ? error.message : "the resolution failed",
      }));
    }
  });
  await Promise.all(workers);
  return results;
}

/** What the harness accepted from the model's research report. */
export interface ResearchValidation {
  /** The accepted dispositions, one per upgrade id. */
  readonly accepted: readonly UpgradeResearch[];
  /** The entries that were discarded, and why. */
  readonly diagnostics: readonly string[];
  /** The qualifying upgrades that no disposition accounts for. */
  readonly gaps: readonly string[];
}

/** Whether two dispositions agree. */
function sameDisposition(left: UpgradeResearch, right: UpgradeResearch): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "researched" && right.status === "researched")
    return left.source === right.source;
  if (left.status === "unverified" && right.status === "unverified")
    return left.reason === right.reason;
  return false;
}

/**
 * The repository-relative path a local citation names.
 *
 * The path is normalized for publication: relative, no `..` segment, and not
 * an absolute host path. A path that escapes the checkout is rejected rather
 * than normalized, because the harness does not open it.
 *
 * The absolute check reads the path as it was written, before the separators
 * are normalized: a rooted Windows path is absolute, and rewriting it into a
 * relative one would publish a path the model never named.
 */
function normalizeLocalPath(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.length) return undefined;
  if (value.startsWith("/") || value.startsWith("\\")) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(value)) return undefined;
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (!segments.length) return undefined;
  if (segments.some((segment) => segment === "..")) return undefined;
  return segments.join("/");
}

/** The outcome of checking a citation. */
export type CitationCheck = { ok: true; source: string } | { ok: false; reason: string };

/** Whether a citation names a source the harness can stand behind. */
function checkCitation(source: string, candidates: readonly UpstreamCandidate[]): CitationCheck {
  const trimmed = source.trim();
  if (trimmed.startsWith("candidate:")) {
    const candidateId = trimmed.slice("candidate:".length);
    const candidate = candidates.find((entry) => entry.id === candidateId);
    if (!candidate) return { ok: false, reason: "the citation names no candidate of this upgrade" };
    return { ok: true, source: `candidate:${candidate.id}` };
  }
  if (trimmed.startsWith("local:")) {
    const path = normalizeLocalPath(trimmed.slice("local:".length));
    if (!path) return { ok: false, reason: "the citation is not a repository-relative path" };
    return { ok: true, source: `local:${path}` };
  }
  return { ok: false, reason: "the citation is neither a candidate nor a local path" };
}

/** The outcome of checking a disposition. */
export type DispositionCheck = { ok: true; entry: UpgradeResearch } | { ok: false; reason: string };

/**
 * The disposition an entry states, when the harness can stand behind it.
 *
 * An entry that names a source the harness did not resolve is discarded
 * before it is compared with the other entries for the same upgrade.
 */
function checkDisposition(
  entry: UpgradeResearch,
  candidates: readonly UpstreamCandidate[],
): DispositionCheck {
  if (entry.status === "unverified") return { ok: true, entry };
  const check = checkCitation(entry.source, candidates);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, entry: { id: entry.id, status: "researched", source: check.source } };
}

/**
 * Validates the model's research report.
 *
 * The harness validates the report, not the research: it checks that the
 * upgrade id is one of the qualifying upgrades, that a `researched` source is
 * a citation the harness can stand behind, and that no upgrade is reported
 * twice with conflicting dispositions. It cannot verify that the model read
 * the release notes, and the guarantee it publishes says so.
 *
 * An unknown upgrade id is discarded, not honoured: it never satisfies the
 * accounting for a known upgrade, and it never creates a qualifying upgrade
 * that does not exist.
 */
export function validateResearch(
  report: readonly UpgradeResearch[],
  resolutions: readonly UpstreamResolution[],
  upgrades: readonly string[],
): ResearchValidation {
  const known = new Set(upgrades);
  const candidatesByUpgrade = new Map(resolutions.map((entry) => [entry.id, entry.candidates]));
  const accepted = new Map<string, UpgradeResearch>();
  const conflicts = new Set<string>();
  const diagnostics: string[] = [];

  for (const entry of report) {
    if (!known.has(entry.id)) {
      diagnostics.push(`${entry.id}: not one of the qualifying upgrades`);
      continue;
    }
    // An entry is judged on its own merits first. An entry the harness
    // discards is not a disposition, so it cannot conflict with one that is
    // kept, and the outcome does not depend on the order the report lists
    // them in.
    const valid = checkDisposition(entry, candidatesByUpgrade.get(entry.id) ?? []);
    if (!valid.ok) {
      diagnostics.push(`${entry.id}: ${valid.reason}`);
      continue;
    }
    if (conflicts.has(entry.id)) continue;
    const existing = accepted.get(entry.id);
    if (existing) {
      if (sameDisposition(existing, valid.entry)) continue;
      // A conflict is resolved conservatively: the upgrade is not claimed as
      // researched, because two dispositions disagree about it.
      conflicts.add(entry.id);
      accepted.set(entry.id, {
        id: entry.id,
        status: "unverified",
        reason: "the report gave conflicting dispositions for this upgrade",
      });
      diagnostics.push(`${entry.id}: the report gave conflicting dispositions`);
      continue;
    }
    accepted.set(entry.id, valid.entry);
  }

  return {
    accepted: [...accepted.values()],
    diagnostics,
    gaps: upgrades.filter((id) => !accepted.has(id)),
  };
}
