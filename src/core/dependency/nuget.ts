import type { XmlElement } from "./xml.js";

/**
 * A package a NuGet manifest declares.
 *
 * A NuGet manifest is XML, and the three formats the detector reads write
 * their packages in three spellings: a project file writes
 * `PackageReference` items, a central package management file writes
 * `PackageVersion` items, and the legacy format writes `package` elements.
 * The item carries the package's identifier and its version in an
 * attribute, and a project file may carry the version in a child element
 * instead.
 */
export interface NuGetItem {
  /** The element that declared the package. */
  readonly element: string;
  /** The package's identifier, as the manifest writes it. */
  readonly name?: string;
  /** The version the item carries, when it carries one. */
  readonly version?: string;
  /**
   * The item names a package whose version it updates, rather than
   * declaring one.
   */
  readonly updated?: boolean;
  /** The item removes a package rather than declaring one. */
  readonly removed?: boolean;
  /**
   * The item applies only under a condition the reader cannot evaluate.
   */
  readonly conditional?: boolean;
  /**
   * The item overrides the version the package resolves to, and the
   * override is a version the reader does not read.
   */
  readonly override?: boolean;
  /**
   * The item names no package the reader can know.
   *
   * An item expression or a wildcard names any number of packages, and a
   * mutation that names one may touch any of them.
   */
  readonly unknownTarget?: boolean;
  /** Why the item was not read, when it was not. */
  readonly reason?: string;
}

/**
 * The spellings a NuGet manifest's items are read with.
 *
 * The element names, the attribute that names the package, and the
 * attribute and child element that carry its version are the manifest's
 * own: a project file writes `Include` and `Version`, and the legacy
 * format writes `id` and `version`.
 */
export interface NuGetSpellings {
  /** The elements that declare a package. */
  readonly elements: readonly string[];
  /**
   * The attributes that name the package.
   *
   * A central package management file may name a package with `Update`
   * rather than with `Include`, and both name a package whose version the
   * file sets.
   */
  readonly nameAttributes: readonly string[];
  /** The attribute that carries the version. */
  readonly versionAttribute: string;
  /** The child element that carries the version, when the manifest uses one. */
  readonly versionElement?: string;
  /**
   * The attribute that names the package an item updates.
   *
   * An update names a package another item declares, and it sets the
   * version that item resolves to.
   */
  readonly updateAttribute?: string;
  /**
   * The attribute that names the package an item removes.
   */
  readonly removeAttribute?: string;
  /**
   * The elements that may hold a declaration.
   *
   * A declaration is a declaration where the format puts declarations:
   * an item group in a project file, and the root of the legacy format.
   * An element of the same name somewhere else — a package reference in
   * an extension's own metadata — is not a declaration.
   */
  readonly containers: readonly string[];
  /**
   * The roots the document may have.
   *
   * A file whose root is something else is not the manifest the reader
   * reads, whatever it holds.
   */
  readonly roots: readonly string[];
  /**
   * The elements that hold a declaration only under a condition.
   *
   * A conditional build chooses between its branches, and only one of them
   * runs, so a package a branch declares is a package the project may not
   * have.
   */
  readonly conditionalScopes: readonly string[];
  /**
   * The elements that may wrap the element that holds a declaration.
   *
   * A project file holds a declaration in an item group, and a
   * conditional build wraps the item group in a `Choose` and a `When` or
   * an `Otherwise`. An item group in an extension's own metadata is
   * wrapped in nothing this reader knows, and it is metadata.
   */
  readonly conditions: readonly string[];
}

/**
 * The nesting a document may have.
 *
 * A document nested deeper than this is not one the reader can walk, and
 * it is reported rather than read.
 */
const MAX_NESTING = 64;

/** What a NuGet manifest declares. */
export interface NuGetReadResult {
  /** The packages the manifest declares. */
  readonly items: readonly NuGetItem[];
  /** The declarations the reader did not read. */
  readonly warnings: readonly string[];
  /** The document is not the manifest the reader reads. */
  readonly error?: string;
}

/**
 * Reads one item.
 *
 * The version is the attribute the manifest writes it in, or the child
 * element it writes it in. A child element that holds markup is not a
 * version: its text is the parts around the markup, and reading them
 * would name a version the manifest never wrote.
 */
