/**
 * The vocabulary of a dependency change.
 *
 * A manifest declares a dependency as a (registry, name, constraint) triple;
 * the format it is written in is a separate axis. Keeping the two apart is
 * what lets a mise tool pin, a `package.json` dependency, and a Go module
 * requirement share one comparison, one threshold, and one report.
 */

/** The upstream a package can come from. */
export type PackageRegistry =
  | "npm"
  | "pypi"
  | "maven"
  | "crates"
  | "go"
  | "nuget"
  | "rubygems"
  | "packagist"
  | "aqua"
  | "github"
  | "mise-core"
  /**
   * The upstream is not known. A tool pin whose backend cannot be mapped
   * keeps this, and the resolution step is what tries to narrow it.
   */
  | "unknown";

/**
 * What the dependency is for. A library is imported by the code; a tool is
 * invoked by the build. The category decides the breaking-change threshold,
 * because a runtime breaks across minor versions and a library does not.
 */
export type DependencyCategory = "library" | "tool";

/**
 * The version grammar of a dependency's registry.
 *
 * The dialect belongs to the manifest entry, not to the registry: a bare
 * mise tool pin has no known registry but still has a well-defined version
 * grammar, and it must be comparable before anything works out where the
 * tool comes from.
 */
export type VersionDialect = "semver" | "pep440" | "maven" | "go" | "tool";

/** The manifest syntaxes the detector reads. */
export type ManifestFormat =
  | "package.json"
  | "requirements"
  | "pyproject"
  | "pom.xml"
  | "Cargo.toml"
  | "go.mod"
  | "mise.toml"
  | "tool-versions"
  | "aqua.yaml"
  | "github-actions"
  | "csproj"
  | "packages.props"
  | "packages.config"
  | "Gemfile"
  | "composer.json"
  | "build.gradle";

/** How a dependency's version changed. */
export type VersionChangeKind =
  | "major"
  | "pre-1.0-minor"
  | "minor"
  | "patch"
  | "added"
  | "removed"
  | "downgrade"
  | "unresolved";

/** One dependency as a manifest declares it. */
export interface DependencyRecord {
  registry: PackageRegistry;
  dialect: VersionDialect;
  category: DependencyCategory;
  /** The key as the manifest writes it. */
  name: string;
  /**
   * The dependency section or group the entry was declared in. Part of the
   * record's identity: a manifest may declare the same package in more than
   * one section with different constraints, and each occurrence is separate.
   * Formats with a single section use an empty string.
   */
  section: string;
  /** The version constraint as written. */
  constraint: string;
  /** The package to research, when it differs from the manifest key. */
  resolvedName?: string;
}

/** One dependency's change between two revisions of a manifest. */
export interface DependencyChange {
  registry: PackageRegistry;
  dialect: VersionDialect;
  category: DependencyCategory;
  name: string;
  section: string;
  resolvedName?: string;
  /** The raw constraint before the change. */
  from?: string;
  /** The raw constraint after the change. */
  to?: string;
  /**
   * The normalized version the comparison used, on the side that has one.
   * A comparison representative is not a published version, so it is never
   * used as an endpoint path.
   */
  fromVersion?: string;
  toVersion?: string;
  kind: VersionChangeKind;
  /** The manifest the change was found in. */
  manifest: string;
  /** The manifest key before the change, when it differs from `name`. */
  previousName?: string;
}

/** What a manifest parser produced. */
export interface ManifestParseResult {
  records: DependencyRecord[];
  /** Syntax the parser recognized but could not interpret. */
  warnings: string[];
}
