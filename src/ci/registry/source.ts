import { findChild, readXmlDocument } from "../../core/dependency/xml.js";
import type { PackageRegistry } from "../../core/dependency/types.js";
import { isRecord, requestJson, requestTextFollowingHosts } from "./helpers.js";
import {
  encodeGoModulePath,
  npmPath,
  projectCrate,
  projectGo,
  projectMaven,
  projectNpm,
  projectPyPI,
} from "./providers.js";

/**
 * The run-scoped budget a source lookup spends under.
 *
 * The lookup has its own context rather than the model-facing registry
 * client's: that client's lookup budget, result budgets, and clock start
 * when it is constructed, so sharing one would let the model's lookups
 * consume the resolver's budget and the other way round.
 */
export interface SourceRequest {
  /** The signal that bounds the requests. */
  readonly signal: AbortSignal;
  /** Charges one request against the run's budget. */
  charge(): void;
}

/** What a registry reported about a package's upstream. */
export interface PackageSourceResult {
  /** The upstream locations the registry reported, most specific first. */
  readonly locations: readonly string[];
  /** Why the registry reported no location. */
  readonly reason?: string;
}

const MAVEN_CENTRAL_HOSTS = ["search.maven.org", "repo1.maven.org", "repo.maven.apache.org"];

const CRATES_USER_AGENT = "pi-reviewer (https://github.com/esafak/pi-reviewer)";

/** The first string in a list of values, when there is one. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim().length) return value;
  return undefined;
}

/**
 * npm's upstream.
 *
 * The lookup asks for the package's **current** version document rather than
 * the upgrade's target version: the abbreviated packument omits the
 * repository and the homepage, and the version document carries them. The
 * comparison representative from the detector is never used as a path
 * segment, because a version that was never published is not a document.
 */
async function npmSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  request.charge();
  const raw = await requestJson(
    new URL(`https://registry.npmjs.org/${npmPath(name)}/latest`),
    request.signal,
    { accept: "application/json" },
  );
  const projected = projectNpm(raw, true);
  const repository = firstString(projected.repository);
  const homepage = firstString(projected.homepage);
  const locations = [repository, homepage].filter((value): value is string => Boolean(value));
  return locations.length
    ? { locations }
    : { locations: [], reason: "npm reports no repository or homepage" };
}

/** PyPI's upstream, from the project's own URL list. */
async function pypiSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  request.charge();
  const raw = await requestJson(
    new URL(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`),
    request.signal,
  );
  const projected = projectPyPI(raw);
  const info = projected.info;
  const urls = isRecord(info) ? info.project_urls : undefined;
  if (!isRecord(urls)) return { locations: [], reason: "PyPI reports no project URLs" };
  const entries = Object.entries(urls).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  // The labels the registries use for the source come first, then the
  // homepage, then everything else.
  const rank = (label: string): number => {
    if (/^(source|source code|repository|code|github)$/i.test(label)) return 0;
    if (/^homepage$/i.test(label)) return 1;
    if (/^(documentation|changelog)$/i.test(label)) return 2;
    return 3;
  };
  entries.sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right));
  const locations = entries.map(([, url]) => url);
  return locations.length
    ? { locations }
    : { locations: [], reason: "PyPI reports no project URLs" };
}

/** crates.io's upstream. */
async function cratesSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  request.charge();
  const raw = await requestJson(
    new URL(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`),
    request.signal,
    { "user-agent": CRATES_USER_AGENT },
  );
  const projected = projectCrate(raw);
  const crate = projected.crate;
  const repository = isRecord(crate) ? firstString(crate.repository) : undefined;
  const homepage = isRecord(crate) ? firstString(crate.homepage) : undefined;
  const locations = [repository, homepage].filter((value): value is string => Boolean(value));
  return locations.length
    ? { locations }
    : { locations: [], reason: "crates.io reports no repository or homepage" };
}

/**
 * The Go module proxy's upstream.
 *
 * The proxy reports the version-control origin of the module, whose URL is
 * the source. The `VCS` field beside it names the version-control system and
 * is not a location.
 */
async function goSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  request.charge();
  const raw = await requestJson(
    new URL(`https://proxy.golang.org/${encodeGoModulePath(name)}/@latest`),
    request.signal,
  );
  const projected = projectGo(raw);
  const origin = projected.Origin;
  const url = isRecord(origin) ? firstString(origin.URL) : undefined;
  return url
    ? { locations: [url] }
    : { locations: [], reason: "the module proxy reports no origin" };
}

