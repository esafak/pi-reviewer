import { readTomlDocument, type TomlEntry } from "./toml.js";
import { isAquaStandardRegistry } from "./aqua.js";
import type {
  DependencyCategory,
  DependencyRecord,
  ManifestFormat,
  ManifestParseResult,
  PackageRegistry,
  VersionDialect,
} from "./types.js";
import { parseVersion } from "./versions.js";
import { findChild, findDescendants, readXmlDocument } from "./xml.js";
import { collectEntries, findEntry, readYamlDocument, scalarText, type YamlNode } from "./yaml.js";
import { readNuGetItems } from "./nuget.js";
import { readGemfile } from "./gemfile.js";
import { readGradleDependencies } from "./gradle.js";

/**
 * The manifest formats the detector reads.
 *
 * The list is closed: a format that is not here is either inventoried as
 * unsupported or is not a manifest. That keeps the unsupported coverage
 * report honest — a changed file is either parsed, inventoried, or
 * acknowledged as not a manifest.
 */
export const SUPPORTED_MANIFESTS: readonly string[] = [
  "package.json",
  "requirements.txt",
  "requirements/*.txt",
  "pyproject.toml",
  "pom.xml",
  "Cargo.toml",
  "go.mod",
  "mise.toml",
  ".mise.toml",
  "mise.local.toml",
  ".config/mise/config.toml",
  ".config/mise/config.local.toml",
  ".tool-versions",
  "aqua.yaml",
  "*.csproj",
  "*.fsproj",
  "Directory.Packages.props",
  "packages.config",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "build.gradle.kts",
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".github/actions/*/action.yml",
  "action.yml",
  "action.yaml",
];

/**
 * The manifests the detector recognizes as manifests but does not parse.
 *
 * A changed file on this list is reported as unsupported coverage, so a
 * repository that pins one of them is told its coverage is missing rather
 * than left to assume it was checked.
 */
export const UNSUPPORTED_MANIFESTS: readonly string[] = [
  "Podfile",
  "pubspec.yaml",
  "mix.exs",
  "Package.swift",
  "conanfile.txt",
  "conanfile.py",
  "MODULE.bazel",
  "WORKSPACE",
];

/** A parser for one manifest format. */
export interface ManifestParser {
  /** The format this parser reads. */
  readonly format: ManifestFormat;
  /** Whether this parser owns a path. */
  matches(path: string): boolean;
  /**
   * Parses a complete manifest.
   *
   * The path is given to the readers that need the dialect of the script
   * they read, because a path and a format do not always say the same
   * thing.
   */
  parse(text: string, path?: string): ManifestParseResult;
}

interface FormatSpec {
  format: ManifestFormat;
  registry: PackageRegistry;
  dialect: VersionDialect;
  category: DependencyCategory;
  matches: (path: string) => boolean;
  parse: (text: string, path?: string) => ManifestParseResult;
}

/** A requirement string, split into the parts a comparison needs. */
export interface Requirement {
  /** The package name, without its extras. */
  name: string;
  /** The version constraint. */
  constraint: string;
}

/**
 * Splits a requirement string into its package, its constraint, and its
 * environment marker.
 *
 * The forms are `name[extras] constraint ; marker`. The marker qualifies the
 * requirement rather than naming a version, and the extras name extra
 * distributions rather than a version, so neither belongs in the constraint.
 */
export function parseRequirement(text: string): Requirement | undefined {
  const withoutMarker = splitOutsideQuotes(text, ";").trim();
  if (!withoutMarker) return undefined;
  const match = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/.exec(withoutMarker);
  if (!match) return undefined;
  const constraint = match[3].trim();
  if (!constraint) return undefined;
  return { name: match[1], constraint };
}

/** Splits a string at a separator that is not inside quotes. */
function splitOutsideQuotes(text: string, separator: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === separator) return text.slice(0, index);
  }
  return text;
}

/** Strips a comment from a line, respecting quoted strings. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

/** Strips a trailing `//` comment, which go.mod uses for the indirect marker. */
function stripLineComment(line: string): string {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
}

function record(
  spec: FormatSpec,
  name: string,
  section: string,
  constraint: string,
  resolvedName?: string,
): DependencyRecord {
  return {
    registry: spec.registry,
    dialect: spec.dialect,
    category: spec.category,
    name,
    section,
    constraint,
    ...(resolvedName ? { resolvedName } : {}),
  };
}

/** The package an npm alias points at, and the range it carries. */
export interface AliasSplit {
  /** The real package, when the constraint is an alias. */
  name?: string;
  /** The range, with the alias removed. */
  range: string;
}

/**
 * The package an npm constraint names, and the range it carries.
 *
 * Two forms carry a protocol: an alias, `npm:real-package@^2.0.0`, names the
 * real package and the range follows the last `@` so a scoped package
 * splits correctly; a workspace dependency, `workspace:^2.0.0`, names the
 * local package and its range is the workspace member's own. A malformed
 * alias is left as it was written, so it fails to parse rather than being
 * read as a version.
 */
function normalizeNpmConstraint(constraint: string): AliasSplit {
  const trimmed = constraint.trim();
  if (trimmed.startsWith("npm:")) {
    const body = trimmed.slice("npm:".length).trim();
    const at = body.lastIndexOf("@");
    if (at <= 0) return { range: trimmed };
    return { name: body.slice(0, at), range: body.slice(at + 1).trim() };
  }
  if (trimmed.startsWith("workspace:")) return { range: trimmed.slice("workspace:".length).trim() };
  return { range: trimmed };
}

const packageJson: FormatSpec = {
  format: "package.json",
  registry: "npm",
  dialect: "semver",
  category: "library",
  matches: (path) => path === "package.json" || path.endsWith("/package.json"),
  parse(text) {
    const warnings: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { records: [], warnings: ["package.json is not valid JSON"] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { records: [], warnings: ["package.json is not an object"] };
    }
    const root = parsed as Record<string, unknown>;
    const records: DependencyRecord[] = [];
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const group = root[section];
      if (group === undefined) continue;
      // A section the reader cannot read is a diagnostic, not a section
      // without dependencies.
      if (group === null || typeof group !== "object" || Array.isArray(group)) {
        warnings.push(`package.json ${section} is not a table of dependencies`);
        continue;
      }
      for (const [name, raw] of Object.entries(group as Record<string, unknown>)) {
        if (typeof raw !== "string") {
          warnings.push(`package.json dependency ${name} has no version`);
          continue;
        }
        const alias = normalizeNpmConstraint(raw);
        records.push(record(packageJson, name, section, alias.range, alias.name));
      }
    }
    records.push(...readRuntimePins(root, warnings));
    const manager = readPackageManager(root, warnings);
    if (manager) records.push(manager);
    return { records, warnings };
  },
};

/** The section a runtime pin is declared in. */
const RUNTIME_SECTION = "devEngines.runtime";

/**
 * The runtime pins a package manifest declares.
 *
 * `devEngines.runtime` names the runtime the project runs on. It is a
 * single object or an array of them, so both forms are read. A runtime is a
 * tool rather than a library: the build invokes it rather than importing
 * it, and its registry is unknown, because no registry describes Node.js or
 * Python — the tool table does.
 */
