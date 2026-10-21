import { readTomlDocument, type TomlEntry } from "./toml.js";
import type {
  DependencyCategory,
  DependencyRecord,
  ManifestFormat,
  ManifestParseResult,
  PackageRegistry,
  VersionDialect,
} from "./types.js";
import { findChild, findDescendants, readXmlDocument } from "./xml.js";

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
  /** Parses a complete manifest. */
  parse(text: string): ManifestParseResult;
}

interface FormatSpec {
  format: ManifestFormat;
  registry: PackageRegistry;
  dialect: VersionDialect;
  category: DependencyCategory;
  matches: (path: string) => boolean;
  parse: (text: string) => ManifestParseResult;
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
    return { records, warnings };
  },
};

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

const specs: FormatSpec[] = [packageJson, requirements, pyproject, pom, cargo, gomod];

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
export function parseManifest(format: ManifestFormat, text: string): ManifestParseResult {
  const parser = parsers.find((candidate) => candidate.format === format);
  if (!parser) return { records: [], warnings: [`unsupported manifest format: ${format}`] };
  return parser.parse(text);
}