/**
 * Maven Central's upstream, from the artifact's own POM.
 *
 * The POM is fetched for the artifact's **current** published version, which
 * the search projection exposes as `latestVersion` — never for the upgrade's
 * target version, and never for a comparison representative, because a
 * version that was never published is not a coordinate a POM can be fetched
 * for.
 *
 * The `scm` and `organization` URLs are often inherited from a parent POM, so
 * a POM that does not carry them yields no candidate rather than an inherited
 * guess.
 */
async function mavenSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  const coordinate = name.split(":");
  if (coordinate.length !== 2 || coordinate.some((part) => !part))
    return { locations: [], reason: "the Maven coordinate is not group:artifact" };
  const [group, artifact] = coordinate as [string, string];
  request.charge();
  const url = new URL("https://search.maven.org/solrsearch/select");
  url.searchParams.set("q", `g:${group} AND a:${artifact}`);
  url.searchParams.set("rows", "5");
  url.searchParams.set("wt", "json");
  const projected = projectMaven(await requestJson(url, request.signal));
  const response = projected.response;
  const docs = isRecord(response) && Array.isArray(response.docs) ? response.docs : [];
  const latest = docs
    .map((doc) => (isRecord(doc) ? firstString(doc.latestVersion) : undefined))
    .find((version): version is string => Boolean(version));
  if (!latest) return { locations: [], reason: "Maven Central reports no published version" };
  const path = `${group.replace(/\./g, "/")}/${artifact}/${latest}/${artifact}-${latest}.pom`;
  const pomUrl = new URL("https://search.maven.org/remotecontent");
  pomUrl.searchParams.set("filepath", path);
  // Every hop is charged to the run's request budget, so a redirect chain
  // cannot spend more requests than the budget allows.
  const pom = await requestTextFollowingHosts(pomUrl, request.signal, MAVEN_CENTRAL_HOSTS, () =>
    request.charge(),
  );
  const document = readXmlDocument(pom);
  if (document.error || !document.root)
    return { locations: [], reason: "the POM could not be read" };
  const scm = findChild(document.root, "scm");
  const scmUrl = scm ? firstString(findChild(scm, "url")?.text) : undefined;
  const organization = findChild(document.root, "organization");
  const organizationUrl = organization
    ? firstString(findChild(organization, "url")?.text)
    : undefined;
  const locations = [scmUrl, organizationUrl].filter((value): value is string => Boolean(value));
  return locations.length
    ? { locations }
    : { locations: [], reason: "the POM carries no source URL" };
}

/** The registration leaf for the newest stable version of a package. */
function pickLeaf(leaves: readonly unknown[]): Record<string, unknown> | undefined {
  const entries = leaves.filter(isRecord);
  const version = (leaf: Record<string, unknown>): string => {
    const entry = leaf.catalogEntry;
    return isRecord(entry) && typeof entry.version === "string" ? entry.version : "";
  };
  const stable = entries.filter((leaf) => {
    const value = version(leaf);
    return value.length > 0 && !value.includes("-");
  });
  return (stable.length ? stable : entries).at(-1);
}

/**
 * NuGet's upstream, from the package's catalog entry.
 *
 * The registration index names the page for the package, the page names the
 * leaf for a version, and the leaf names the catalog entry, which is a URL
 * rather than embedded metadata. The entry's documented URL fields are read
 * for the upstream **location**, rather than for a GitHub URL specifically,
 * because the registration contract documents `projectUrl` but does not
 * promise a repository field at that level.
 */
async function nugetSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  const id = name.trim().toLowerCase();
  if (!id.length) return { locations: [], reason: "the package has no id" };
  const indexUrl = new URL(
    `https://api.nuget.org/v3/registration5-gz-semver2/${encodeURIComponent(id)}/index.json`,
  );
  request.charge();
  const index = await requestJson(indexUrl, request.signal);
  const pages = isRecord(index) && Array.isArray(index.items) ? index.items : [];
  const page = pages.filter(isRecord).at(-1);
  if (!page) return { locations: [], reason: "the registration index has no pages" };
  let leaves: unknown[] = Array.isArray(page.items) ? page.items : [];
  if (!leaves.length) {
    const pageUrl = page["@id"];
    if (typeof pageUrl !== "string") return { locations: [], reason: "the page has no items" };
    const target = new URL(pageUrl);
    target.hash = "";
    if (target.toString() === indexUrl.toString())
      return { locations: [], reason: "the page has no items" };
    request.charge();
    const fetched = await requestJson(target, request.signal);
    leaves = isRecord(fetched) && Array.isArray(fetched.items) ? fetched.items : [];
  }
  const leaf = pickLeaf(leaves);
  const entry = leaf?.catalogEntry;
  if (!isRecord(entry)) return { locations: [], reason: "the leaf has no catalog entry" };
  const catalogId = entry["@id"];
  if (typeof catalogId !== "string")
    return { locations: [], reason: "the catalog entry names no document" };
  request.charge();
  const catalog = await requestJson(new URL(catalogId), request.signal);
  if (!isRecord(catalog)) return { locations: [], reason: "the catalog entry could not be read" };
  const repository = catalog.repository;
  const repositoryUrl =
    typeof repository === "string"
      ? repository
      : isRecord(repository)
        ? firstString(repository.url)
        : undefined;
  const locations = [repositoryUrl, firstString(catalog.projectUrl)].filter(
    (value): value is string => Boolean(value),
  );
  return locations.length
    ? { locations }
    : { locations: [], reason: "the catalog entry carries no source URL" };
}