function readRuntimePins(root: Record<string, unknown>, warnings: string[]): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const devEngines = root["devEngines"];
  if (devEngines === undefined) return records;
  if (!isPlainObject(devEngines)) {
    warnings.push("package.json devEngines is not a table");
    return records;
  }
  const runtimes = devEngines["runtime"];
  if (runtimes === undefined) return records;
  const entries = Array.isArray(runtimes) ? runtimes : [runtimes];
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      warnings.push("package.json devEngines.runtime is not a runtime");
      continue;
    }
    const name = entry["name"];
    const version = entry["version"];
    if (typeof name !== "string" || !name.trim().length) {
      warnings.push("package.json devEngines.runtime has no name");
      continue;
    }
    if (typeof version !== "string" || !version.trim().length) {
      warnings.push(`package.json devEngines.runtime ${name} has no version`);
      continue;
    }
    records.push({
      registry: "unknown",
      dialect: "tool",
      category: "tool",
      name: name.trim(),
      section: RUNTIME_SECTION,
      constraint: version.trim(),
    });
  }
  return records;
}

/**
 * The package manager a manifest pins.
 *
 * The name is split from the version at the last `@` that is not a scope
 * marker, so a scoped package splits correctly, and the integrity suffix a
 * package manager carries is not part of its version.
 */
function readPackageManager(
  root: Record<string, unknown>,
  warnings: string[],
): DependencyRecord | undefined {
  const raw = root["packageManager"];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim().length) {
    warnings.push("package.json packageManager is not a version");
    return undefined;
  }
  const value = raw.trim();
  const at = value.lastIndexOf("@");
  // An `@` at the start of the name is a scope marker, not a separator.
  if (at <= 0) {
    warnings.push("package.json packageManager names no version");
    return undefined;
  }
  const name = value.slice(0, at).trim();
  const version = value.slice(at + 1).trim();
  if (!name.length || !version.length) {
    warnings.push("package.json packageManager names no version");
    return undefined;
  }
  // The integrity suffix is a hash of the tarball, not part of the version.
  const plus = version.indexOf("+");
  const constraint = (plus === -1 ? version : version.slice(0, plus)).trim();
  if (!constraint.length) {
    warnings.push("package.json packageManager names no version");
    return undefined;
  }
  return {
    registry: "npm",
    dialect: "semver",
    category: "tool",
    name,
    section: "packageManager",
    constraint,
  };
}

/** Whether a value is a plain object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const requirements: FormatSpec = {
  format: "requirements",
  registry: "pypi",
  dialect: "pep440",
  category: "library",
  matches: (path) => {
    const name = path.split("/").pop() ?? path;
    return /^requirements.*\.txt$/.test(name) || path.startsWith("requirements/");
  },
  parse(text) {
    const records: DependencyRecord[] = [];
    const warnings: string[] = [];
    for (const raw of text.split("\n")) {
      const line = stripComment(raw).trim();
      if (!line) continue;
      // An include names a file the reader does not follow, so the
      // dependencies in it are not read.
      if (line.startsWith("-")) {
        // Every spelling of an include names a file the reader does not
        // follow: the short flag with or without a space, the long flag
        // with or without an `=`.
        const include = /^(?:-r|-c|-e|--requirement|--constraint|--editable)(?:\s+|=)?(\S+)/.exec(
          line,
        );
        if (include) warnings.push(`requirements.txt includes ${include[1]}, which is not read`);
        continue;
      }
      const requirement = parseRequirement(line);
      if (!requirement) {
        warnings.push(`requirements.txt entry ${line} has no version`);
        continue;
      }
      records.push(record(requirements, requirement.name, "", requirement.constraint));
    }
    return { records, warnings };
  },
};

const pyproject: FormatSpec = {
  format: "pyproject",
  registry: "pypi",
  dialect: "pep440",
  category: "library",
  matches: (path) => path === "pyproject.toml" || path.endsWith("/pyproject.toml"),
  parse(text) {
    const warnings: string[] = [];
    const records: DependencyRecord[] = [];
    const document = readTomlDocument(text);
    for (const warning of document.warnings) warnings.push(warning);
    for (const error of document.errors) warnings.push(error);
    if (document.uncertain) return { records: [], warnings };
    let sawDependencyList = false;
    const addRequirement = (item: string, target: string) => {
      const requirement = parseRequirement(item);
      if (requirement)
        records.push(record(pyproject, requirement.name, target, requirement.constraint));
      else warnings.push(`pyproject.toml requirement ${item} has no version`);
    };
    for (const entry of document.entries) {
      if (entry.error) {
        warnings.push(`pyproject.toml dependency ${entry.key}: ${entry.error}`);
        continue;
      }
      // An entry in a scope the reader does not interpret is not a
      // declaration: it is an array element or a table below one.
      if (entry.unsupported) continue;
      if (entry.items !== undefined) {
        const listSection = dependencyArraySection(entry.scope, entry.key);
        if (!listSection) {
          // A field that is not a dependency field is metadata, and its
          // shape is none of this reader's business.
          if (isDependencyField(entry.scope, entry.key))
            warnings.push(
              `pyproject.toml ${entry.scope.join(".")}.${entry.key} is not a list of requirements`,
            );
          continue;
        }
        sawDependencyList = true;
        if (entry.otherItems)
          warnings.push(
            `pyproject.toml ${entry.scope.join(".")}.${entry.key} has ${entry.otherItems} element(s) that are not requirements`,
          );
        for (const item of entry.items) addRequirement(item, listSection.join("."));
        continue;
      }
      if (entry.inline !== undefined) {
        // The poetry form names its dependencies in a table of name and
        // constraint; the inline spelling of the optional groups names a
        // table of groups whose values are requirement arrays.
        const listSection = dependencyTableSection(entry.scope, entry.key);
        if (!listSection) {
          if (isDependencyField(entry.scope, entry.key))
            warnings.push(
              `pyproject.toml ${entry.scope.join(".")}.${entry.key} is not a table of requirements`,
            );
          continue;
        }
        sawDependencyList = true;
        const isGroupTable =
          isScope(entry.scope, "project") && entry.key === "optional-dependencies";
        for (const nested of entry.inline) {
          // A compound key sits under its own path, so it is not a field of
          // the table that holds it.
          if (nested.scope.length > 0) continue;
          if (isGroupTable) {
            // The value is a group: a table of requirement arrays. Its
            // section is the group's full path, so the inline spelling and
            // the separate-table spelling name the same thing.
            const groupScope = [...listSection, nested.key];
            if (!nested.items) {
              warnings.push(`pyproject.toml group ${nested.key} is not a list of requirements`);
              continue;
            }
            if (nested.otherItems)
              warnings.push(
                `pyproject.toml group ${nested.key} has ${nested.otherItems} element(s) that are not requirements`,
              );
            for (const item of nested.items) addRequirement(item, groupScope.join("."));
            continue;
          }
          if (nested.string !== undefined)
            records.push(record(pyproject, nested.key, listSection.join("."), nested.string));
          else warnings.push(`pyproject.toml dependency ${nested.key} has no literal version`);
        }
        continue;
      }
      const inlineSection = inlineDependencySection(entry.scope);
      if (!inlineSection) {
        // A group's value is an array of requirement strings, so a name and
        // a constraint under it is the wrong shape for the field.
        const group = optionalGroupName(entry.scope);
        if (group) warnings.push(`pyproject.toml group ${group} is not a list of requirements`);
        continue;
      }
      sawDependencyList = true;
      if (entry.string === undefined) {
        warnings.push(`pyproject.toml dependency ${entry.key} has no literal version`);
        continue;
      }
      // The per-package form names the package in the key and gives only
      // its constraint as the value.
      records.push(record(pyproject, entry.key, inlineSection.join("."), entry.string));
    }
    if (!sawDependencyList) warnings.push("pyproject.toml declares no dependency list");
    return { records, warnings };
  },
};

/** Whether a scope is exactly the given segments. */
function isScope(scope: readonly string[], ...segments: string[]): boolean {
  return scope.length === segments.length && segments.every((part, index) => scope[index] === part);
}

