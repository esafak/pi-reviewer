/**
 * The repositories that publish the tools no registry describes.
 *
 * A runtime pin names a program, not a package: `python = "3.12"` says
 * nothing about where CPython lives. The table answers that question for the
 * core runtimes and the common tools.
 *
 * The table is keyed by both the mise tool name and the asdf plugin name,
 * because an asdf plugin's repository is the *installer* rather than the
 * tool — `asdf-nodejs` is not Node.js — so the plugin name maps to the
 * tool's own repository.
 */
export const TOOL_SOURCE_TABLE: Readonly<Record<string, string>> = {
  node: "nodejs/node",
  python: "python/cpython",
  go: "golang/go",
  rust: "rust-lang/rust",
  java: "openjdk/jdk",
  ruby: "ruby/ruby",
  pnpm: "pnpm/pnpm",
  nodejs: "nodejs/node",
  golang: "golang/go",
};

/**
 * The repository that publishes a tool, if the table knows it.
 *
 * A tool the table does not cover is unresolved. The harness never
 * substitutes a different project for one it could not identify.
 */
export function findToolSource(toolName: string): string | undefined {
  const identity = toolName.trim().toLowerCase();
  if (!identity.length) return undefined;
  // The table is a plain object, so an inherited property is not an entry.
  if (!Object.hasOwn(TOOL_SOURCE_TABLE, identity)) return undefined;
  return TOOL_SOURCE_TABLE[identity];
}
