/**
 * The aqua standard registry.
 *
 * The registry describes each recipe it publishes in a file of its own, and
 * the recipe names the repository the package is released from. The
 * standard registry is the one aqua falls back to, and it is the only one
 * the harness reads: a recipe in a registry the harness cannot place is a
 * recipe it cannot resolve, and the harness never substitutes a different
 * project for one it could not identify.
 */

/** The owner of the aqua standard registry. */
export const AQUA_STANDARD_OWNER = "aquaproj";

/** The name of the aqua standard registry. */
export const AQUA_STANDARD_REPOSITORY = "aqua-registry";

/** The path the standard registry's file has inside its repository. */
export const AQUA_STANDARD_PATH = "registry.yaml";

/** The URL of the aqua standard registry. */
export const AQUA_STANDARD_URL = `https://github.com/${AQUA_STANDARD_OWNER}/${AQUA_STANDARD_REPOSITORY}`;

/** The fields an aqua registry declaration carries. */
export interface AquaRegistryDeclaration {
  /** The registry's type. */
  type?: string;
  /** The repository's owner. */
  owner?: string;
  /** The repository's name. */
  repository?: string;
  /** The path within the repository where the registry's recipes live. */
  path?: string;
}

/**
 * The effective source of an aqua registry declaration.
 *
 * A declaration leaves out the fields it does not change, and aqua's
 * defaults fill them in: the standard registry's type, owner, and
 * repository, and the path its registry file has inside that repository. A
 * field that is written empty is a field that is left out, so the default
 * applies to it too.
 */
export function aquaRegistrySource(declaration: AquaRegistryDeclaration): AquaRegistryDeclaration {
  const type = (declaration.type ?? "").trim() || "standard";
  const owner = (declaration.owner ?? "").trim() || AQUA_STANDARD_OWNER;
  const repository = (declaration.repository ?? "").trim() || AQUA_STANDARD_REPOSITORY;
  const path = (declaration.path ?? "").trim() || AQUA_STANDARD_PATH;
  return { type, owner, repository, path };
}

/**
 * Whether a registry declaration names the standard registry.
 *
 * The standard registry's type is the one aqua calls `github_content`, so
 * a declaration that says `standard` and one that says `github_content`
 * name the same registry when the rest of the declaration agrees.
 */
export function isAquaStandardRegistry(declaration: AquaRegistryDeclaration): boolean {
  const source = aquaRegistrySource(declaration);
  const type = source.type === "standard" ? "github_content" : source.type;
  return (
    type === "github_content" &&
    source.owner === AQUA_STANDARD_OWNER &&
    source.repository === AQUA_STANDARD_REPOSITORY &&
    source.path === AQUA_STANDARD_PATH
  );
}