/**
 * The scope a dependency **array** belongs to, when the field holds one.
 *
 * The field's shape is part of the field: `project.dependencies` is an
 * array of requirement strings, and a group of
 * `project.optional-dependencies` is an array of requirement strings. A
 * field of the wrong shape is not a declaration.
 */
function dependencyArraySection(scope: readonly string[], key: string): string[] | undefined {
  if (isScope(scope, "project") && key === "dependencies") return ["project", "dependencies"];
  // A group's own table names the group, so the scope is qualified by it.
  if (isScope(scope, "project", "optional-dependencies")) return [...scope, key];
  return undefined;
}

/**
 * The scope a dependency **table** belongs to, when the field holds one.
 *
 * Two tables carry dependencies: the poetry form, whose values are a
 * package and its constraint, and the inline spelling of
 * `project.optional-dependencies`, whose values are the groups of
 * requirement arrays.
 */
function dependencyTableSection(scope: readonly string[], key: string): string[] | undefined {
  if (isScope(scope, "tool", "poetry")) {
    if (key === "dependencies") return ["tool", "poetry", "dependencies"];
    if (key === "dev-dependencies") return ["tool", "poetry", "dev-dependencies"];
  }
  if (isScope(scope, "project") && key === "optional-dependencies")
    return ["project", "optional-dependencies"];
  return undefined;
}

/** Whether a field carries dependencies at all, whatever its shape. */
function isDependencyField(scope: readonly string[], key: string): boolean {
  if (dependencyArraySection(scope, key)) return true;
  if (dependencyTableSection(scope, key)) return true;
  if (inlineDependencySection(scope)) return true;
  return DEPENDENCY_FIELD_NAMES.has(key);
}

/** The field names that name dependencies wherever they appear. */
const DEPENDENCY_FIELD_NAMES = new Set([
  "dependencies",
  "optional-dependencies",
  "dev-dependencies",
]);

/** The scope a single named requirement belongs to, when the table holds one. */
function inlineDependencySection(scope: readonly string[]): string[] | undefined {
  if (isScope(scope, "tool", "poetry", "dependencies")) return [...scope];
  if (isScope(scope, "tool", "poetry", "dev-dependencies")) return [...scope];
  return undefined;
}

/**
 * The group a scope names, when the scope is inside the optional groups.
 *
 * A group's value is an array of requirement strings, so a name and a
 * constraint written under it is the wrong shape for the field.
 */
function optionalGroupName(scope: readonly string[]): string | undefined {
  if (scope.length === 3 && scope[0] === "project" && scope[1] === "optional-dependencies")
    return scope[2];
  return undefined;
}

const pom: FormatSpec = {
  format: "pom.xml",
  registry: "maven",
  dialect: "maven",
  category: "library",
  matches: (path) => path === "pom.xml" || path.endsWith("/pom.xml"),
  parse(text) {
    const document = readXmlDocument(text);
    if (document.error || !document.root)
      return {
        records: [],
        warnings: [`pom.xml is malformed: ${document.error ?? "no root element"}`],
      };
    const records: DependencyRecord[] = [];
    // The root may itself be the dependency element.
    const elements = [
      ...(document.root.name === "dependency" ? [document.root] : []),
      ...findDescendants(document.root, "dependency"),
    ];
    for (const element of elements) {
      const groupId = findChild(element, "groupId")?.text.trim();
      const artifactId = findChild(element, "artifactId")?.text.trim();
      if (!groupId || !artifactId) continue;
      const version = findChild(element, "version")?.text.trim();
      records.push(record(pom, `${groupId}:${artifactId}`, "", version ?? ""));
    }
    return { records, warnings: [] };
  },
};

const CARGO_DEPENDENCY_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"];

/** The entries a manifest declares in one scope. */
interface ScopeBucket {
  /** The scope the entries sit in. */
  scope: string[];
  /** The entries themselves. */
  entries: TomlEntry[];
}

const cargo: FormatSpec = {
  format: "Cargo.toml",
  registry: "crates",
  dialect: "semver",
  category: "library",
  matches: (path) => path === "Cargo.toml" || path.endsWith("/Cargo.toml"),
  parse(text) {
    const warnings: string[] = [];
    const records: DependencyRecord[] = [];
    const document = readTomlDocument(text);
    for (const warning of document.warnings) warnings.push(warning);
    for (const error of document.errors) warnings.push(error);
    if (document.uncertain) return { records: [], warnings };
    // A table the reader does not interpret is reported whether or not it
    // holds an assignment: an empty `[workspace.dependencies]` is still a
    // table the reader did not read.
    const readScopes = new Set<string>();
    for (const scope of document.tables) {
      const base = scope[0];
      if (base === undefined) continue;
      if (base === "workspace" || base === "target") {
        warnings.push(`Cargo.toml table [${scope.join(".")}] is not read`);
        readScopes.add(JSON.stringify(scope));
        continue;
      }
      if (!CARGO_DEPENDENCY_SECTIONS.includes(base)) continue;
      if (scope.length === 1) {
        readScopes.add(JSON.stringify(scope));
        continue;
      }
      if (scope.length === 2) {
        readScopes.add(JSON.stringify(scope));
        continue;
      }
      // A table below a dependency is that dependency's own metadata, not
      // another package.
      warnings.push(`Cargo.toml table [${scope.join(".")}] is not read`);
      readScopes.add(JSON.stringify(scope));
    }
    const byScope = new Map<string, ScopeBucket>();
    for (const entry of document.entries) {
      // An entry in a scope the reader does not interpret is not a
      // declaration: it is an array element or a table below one.
      if (entry.unsupported) continue;
      const identity = JSON.stringify(entry.scope);
      const bucket = byScope.get(identity);
      if (bucket) bucket.entries.push(entry);
      else byScope.set(identity, { scope: entry.scope, entries: [entry] });
    }
    for (const { scope, entries } of byScope.values()) {
      const base = scope[0];
      if (base === undefined) continue;
      if (base === "workspace" || base === "target") {
        warnings.push(`Cargo.toml table [${scope.join(".")}] is not read`);
        continue;
      }
      if (!CARGO_DEPENDENCY_SECTIONS.includes(base)) continue;
      if (scope.length > 1) {
        if (scope.length > 2) {
          // A table below a dependency is that dependency's own metadata,
          // not another package.
          warnings.push(`Cargo.toml table [${scope.join(".")}] is not read`);
          continue;
        }
        // A per-dependency table names the version in its own `version` key.
        const name = scope[1] as string;
        const version = entries.find(
          (entry) => entry.scope.length === scope.length && entry.key === "version",
        )?.string;
        if (version) records.push(record(cargo, name, base, version));
        else warnings.push(`Cargo.toml table [${scope.join(".")}] has no literal version`);
        continue;
      }
      for (const entry of entries) {
        if (entry.error) {
          warnings.push(`Cargo.toml dependency ${entry.key}: ${entry.error}`);
          continue;
        }
        const name = entry.key;
        // A workspace inheritance names the version elsewhere, so there is
        // no version here to compare.
        if (name.includes(".")) {
          warnings.push(`Cargo.toml dependency ${name} inherits its version from the workspace`);
          continue;
        }
        if (entry.string !== undefined) {
          records.push(record(cargo, name, base, entry.string));
          continue;
        }
        if (entry.inline !== undefined) {
          // The version is read from the table's own entry, never searched
          // for in its text: a path or a feature list may contain one. A
          // compound key sits under its own path, so it is not the table's
          // `version` field.
          const version = entry.inline.find(
            (nested) => nested.scope.length === 0 && nested.key === "version",
          )?.string;
          if (version) records.push(record(cargo, name, base, version));
          else warnings.push(`Cargo.toml dependency ${name} has no literal version`);
          continue;
        }
        warnings.push(`Cargo.toml dependency ${name} has no literal version`);
      }
    }
    return { records, warnings };
  },
};