/** RubyGems' upstream. */
async function rubygemsSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  request.charge();
  const raw = await requestJson(
    new URL(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`),
    request.signal,
  );
  const sourceCode = isRecord(raw) ? firstString(raw.source_code_uri) : undefined;
  const homepage = isRecord(raw) ? firstString(raw.homepage_uri) : undefined;
  const locations = [sourceCode, homepage].filter((value): value is string => Boolean(value));
  return locations.length
    ? { locations }
    : { locations: [], reason: "RubyGems reports no source URL" };
}

/**
 * The version records of a package, with the inherited fields expanded.
 *
 * Composer 2 metadata may be **minified** — a record inherits the fields of
 * the entry before it — so the inherited fields are expanded before a
 * record's source is read. The array comes newest first, so the first record
 * carries every field and the ones after it may omit what did not change.
 */
export function expandVersionRecords(records: readonly unknown[]): Record<string, unknown>[] {
  const expanded: Record<string, unknown>[] = [];
  let inherited: Record<string, unknown> = {};
  for (const record of records.slice(0, 50)) {
    if (!isRecord(record)) continue;
    inherited = { ...inherited, ...record };
    expanded.push(inherited);
  }
  return expanded;
}

/**
 * Packagist's upstream, from the package's own metadata.
 *
 * The `packages` member is an object keyed by package name, and the value
 * for one package is an array of version records. The desired version is
 * selected out of that array, and the inherited fields are expanded before
 * the source is read.
 */
async function packagistSource(name: string, request: SourceRequest): Promise<PackageSourceResult> {
  const segments = name.split("/");
  if (segments.length !== 2 || !segments[0] || !segments[1])
    return { locations: [], reason: "the package name is not a vendor/package pair" };
  const [vendor, packageName] = segments as [string, string];
  request.charge();
  const raw = await requestJson(
    new URL(
      `https://repo.packagist.org/p2/${encodeURIComponent(vendor)}/${encodeURIComponent(packageName)}.json`,
    ),
    request.signal,
  );
  const packages = isRecord(raw) ? raw.packages : undefined;
  if (!isRecord(packages)) return { locations: [], reason: "the package metadata has no versions" };
  const key = `${vendor}/${packageName}`;
  const records = packages[key] ?? packages[key.toLowerCase()];
  if (!Array.isArray(records))
    return { locations: [], reason: "the package metadata has no versions" };
  // The lookup is version-independent, so the newest record is the current
  // metadata.
  const current = expandVersionRecords(records)[0];
  const source = current?.source;
  const sourceUrl = isRecord(source) ? firstString(source.url) : undefined;
  const locations = [sourceUrl, firstString(current?.homepage)].filter((value): value is string =>
    Boolean(value),
  );
  return locations.length
    ? { locations }
    : { locations: [], reason: "the package metadata carries no source URL" };
}

/**
 * The upstream a registry reports for a package.
 *
 * A registry that does not describe an upstream reports none, and the
 * resolution says so. The lookup asks for the package's **current**
 * metadata: an upstream rarely changes between releases, and the model still
 * confirms a candidate before trusting its notes.
 */
export async function fetchPackageSource(
  registry: PackageRegistry,
  packageName: string,
  request: SourceRequest,
): Promise<PackageSourceResult> {
  switch (registry) {
    case "npm":
      return npmSource(packageName, request);
    case "pypi":
      return pypiSource(packageName, request);
    case "crates":
      return cratesSource(packageName, request);
    case "go":
      return goSource(packageName, request);
    case "maven":
      return mavenSource(packageName, request);
    case "nuget":
      return nugetSource(packageName, request);
    case "rubygems":
      return rubygemsSource(packageName, request);
    case "packagist":
      return packagistSource(packageName, request);
    default:
      return {
        locations: [],
        reason: `the ${registry} registry does not report an upstream location`,
      };
  }
}
