import { LSP_CANDIDATE_IDS, getLspGroups, isLspGroupId, type LspGroupId } from "./presets.js";

export const PI_REVIEWER_LSP_SERVERS_ENV = "PI_REVIEWER_LSP_SERVERS";
export const PI_REVIEWER_LSP_CONFIG_FILE_ENV = "PI_REVIEWER_LSP_CONFIG_FILE";

/** `'none'` disables LSP entirely, restoring pre-LSP behavior. */
export const LSP_SERVERS_NONE = "none";

/**
 * The `lsp-servers` selection. Named ids pin a language group to those
 * candidates; a group nobody named keeps its own preference order, so an
 * explicit list narrows one language without switching the others off.
 */
export type LspEnabledSelection = {
  disabled: false;
  pinned: Partial<Record<LspGroupId, readonly string[]>>;
};

export type LspServerSelection = { disabled: true } | LspEnabledSelection;

/**
 * Parses the `lsp-servers` input (or its env equivalent). Unset/blank means
 * the best-effort default: every language group, each serving itself with
 * the installed candidate that covers the most changed files. Named ids pin
 * their language group to those candidates (in the group's own preference
 * order), and `extraIds` are trusted config-file ids, accepted alongside the
 * built-in ones so custom servers stay selectable; unknown ids without a
 * trusted definition fail fast at build time. `none` disables LSP entirely.
 */
export function parseLspServers(
  raw: string | undefined,
  extraIds: readonly string[] = [],
): LspServerSelection {
  const value = (raw ?? "").trim();
  if (value === "") return { disabled: false, pinned: {} };
  if (value.toLowerCase() === LSP_SERVERS_NONE) return { disabled: true };
  const ids = value
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  const known = new Set([...LSP_CANDIDATE_IDS, ...extraIds]);
  for (const id of unique) {
    // A language id configures a language (switching it off) in the config
    // file; it never names a server to run.
    if (isLspGroupId(id)) {
      const language = getLspGroups().find((group) => group.id === id);
      throw new Error(
        `"${id}" is a language, not a server. Name a server id to pin it (${language?.candidates.join(", ")}), or switch the language off in lsp-config-file.`,
      );
    }
    if (!known.has(id)) {
      throw new Error(
        `Unknown LSP server "${id}". Expected one of: ${[...known].join(", ")}, or "${LSP_SERVERS_NONE}" to disable LSP.`,
      );
    }
  }
  // Pin per language, keeping the built-in preference order among the named
  // ids: naming two candidates of one language does not reorder them.
  const pinned: Partial<Record<LspGroupId, readonly string[]>> = {};
  for (const group of getLspGroups()) {
    const named = group.candidates.filter((candidate) => unique.includes(candidate));
    if (named.length > 0) pinned[group.id] = named;
  }
  return { disabled: false, pinned };
}