const gomod: FormatSpec = {
  format: "go.mod",
  registry: "go",
  dialect: "go",
  category: "library",
  matches: (path) => path === "go.mod" || path.endsWith("/go.mod"),
  parse(text) {
    const records: DependencyRecord[] = [];
    const warnings: string[] = [];
    let inRequire = false;
    // A block the reader does not interpret is skipped whole.
    let skipping: string | undefined;
    for (const raw of text.split("\n")) {
      const line = stripLineComment(stripComment(raw)).trim();
      if (!line) continue;
      if (skipping) {
        if (line === ")") skipping = undefined;
        continue;
      }
      if (inRequire) {
        if (line === ")") {
          inRequire = false;
          continue;
        }
        const entry = /^(\S+)\s+(\S+)$/.exec(line);
        if (entry) records.push(record(gomod, entry[1], "", entry[2]));
        else warnings.push(`go.mod requirement ${line} is not a module and a version`);
        continue;
      }
      if (line === "require (") {
        inRequire = true;
        continue;
      }
      const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
      if (single) {
        records.push(record(gomod, single[1], "", single[2]));
        continue;
      }
      // A block the reader recognizes but does not interpret is reported
      // once, and its contents are not read.
      const block = /^(replace|exclude|retract|tool)\s*\($/.exec(line);
      if (block) {
        warnings.push(`go.mod ${block[1]} block is not read`);
        skipping = block[1];
        continue;
      }
      // The directives that name no dependency are read and not interpreted.
      if (/^(module|go|toolchain|replace|exclude|retract)\b/.test(line)) continue;
      warnings.push(`go.mod statement ${line} is not read`);
    }
    // A block that is never closed means the reader no longer knows where it
    // is, so nothing the document holds can be trusted.
    if (inRequire || skipping) {
      warnings.push("go.mod has a block that is never closed");
      return { records: [], warnings };
    }
    return { records, warnings };
  },
};

/** The section a mise tool pin is declared in. */
const MISE_SECTION = "tools";

/**
 * The mise backends the harness reads.
 *
 * A backend decides where a tool comes from, so it decides the registry the
 * tool is looked up in. A GitHub backend names the repository outright. An
 * aqua backend names a recipe, which is not necessarily a repository. The
 * core backend selects mise's own backend, and an asdf backend names a
 * plugin, whose repository is the installer rather than the tool.
 *
 * A backend that is not here keeps the unknown registry: the harness never
 * substitutes a different project for one it could not identify. The table
 * is a map rather than an object, so a key that names an inherited property
 * is not an entry.
 */
const MISE_BACKENDS: ReadonlyMap<string, PackageRegistry> = new Map([
  ["npm", "npm"],
  ["cargo", "crates"],
  ["go", "go"],
  ["gem", "rubygems"],
  ["github", "github"],
  ["aqua", "aqua"],
  ["core", "mise-core"],
  ["asdf", "unknown"],
]);

/** Whether a path names a mise configuration. */
function isMiseConfig(path: string): boolean {
  if (path === "mise.toml" || path === ".mise.toml" || path === "mise.local.toml") return true;
  if (path === ".config/mise/config.toml" || path === ".config/mise/config.local.toml") return true;
  return path.endsWith("/mise.toml") || path.endsWith("/.mise.toml");
}

/**
 * The version a mise tool pin carries.
 *
 * A pin is normally a scalar. mise also allows an array of versions and an
 * option table with a `version` key, and only the first version of an array
 * is compared — the rest are reported, because a pin the harness did not
 * read is a pin it cannot claim to have covered.
 *
 * An array that holds a value that is not a version is not read at all: the
 * reader has kept the array's versions but not their places, so the first
 * version it holds is not necessarily the array's first element.
 */
function miseConstraint(entry: TomlEntry, warnings: string[]): string | undefined {
  if (entry.string !== undefined) return entry.string;
  if (entry.items !== undefined) {
    if (entry.otherItems) {
      warnings.push(
        `mise.toml tool ${entry.key} has ${entry.otherItems} value(s) that are not versions`,
      );
      return undefined;
    }
    const first = entry.items[0];
    if (first === undefined) {
      warnings.push(`mise.toml tool ${entry.key} has no version`);
      return undefined;
    }
    if (entry.items.length > 1) {
      warnings.push(
        `mise.toml tool ${entry.key} pins ${entry.items.length} versions; only the first is compared`,
      );
    }
    return first;
  }
  if (entry.inline !== undefined) {
    const version = entry.inline.find(
      (nested) => nested.scope.length === 0 && nested.key === "version",
    )?.string;
    if (version === undefined) {
      warnings.push(`mise.toml tool ${entry.key} has no version`);
      return undefined;
    }
    return version;
  }
  warnings.push(`mise.toml tool ${entry.key} has no version`);
  return undefined;
}

/**
 * The record a mise tool pin declares.
 *
 * A bare pin has no known registry, and it is still comparable: the tool
 * dialect is the pin's own grammar, not the registry's. A backend prefix
 * decides the registry, and a backend the harness does not know keeps the
 * unknown registry rather than being read as some other project's tool.
 */
function miseRecord(key: string, constraint: string): DependencyRecord {
  const colon = key.indexOf(":");
  const base = {
    dialect: "tool" as const,
    category: "tool" as const,
    name: key,
    section: MISE_SECTION,
    constraint,
  };
  if (colon === -1) return { ...base, registry: "unknown" };
  const backend = key.slice(0, colon);
  const target = key.slice(colon + 1);
  const registry = MISE_BACKENDS.get(backend);
  if (!registry) return { ...base, registry: "unknown" };
  // The target is the name to look up: the package name in a registry, the
  // repository in a GitHub backend, and the plugin name in an asdf backend,
  // which the tool table is keyed by.
  return {
    ...base,
    registry,
    ...(target.length ? { resolvedName: target } : {}),
  };
}

/**
 * Whether a mise tool pin names a registry of its own.
 *
 * The aqua backend reads its recipe from the standard registry unless the
 * pin names another one, and a recipe the harness cannot place is a pin it
 * cannot resolve. The pin may name the registry in an option table or as a
 * field of the tool's own table, so both are read.
 */
function miseNamesRegistry(entry: TomlEntry, scope: readonly string[]): boolean {
  if (entry.inline?.some((nested) => nested.scope.length === 0 && nested.key === "registry"))
    return true;
  return scope.length === 2 && entry.key === "registry";
}

/**
 * Whether a mise setting chooses where an aqua recipe comes from.
 *
 * The settings that name a registry, or that turn off the registry mise
 * has built in, move the recipes somewhere the harness cannot read. The
 * settings that only verify a package leave the registry alone.
 */
function miseSettingSelectsRegistry(name: string, entry: TomlEntry): boolean {
  if (name === "registries" || name === "registry_url") return true;
  if (name === "baked_registry") {
    // The registry mise has built in is used unless the setting turns it off.
    return (entry.string ?? entry.value).trim() === "false";
  }
  return false;
}

/** A setting a mise configuration declares, by its own name. */
interface MiseSetting {
  /** The setting's name, such as `settings.aqua.registry_url`. */
  path: string;
  /** The entry the setting was written in. */
  entry: TomlEntry;
}

/**
 * The settings a table declares, by their own names.
 *
 * A setting may be written as a table of its own, as a dotted key, or as a
 * table of its own inside another table, and all three name the same
 * setting. The names are the paths the entries spell, so a caller can ask
 * whether a name selects a registry without knowing which spelling was
 * used.
 */
function miseSettings(
  entries: readonly TomlEntry[],
  prefix: readonly string[] = [],
  depth = 0,
): MiseSetting[] {
  if (depth > 4) return [];
  const settings: MiseSetting[] = [];
  for (const entry of entries) {
    const scope = [...prefix, ...entry.scope];
    settings.push({ path: [...scope, entry.key].join("."), entry });
    // A table of its own continues the path of the key that holds it.
    if (entry.inline)
      settings.push(...miseSettings(entry.inline, [...scope, entry.key], depth + 1));
  }
  return settings;
}

/**
 * Whether a mise configuration names an aqua registry of its own.
 *
 * The aqua settings may be written as a table of their own, as a dotted
 * key, or as a table of their own inside another table, so the whole
 * document is walked for the setting that chooses the registry.
 */
function miseNamesAquaRegistry(entries: readonly TomlEntry[]): boolean {
  for (const setting of miseSettings(entries)) {
    if (!setting.path.startsWith("settings.aqua.")) continue;
    const name = setting.path.slice("settings.aqua.".length);
    // A nested table is not a setting.
    if (name.includes(".")) continue;
    if (miseSettingSelectsRegistry(name, setting.entry)) return true;
  }
  return false;
}

const mise: FormatSpec = {
  format: "mise.toml",
  registry: "unknown",
  dialect: "tool",
  category: "tool",
  matches: (path) => isMiseConfig(path),
  parse(text) {
    const warnings: string[] = [];
    const records: DependencyRecord[] = [];
    const document = readTomlDocument(text);
    for (const warning of document.warnings) warnings.push(warning);
    for (const error of document.errors) warnings.push(error);
    if (document.uncertain) return { records, warnings };
    // A tool pin is written in one of two shapes: as the value of a key in
    // the tool table, or as a table of its own with a `version` key.
    const versions = new Map<string, string>();
    const tables = new Set<string>();
    // The tools whose recipe comes from a registry the harness cannot read.
    const namedRegistry = new Set<string>();
    const markNamedRegistry = (name: string): void => {
      if (namedRegistry.has(name)) return;
      namedRegistry.add(name);
      warnings.push(`mise.toml tool ${name} names a registry, which is not read`);
    };
    const aquaRegistrySetting = miseNamesAquaRegistry(document.entries);
    // A tool table is declared whether or not it holds an assignment, so a
    // table the reader cannot read is still reported.
    for (const scope of document.tables) {
      if (scope.length === 2 && scope[0] === "tools") tables.add(scope[1]!);
    }
    for (const entry of document.entries) {
      if (entry.error) {
        warnings.push(`mise.toml tool ${entry.key}: ${entry.error}`);
        continue;
      }
      // An entry in a scope the reader does not interpret is not a
      // declaration: it is an array element or a table below one.
      if (entry.unsupported) continue;
      const scope = entry.scope;
      if (scope.length === 1 && scope[0] === "tools") {
        if (entry.key.startsWith("aqua:") && miseNamesRegistry(entry, scope)) {
          markNamedRegistry(entry.key);
          continue;
        }
        const constraint = miseConstraint(entry, warnings);
        if (constraint !== undefined) versions.set(entry.key, constraint);
        continue;
      }
      if (scope.length === 2 && scope[0] === "tools") {
        const name = scope[1]!;
        tables.add(name);
        if (entry.key === "registry" && name.startsWith("aqua:")) {
          markNamedRegistry(name);
          continue;
        }
        if (entry.key !== "version") continue;
        if (entry.string === undefined) {
          warnings.push(`mise.toml tool ${name} has no version`);
          continue;
        }
        versions.set(name, entry.string);
      }
    }
    for (const name of tables) {
      if (!versions.has(name)) warnings.push(`mise.toml tool ${name} has no version`);
    }
    if (aquaRegistrySetting) {
      warnings.push("mise.toml names an aqua registry, which is not read");
    }
    for (const [name, constraint] of versions) {
      // A configuration that points the aqua backend at a registry of its
      // own leaves every aqua pin's recipe somewhere the harness cannot
      // read.
      if (namedRegistry.has(name)) continue;
      if (aquaRegistrySetting && name.startsWith("aqua:")) continue;
      records.push(miseRecord(name, constraint));
    }
    return { records, warnings };
  },
};

/**
 * The pseudo-versions asdf writes instead of a version.
 *
 * They name where the tool comes from rather than which version of it is
 * used, so there is no version to compare.
 */
function isPseudoVersion(value: string): boolean {
  if (value === "system") return true;
  return value.startsWith("ref:") || value.startsWith("path:");
}

const toolVersions: FormatSpec = {
  format: "tool-versions",
  registry: "unknown",
  dialect: "tool",
  category: "tool",
  matches: (path) => path === ".tool-versions" || path.endsWith("/.tool-versions"),
  parse(text) {
    const warnings: string[] = [];
    const records: DependencyRecord[] = [];
    for (const raw of text.split("\n")) {
      const line = stripComment(raw).trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const plugin = parts[0]!;
      const versions = parts.slice(1);
      if (!versions.length) {
        warnings.push(`.tool-versions entry ${plugin} has no version`);
        continue;
      }
      if (versions.length > 1) {
        warnings.push(
          `.tool-versions entry ${plugin} lists ${versions.length} versions; only the first is compared`,
        );
      }
      const version = versions[0]!;
      if (isPseudoVersion(version)) {
        warnings.push(`.tool-versions entry ${plugin} has no version`);
        continue;
      }
      records.push(record(toolVersions, plugin, "", version));
    }
    return { records, warnings };
  },
};

/**
 * The checksum suffix an aqua version may carry.
 *
 * The checksum is the hash of the release, not part of the version, so it
 * is stripped before the version is compared.
 */
function stripAquaChecksum(version: string): string {
  const at = version.indexOf("@");
  return at === -1 ? version : version.slice(0, at);
}

/**
 * The package an aqua entry names.
 *
 * A package is named either in one string — `owner/tool@version` — or by a
 * name and a version of its own. The two spellings name the same package,
 * so the version is read from whichever carries it.
 */
interface AquaPackage {
  /** The package's name. */
  name?: string;
  /** The version the entry names. */
  version?: string;
}

/** The package and version an aqua entry names. */
function aquaPackage(entry: YamlNode): AquaPackage {
  if (entry.kind === "scalar") {
    const value = entry.value.trim();
    const at = value.indexOf("@", value.lastIndexOf("/") + 1);
    if (at === -1) return { name: value };
    return { name: value.slice(0, at).trim(), version: value.slice(at + 1).trim() };
  }
  const name = scalarText(findEntry(entry, "name")?.value)?.trim();
  const version = scalarText(findEntry(entry, "version")?.value)?.trim();
  const combined = name ? aquaPackage({ kind: "scalar", value: name, line: 0, quoted: false }) : {};
  return {
    ...((combined.name ?? name) ? { name: combined.name ?? name } : {}),
    ...((version ?? combined.version) ? { version: version ?? combined.version } : {}),
  };
}

/**
 * A registry an aqua configuration declares.
 *
 * The standard registry is the one the harness reads: its recipes name the
 * repositories that publish the packages. A registry that is not the
 * standard one holds its own recipes, which the harness cannot place.
 */
interface AquaRegistry {
  /** The registry is the standard registry. */
  standard: boolean;
}

/** The registries an aqua configuration declares. */
interface AquaRegistries {
  /** The registries, by name. */
  registries: Map<string, AquaRegistry>;
  /**
   * The registry configuration could not be read, so the harness cannot
   * know which registry the recipes come from.
   */
  unread: boolean;
  /** The registries the harness cannot read, reported as coverage. */
  warnings: string[];
}

/**
 * A field of an aqua registry declaration, as the manifest writes it.
 *
 * A field the reader did not interpret is not a field with an empty value:
 * applying a default to it would name the official registry for a
 * declaration that names another one.
 */
interface AquaField {
  /** The field's text. */
  text?: string;
  /** The field was not read. */
  unread: boolean;
}

/**
 * The text of a field, and whether it was read.
 *
 * A field the declaration does not have takes aqua's default, and a field
 * written empty takes it too. A field the reader did not interpret is
 * neither: it says nothing about what the declaration names.
 */
function aquaField(item: YamlNode, key: string): AquaField {
  const entry = findEntry(item, key);
  if (!entry) return { unread: false };
  const value = entry.value;
  if (value.kind !== "scalar") return { unread: true };
  if (value.unread) return { unread: true };
  const text = value.value.trim();
  return { ...(text.length ? { text } : {}), unread: false };
}

/**
 * The registries an aqua configuration declares.
 *
 * The standard registry needs no declaration: it is the one aqua falls
 * back to, and a package that names no registry uses it. A declaration
 * that names no registry names the standard one, and the fields it leaves
 * out take aqua's defaults.
 *
 * A registry configuration that is present but could not be read is not the
 * same as one that is absent: the first may select a registry the harness
 * cannot place, and the second selects the standard one.
 */
function aquaRegistries(root: YamlNode | undefined): AquaRegistries {
  const registries = new Map<string, AquaRegistry>();
  const warnings: string[] = [];
  const declared = findEntry(root, "registries");
  if (!declared) {
    registries.set("standard", { standard: true });
    return { registries, unread: false, warnings };
  }
  const list = declared.value;
  if (list.kind !== "sequence") return { registries, unread: true, warnings };
  for (const item of list.items) {
    if (item.kind !== "mapping") return { registries, unread: true, warnings };
    const name = aquaField(item, "name");
    const type = aquaField(item, "type");
    const owner = aquaField(item, "repo_owner");
    const repository = aquaField(item, "repo_name");
    const path = aquaField(item, "path");
    // A field the reader did not interpret leaves the declaration's source
    // unknown, and a default would name the official registry for it.
    if ([name, type, owner, repository, path].some((field) => field.unread)) {
      return { registries, unread: true, warnings };
    }
    // A declaration that names no registry names the standard one, and a
    // name written empty is a name left out.
    const key = name.text || "standard";
    const standard = isAquaStandardRegistry({
      type: type.text,
      owner: owner.text,
      repository: repository.text,
      path: path.text,
    });
    registries.set(key, { standard });
    // A registry that is not the standard one holds recipes the harness
    // cannot place, whether or not a package selects it.
    if (!standard) {
      warnings.push(`aqua.yaml registry ${key} is not the standard registry, which is not read`);
    }
  }
  if (!registries.has("standard")) registries.set("standard", { standard: true });
  return { registries, unread: false, warnings };
}

const aqua: FormatSpec = {
  format: "aqua.yaml",
  registry: "aqua",
  dialect: "tool",
  category: "tool",
  matches: (path) => path === "aqua.yaml" || path.endsWith("/aqua.yaml"),
  parse(text) {
    const warnings: string[] = [];
    const records: DependencyRecord[] = [];
    const document = readYamlDocument(text);
    for (const warning of document.warnings) warnings.push(warning);
    for (const error of document.errors) warnings.push(error);
    if (document.uncertain) return { records, warnings };
    const { registries, unread, warnings: registryWarnings } = aquaRegistries(document.root);
    warnings.push(...registryWarnings);
    const packages = findEntry(document.root, "packages")?.value;
    if (packages?.kind !== "sequence") {
      warnings.push("aqua.yaml declares no packages");
      return { records, warnings };
    }
    if (unread) {
      // The registries the file declares could not be read, so the recipes
      // may come from a registry the harness cannot place.
      warnings.push("aqua.yaml registries could not be read");
      return { records, warnings };
    }
    for (const item of packages.items) {
      const { name, version } = aquaPackage(item);
      if (!name) {
        warnings.push("aqua.yaml package has no name");
        continue;
      }
      // A package names the registry its recipe lives in, and the standard
      // registry is the one it names when it names none.
      const registryName = scalarText(findEntry(item, "registry")?.value)?.trim() ?? "standard";
      const registry = registries.get(registryName);
      if (!registry) {
        warnings.push(
          `aqua.yaml package names the registry ${registryName}, which is not declared`,
        );
        continue;
      }
      if (!registry.standard) {
        warnings.push(
          `aqua.yaml package ${name} is in the registry ${registryName}, which is not read`,
        );
        continue;
      }
      if (!version) {
        warnings.push(`aqua.yaml package ${name} has no version`);
        continue;
      }
      records.push(record(aqua, name, "packages", stripAquaChecksum(version)));
    }
    return { records, warnings };
  },
};

/** Whether a path names a workflow or an action definition. */
function isWorkflowPath(path: string): boolean {
  if (path === "action.yml" || path === "action.yaml") return true;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return true;
  if (/^\.github\/actions\/.+\/action\.ya?ml$/.test(path)) return true;
  return false;
}

/** Whether a reference names a commit rather than a tag. */
function isCommitReference(reference: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(reference);
}

/**
 * The version a pinned action carries.
 *
 * A reference is either a version tag or a commit. A commit carries no
 * version of its own, so the version is read from the comment beside it —
 * which is where a repository that pins actions to digests keeps it. A
 * reference with no recognizable version is reported as unresolved rather
 * than left out, so the pin stays visible.
 */
function actionVersion(
  reference: string | undefined,
  comment: string | undefined,
  warnings: string[],
): string {
  if (reference === undefined) {
    warnings.push("an action reference names no version");
    return "unresolved";
  }
  if (isCommitReference(reference)) {
    for (const token of (comment ?? "").split(/\s+/)) {
      if (token.length && parseVersion("semver", token)) return token;
    }
    warnings.push(`the action pinned to a commit has no version in its comment`);
    return "unresolved";
  }
  if (parseVersion("semver", reference)) return reference;
  warnings.push(`the action reference ${reference} names no version`);
  return "unresolved";
}

const githubActions: FormatSpec = {
  format: "github-actions",
  registry: "github",
  dialect: "semver",
  category: "tool",
  matches: (path) => isWorkflowPath(path),
  parse(text) {
    const warnings: string[] = [];
    const records: DependencyRecord[] = [];
    const document = readYamlDocument(text);
    for (const warning of document.warnings) warnings.push(warning);
    for (const error of document.errors) warnings.push(error);
    if (document.uncertain) return { records, warnings };
    for (const entry of collectEntries(document.root, "uses")) {
      const value = entry.value;
      if (value.kind !== "scalar") {
        warnings.push(`the uses: entry on line ${entry.line} is not a reference`);
        continue;
      }
      const reference = value.value.trim();
      if (!reference.length) {
        warnings.push(`the uses: entry on line ${entry.line} is empty`);
        continue;
      }
      // A local action and a container image are not repositories, so they
      // name no upstream to research.
      if (reference.startsWith("./") || reference.startsWith("../")) continue;
      if (reference.includes("://")) {
        warnings.push(`the uses: entry on line ${entry.line} is not a repository`);
        continue;
      }
      const at = reference.lastIndexOf("@");
      const target = at === -1 ? reference : reference.slice(0, at);
      const segments = target.split("/").filter(Boolean);
      if (segments.length < 2) {
        warnings.push(`the uses: entry on line ${entry.line} names no repository`);
        continue;
      }
      // A reference may name a directory inside the repository, which is
      // not part of the repository's identity.
      const name = `${segments[0]}/${segments[1]}`;
      const constraint = actionVersion(
        at === -1 ? undefined : reference.slice(at + 1),
        value.comment,
        warnings,
      );
      records.push(record(githubActions, name, "", constraint));
    }
    return { records, warnings };
  },
};

/**
 * The items of a TOML array.
 *
 * A requirement string may contain a comma — `flask>=2,<3` is one
 * requirement — so the array is read with a scanner that respects quoted
 * strings and nested brackets rather than by splitting on commas.
 */
export interface TomlArray {
  /** The array's items, with their quotes removed. */
  items: string[];
  /** The array was never closed. */
  unterminated: boolean;
}

/** Reads the items of a TOML array whose opening bracket is at `text[0]`. */
export function readTomlArray(text: string): TomlArray {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = "";
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      if (depth > 1) current += char;
      continue;
    }
    if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        const item = current.trim();
        if (item) items.push(stripQuotes(item));
        return { items, unterminated: false };
      }
      current += char;
      continue;
    }
    if (char === "," && depth === 1) {
      const item = current.trim();
      if (item) items.push(stripQuotes(item));
      current = "";
      continue;
    }
    current += char;
  }
  const item = current.trim();
  if (item) items.push(stripQuotes(item));
  return { items, unterminated: true };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The file's name, without its directory. */
