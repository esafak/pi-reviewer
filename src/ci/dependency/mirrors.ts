import type { PackageRegistry } from "../../core/dependency/types.js";

/**
 * A GitHub repository that publishes the same project as a known upstream.
 *
 * The entry is keyed by the upstream's **own identity**, not by its host: a
 * host-wide substitution is not safe. `go.googlesource.com/protobuf` serves
 * `google.golang.org/protobuf`, whose GitHub home is
 * `protocolbuffers/protobuf-go`, while `github.com/golang/protobuf` is a
 * different, deprecated module — a generic rule would have sent the model to
 * the wrong project.
 */
export interface MirrorEntry {
  /** The registry the identity belongs to. */
  readonly registry: PackageRegistry;
  /** The upstream identity, as the manifest writes it. */
  readonly upstream: string;
  /** The GitHub repository that publishes the same project. */
  readonly repository: string;
}

/**
 * The curated mirror table.
 *
 * Every entry is reviewed by hand. The table is an optimization for the
 * cases where a GitHub repository is materially easier for the model to
 * navigate, not a requirement: an upstream the table does not cover becomes a
 * URL candidate, which the bounded reader opens directly.
 */
export const MIRROR_TABLE: readonly MirrorEntry[] = [
  { registry: "go", upstream: "golang.org/x/net", repository: "github.com/golang/net" },
  {
    registry: "go",
    upstream: "google.golang.org/protobuf",
    repository: "github.com/protocolbuffers/protobuf-go",
  },
];

/**
 * Normalizes an identity for the lookup.
 *
 * A `.git` suffix and a trailing slash are spelling, not identity, and
 * either may come last. Nothing else is stripped: a nested path names a
 * different project, and treating it as the parent would send the model to
 * the wrong repository.
 */
function normalizeIdentity(identity: string): string {
  let value = identity.trim();
  while (value.endsWith("/")) value = value.slice(0, -1);
  while (value.endsWith(".git")) value = value.slice(0, -".git".length);
  return value;
}

/**
 * The GitHub repository that mirrors an upstream, if the table covers it.
 *
 * The lookup uses the same identity the source cache uses — the registry and
 * the package name — and never the source URL, because the URL is what the
 * lookup is trying to replace.
 */
export function findMirror(registry: PackageRegistry, packageName: string): string | undefined {
  const identity = normalizeIdentity(packageName);
  if (!identity.length) return undefined;
  const entry = MIRROR_TABLE.find(
    (candidate) => candidate.registry === registry && candidate.upstream === identity,
  );
  return entry?.repository;
}