function readItem(
  element: XmlElement,
  spellings: NuGetSpellings,
  insideContainer: boolean,
  inheritedCondition: boolean,
): NuGetItem {
  if (!insideContainer) {
    return {
      element: element.name,
      reason: "is not declared where the reader reads declarations",
    };
  }
  let name: string | undefined;
  let updated = false;
  for (const attribute of spellings.nameAttributes) {
    const value = element.attributes[attribute]?.trim();
    if (!value) continue;
    name = value;
    updated = attribute === spellings.updateAttribute;
    break;
  }
  const removed = spellings.removeAttribute
    ? element.attributes[spellings.removeAttribute]?.trim()
    : undefined;
  if (!name && !removed) {
    return { element: element.name, reason: "names no package" };
  }
  // A removal names the package it takes away.
  if (!name && removed) name = removed;
  const versionElements = spellings.versionElement
    ? element.children.filter((child) => child.name === spellings.versionElement)
    : [];
  // A version that applies only under a condition is a version the reader
  // cannot choose.
  const conditionalVersion = versionElements.some((child) =>
    Boolean(child.attributes["Condition"]?.trim()),
  );
  const versionElement = versionElements[0];
  // A version the manifest offers more than one of is a version the
  // reader cannot choose: a project that pins a version per framework
  // writes it twice.
  if (versionElements.length > 1) {
    return {
      element: element.name,
      ...(name ? { name } : {}),
      ...(updated ? { updated: true } : {}),
      ...(removed ? { removed: true } : {}),
      reason: "is declared with more than one version",
    };
  }
  if (versionElement && versionElement.children.length) {
    return {
      element: element.name,
      ...(name ? { name } : {}),
      reason: "has a version that is not a literal",
    };
  }
  // The child metadata wins over the attribute: MSBuild reads the last
  // spelling of a value, and the child is the later one.
  const attribute = element.attributes[spellings.versionAttribute]?.trim();
  const child = versionElement === undefined ? undefined : versionElement.text.trim();
  // The child metadata wins over the attribute, even when it is empty:
  // the empty value is the value the manifest sets.
  const version = child === undefined ? attribute : child;
  // A name that holds a property reference or an item list is not a
  // package: the build decides what it names, and the manifest does not
  // say.
  if (name && isUnknownTarget(name)) {
    return {
      element: element.name,
      name,
      unknownTarget: true,
      ...(updated ? { updated: true } : {}),
      ...(removed ? { removed: true } : {}),
      reason: "names a package the reader does not read",
    };
  }
  // An excluded item is not a dependency: the build filters it out.
  if (element.attributes["Exclude"]) {
    return {
      element: element.name,
      ...(name ? { name } : {}),
      reason: "is excluded, which is not read",
    };
  }
  // An override is a version the reader does not read, and a condition is
  // a truth the reader cannot know.
  const override =
    Boolean(element.attributes["VersionOverride"]) ||
    element.children.some((child) => child.name === "VersionOverride");
  const conditional =
    inheritedCondition || conditionalVersion || Boolean(element.attributes["Condition"]?.trim());
  return {
    element: element.name,
    ...(name ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(updated ? { updated: true } : {}),
    ...(removed ? { removed: true } : {}),
    ...(conditional ? { conditional: true } : {}),
    ...(override ? { override: true } : {}),
  };
}

/**
 * Reads the packages a NuGet manifest declares.
 *
 * An item that carries no version has no version to compare: a package
 * whose version comes from a central package management file is declared
 * in one file and pinned in another, and the two are read separately.
 */
export function readNuGetItems(root: XmlElement, spellings: NuGetSpellings): NuGetReadResult {
  if (!spellings.roots.includes(root.name)) {
    return { items: [], warnings: [], error: "the document is not the manifest the reader reads" };
  }
  const items: NuGetItem[] = [];
  let error: string | undefined;
  // A declaration sits in a container, and the container may be wrapped
  // in the elements a conditional build wraps it in.
  const inScope = (path: readonly string[]): boolean => {
    if (path.length === 0) return spellings.containers.includes(root.name);
    const holder = path[path.length - 1]!;
    if (!spellings.containers.includes(holder)) return false;
    return path.slice(0, -1).every((name) => spellings.conditions.includes(name));
  };
  const visit = (element: XmlElement, path: readonly string[], conditional: boolean): void => {
    if (path.length > MAX_NESTING) {
      error = "the document is nested too deeply";
      return;
    }
    for (const child of element.children) {
      if (spellings.elements.includes(child.name)) {
        items.push(readItem(child, spellings, inScope(path), conditional));
        continue;
      }
      // A group that applies only under a condition declares its items
      // under that condition too, and so does a branch of a conditional
      // build: only one of the branches runs.
      const childConditional =
        conditional ||
        Boolean(child.attributes["Condition"]?.trim()) ||
        spellings.conditionalScopes.includes(child.name);
      visit(child, [...path, child.name], childConditional);
      if (error) return;
    }
  };
  visit(root, [], false);
  if (error) return { items: [], warnings: [], error };
  return readItems(items);
}

/**
 * Whether a mutation's target names no package the reader can know.
 *
 * An item expression and a wildcard name any number of packages, and the
 * reader cannot say which.
 */
function isUnknownTarget(name: string): boolean {
  return name.includes("$(") || name.includes("@(") || name.includes("*") || name.includes(";");
}

/**
 * The key a package is known by.
 *
 * A NuGet package's identity does not depend on the case it is written
 * in, so an update and a removal find the package they name whatever the
 * case is. The spelling the manifest used is kept for the report.
 */
function identity(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Reads the packages the items declare.
 *
 * An update sets the version a package resolves to, a removal takes it
 * away, and a condition is a truth the reader cannot know: a package
 * whose version depends on one is not read, because the reader cannot say
 * which version the project has.
 */
function readItems(items: readonly NuGetItem[]): NuGetReadResult {
  const warnings: string[] = [];
  const order = [...items];
  const declared = items.filter((item) => !item.removed && !item.updated);
  const updates = items.filter((item) => item.updated && !item.removed);
  const removals = items.filter((item) => item.removed);
  const versions = new Map<string, string | undefined>();
  const ambiguous = new Set<string>();

  // An override is a version the reader does not read, and the package it
  // belongs to is not read either: another declaration or update of the
  // same package may name the version the override replaces.
  for (const item of items) {
    if (!item.name || !item.override) continue;
    const key = identity(item.name);
    if (ambiguous.has(key)) continue;
    warnings.push(`the package ${item.name} has a VersionOverride, which is not read`);
    ambiguous.add(key);
  }

  // The items are read in the order the document writes them: an update
  // sets the version of a package the document has declared already, and
  // an update that comes first has no package to update.
  const sorted = [...declared, ...updates].sort(
    (left, right) => order.indexOf(left) - order.indexOf(right),
  );
  for (const item of sorted) {
    if (!item.name) continue;
    const key = identity(item.name);
    if (ambiguous.has(key)) continue;
    if (item.conditional) {
      warnings.push(`the package ${item.name} is conditional, which is not read`);
      ambiguous.add(key);
      continue;
    }
    if (item.updated) {
      // The update may or may not apply, and the reader cannot say which
      // version the package has.
      if (item.conditional) continue;
      if (item.reason) {
        // The update names a version the reader cannot read, and the
        // version the package had is not the one it has.
        warnings.push(`the package ${item.name} ${item.reason}, which is not read`);
        ambiguous.add(key);
        continue;
      }
      if (!versions.has(key)) continue;
      // An update that carries no version changes the metadata of the
      // declaration, not its version.
      if (item.version !== undefined) versions.set(key, item.version);
      continue;
    }
    // Two declarations of one package that carry different versions are
    // versions the reader cannot choose between: a project that pins a
    // version per framework declares it twice.
    const known = versions.get(key);
    if (known !== undefined && known !== item.version) {
      warnings.push(
        `the package ${item.name} is declared with more than one version, which is not read`,
      );
      ambiguous.add(key);
      continue;
    }
    versions.set(key, item.version);
  }
  const removed = new Set(
    removals
      .map((item) => item.name)
      .filter((name): name is string => Boolean(name))
      .map(identity),
  );
  for (const name of removed) {
    warnings.push(`the package ${name} is removed, which is not read`);
    ambiguous.add(name);
  }
  // A mutation whose target the reader cannot name may touch any package,
  // and the packages it may have touched are not read: the version the
  // manifest has is not the one the reader read.
  const unknownTarget = [...updates, ...removals].filter((item) => item.unknownTarget);
  for (const item of unknownTarget) {
    warnings.push(`a mutation of ${item.name} may touch any package, which is not read`);
    for (const declaration of declared) {
      if (declaration.name) ambiguous.add(identity(declaration.name));
    }
  }

  const read: NuGetItem[] = [];
  for (const item of declared) {
    // An item the reader could not read is reported, and it declares
    // nothing.
    if (item.reason) {
      read.push(item);
      continue;
    }
    if (!item.name) continue;
    const key = identity(item.name);
    if (ambiguous.has(key)) continue;
    const version = versions.get(key);
    if (version === undefined) {
      warnings.push(`the package ${item.name} has no version`);
      continue;
    }
    read.push({ ...item, version });
  }
  // An update that names a package the document does not declare is the
  // version the package resolves to elsewhere, and it is read on its own.
  // Several updates of one package fold into the last one, because that is
  // the version the package has.
  const standalone = new Map<string, NuGetItem>();
  for (const update of updates) {
    if (!update.name) continue;
    const key = identity(update.name);
    if (ambiguous.has(key)) continue;
    if (versions.has(key)) continue;
    // An update that carries no version changes the metadata of the one
    // before it, not its version.
    const known = standalone.get(key);
    standalone.set(key, {
      ...update,
      ...(update.version === undefined && known?.version !== undefined
        ? { version: known.version }
        : {}),
    });
  }
  for (const update of standalone.values()) {
    // An item the reader could not read is reported, and it declares
    // nothing.
    if (update.reason) {
      read.push(update);
      continue;
    }
    if (update.version === undefined || !update.version.length) {
      warnings.push(`the package ${update.name} has no version`);
      continue;
    }
    read.push(update);
  }
  return { items: read, warnings };
}