function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * The reads a NuGet manifest's packages are read with.
 *
 * A project file names its packages with `Include` and versions them with
 * `Version`, and a central package management file does the same, so the
 * two spellings are the same reader. The legacy format writes `id` and
 * `version` instead.
 */
const csproj: FormatSpec = {
  format: "csproj",
  registry: "nuget",
  dialect: "semver",
  category: "library",
  matches: (path) => {
    const name = fileName(path);
    return name.endsWith(".csproj") || name.endsWith(".fsproj");
  },
  parse(text) {
    const document = readXmlDocument(text);
    if (document.error || !document.root)
      return {
        records: [],
        warnings: [`a project file is malformed: ${document.error ?? "no root element"}`],
      };
    const records: DependencyRecord[] = [];
    const read = readNuGetItems(document.root, {
      elements: ["PackageReference", "PackageVersion"],
      nameAttributes: ["Include", "Update"],
      versionAttribute: "Version",
      versionElement: "Version",
      updateAttribute: "Update",
      removeAttribute: "Remove",
      containers: ["ItemGroup"],
      roots: ["Project"],
      conditions: ["Choose", "When", "Otherwise"],
      conditionalScopes: ["Choose", "When", "Otherwise"],
    });
    if (read.error) return { records, warnings: [read.error] };
    const warnings = [...read.warnings];
    for (const item of read.items) {
      if (item.reason) {
        warnings.push(
          item.name
            ? `the package ${item.name} ${item.reason}`
            : `a ${item.element} item ${item.reason}`,
        );
        continue;
      }
      if (!item.version) {
        // A package whose version the item does not carry is a package
        // whose version lives elsewhere — a central package management
        // file — or one that names a version the reader does not read.
        warnings.push(`the package ${item.name} has no version`);
        continue;
      }
      records.push(record(csproj, item.name as string, "", item.version));
    }
    return { records, warnings };
  },
};

/**
 * The central package management file.
 *
 * The file names the version of every package the project uses, so it is
 * where a version bump lands when the project pins its packages centrally.
 * An `Update` item names the package whose version the file changes, and
 * it is a version declaration like any other.
 */
const packagesProps: FormatSpec = {
  format: "packages.props",
  registry: "nuget",
  dialect: "semver",
  category: "library",
  matches: (path) => fileName(path) === "Directory.Packages.props",
  parse(text) {
    const document = readXmlDocument(text);
    if (document.error || !document.root)
      return {
        records: [],
        warnings: [
          `a package management file is malformed: ${document.error ?? "no root element"}`,
        ],
      };
    const records: DependencyRecord[] = [];
    const read = readNuGetItems(document.root, {
      elements: ["PackageVersion"],
      nameAttributes: ["Include", "Update"],
      versionAttribute: "Version",
      versionElement: "Version",
      updateAttribute: "Update",
      removeAttribute: "Remove",
      containers: ["ItemGroup"],
      roots: ["Project"],
      conditions: ["Choose", "When", "Otherwise"],
      conditionalScopes: ["Choose", "When", "Otherwise"],
    });
    if (read.error) return { records, warnings: [read.error] };
    const warnings = [...read.warnings];
    for (const item of read.items) {
      if (item.reason) {
        warnings.push(
          item.name
            ? `the package ${item.name} ${item.reason}`
            : `a ${item.element} item ${item.reason}`,
        );
        continue;
      }
      if (!item.version) {
        warnings.push(`the package ${item.name} has no version`);
        continue;
      }
      records.push(record(packagesProps, item.name as string, "", item.version));
    }
    return { records, warnings };
  },
};

/** The legacy NuGet manifest. */
const packagesConfig: FormatSpec = {
  format: "packages.config",
  registry: "nuget",
  dialect: "semver",
  category: "library",
  matches: (path) => fileName(path) === "packages.config",
  parse(text) {
    const document = readXmlDocument(text);
    if (document.error || !document.root)
      return {
        records: [],
        warnings: [`a packages.config is malformed: ${document.error ?? "no root element"}`],
      };
    const records: DependencyRecord[] = [];
    const read = readNuGetItems(document.root, {
      elements: ["package"],
      nameAttributes: ["id"],
      versionAttribute: "version",
      containers: ["packages"],
      roots: ["packages"],
      conditions: [],
      conditionalScopes: [],
    });
    if (read.error) return { records, warnings: [read.error] };
    const warnings = [...read.warnings];
    for (const item of read.items) {
      if (item.reason) {
        warnings.push(
          item.name
            ? `the package ${item.name} ${item.reason}`
            : `a ${item.element} item ${item.reason}`,
        );
        continue;
      }
      if (!item.version) {
        warnings.push(`the package ${item.name} has no version`);
        continue;
      }
      records.push(record(packagesConfig, item.name as string, "", item.version));
    }
    return { records, warnings };
  },
};

/**
 * The Gemfile.
 *
 * The group a gem is declared in is not part of the gem's identity: the
 * same gem in two groups is one dependency of the project, and the
 * comparison collapses the repeated declarations into one transition.
 */
const gemfile: FormatSpec = {
  format: "Gemfile",
  registry: "rubygems",
  dialect: "semver",
  category: "library",
  matches: (path) => fileName(path) === "Gemfile",
  parse(text) {
    const { gems, warnings } = readGemfile(text);
    const records = gems.map((gem) => record(gemfile, gem.name, "", gem.requirement ?? ""));
    return { records, warnings };
  },
};

/**
 * Whether a Composer requirement names the platform rather than a package.
 *
 * A requirement on the PHP runtime, on an extension, or on Composer's own
 * API is a requirement on the environment, and the registry publishes no
 * package for it. Reading one as a package would send the model to
 * whatever the registry happens to publish under that name.
 */
function isPlatformRequirement(name: string): boolean {
  if (name === "php" || name.startsWith("php-")) return true;
  if (name.startsWith("ext-") || name.startsWith("lib-")) return true;
  if (name === "composer" || name.startsWith("composer-")) return true;
  return false;
}

/**
 * The Composer manifest.
 *
 * A requirement is a constraint, and the constraint is kept as it was
 * written: a constraint with more than one bound names no single version,
 * and the comparison must not read one of the bounds as the version.
 */
const composer: FormatSpec = {
  format: "composer.json",
  registry: "packagist",
  dialect: "semver",
  category: "library",
  matches: (path) => fileName(path) === "composer.json",
  parse(text) {
    const warnings: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { records: [], warnings: ["composer.json is not valid JSON"] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { records: [], warnings: ["composer.json is not an object"] };
    }
    const root = parsed as Record<string, unknown>;
    const records: DependencyRecord[] = [];
    for (const section of ["require", "require-dev"]) {
      const group = root[section];
      if (group === undefined) continue;
      if (!isPlainObject(group)) {
        warnings.push(`composer.json ${section} is not a table of requirements`);
        continue;
      }
      for (const [name, raw] of Object.entries(group)) {
        if (typeof raw !== "string") {
          warnings.push(`composer.json requirement ${name} has no version`);
          continue;
        }
        if (isPlatformRequirement(name)) {
          warnings.push(`composer.json requirement ${name} is a platform requirement`);
          continue;
        }
        records.push(record(composer, name, section, raw));
      }
    }
    return { records, warnings };
  },
};

/**
 * The Gradle build script.
 *
 * The declarations are the ones in a `dependencies` block, and they name
 * a Maven coordinate. A version that is a Gradle variable or a property
 * reference is kept as it was written: the comparison cannot read it, and
 * the report names the variable that changed.
 */
const gradle: FormatSpec = {
  format: "build.gradle",
  registry: "maven",
  dialect: "maven",
  category: "library",
  matches: (path) => {
    const name = fileName(path);
    return name === "build.gradle" || name === "build.gradle.kts";
  },
  parse(text, path) {
    // The Kotlin script's strings are raw: they process no escape.
    const kotlin = path !== undefined && path.endsWith(".kts");
    const { dependencies, warnings } = readGradleDependencies(text, kotlin);
    const records = dependencies.map((dependency) =>
      record(gradle, dependency.coordinate, "", dependency.version ?? ""),
    );
    return { records, warnings };
  },
};

const specs: FormatSpec[] = [
  packageJson,
  requirements,
  pyproject,
  pom,
  cargo,
  gomod,
  mise,
  toolVersions,
  aqua,
  githubActions,
  csproj,
  packagesProps,
  packagesConfig,
  gemfile,
  composer,
  gradle,
];

/**
 * The parser registry. Each format is one entry, so a new format is a new
 * entry rather than a new branch in a shared function.
 */
const parsers: ManifestParser[] = specs.map((spec) => ({
  format: spec.format,
  matches: spec.matches,
  parse: spec.parse,
}));

/** The format a path is written in, when the detector knows it. */
export function manifestFormat(path: string): ManifestFormat | undefined {
  return parsers.find((parser) => parser.matches(path))?.format;
}

/** Whether a path is a manifest the detector reads. */
export function isSupportedManifest(path: string): boolean {
  return parsers.some((parser) => parser.matches(path));
}

/** Parses a complete manifest in a known format. */
export function parseManifest(
  format: ManifestFormat,
  text: string,
  path?: string,
): ManifestParseResult {
  const parser = parsers.find((candidate) => candidate.format === format);
  if (!parser) return { records: [], warnings: [`unsupported manifest format: ${format}`] };
  return parser.parse(text, path);
}
