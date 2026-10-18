import { LSP_PRESET_IDS, getLspPresets } from "./presets.js";

export const PI_REVIEWER_LSP_SERVERS_ENV = "PI_REVIEWER_LSP_SERVERS";
export const PI_REVIEWER_LSP_CONFIG_FILE_ENV = "PI_REVIEWER_LSP_CONFIG_FILE";

/** `'none'` disables LSP entirely, restoring pre-LSP behavior. */
export const LSP_SERVERS_NONE = "none";

export type LspServerSelection = { disabled: true } | { disabled: false; ids: string[] };

/**
 * Parses the `lsp-servers` input (or its env equivalent). Unset/blank means
 * the best-effort default: every preset server. `extraIds` are trusted
 * config-file ids, accepted alongside presets so custom servers are
 * selectable; unknown ids without a trusted definition fail fast at build
 * time. `none` disables LSP entirely.
 */
export function parseLspServers(
  raw: string | undefined,
  extraIds: readonly string[] = [],
): LspServerSelection {
  const value = (raw ?? "").trim();
  if (value === "") return { disabled: false, ids: [...LSP_PRESET_IDS] };
  if (value.toLowerCase() === LSP_SERVERS_NONE) return { disabled: true };
  const ids = value
    .split(/[\n,]/)
    .map((id) => id.trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  const known = new Set([...getLspPresets().map((preset) => preset.id), ...extraIds]);
  for (const id of unique) {
    if (!known.has(id)) {
      throw new Error(
        `Unknown LSP server "${id}". Expected one of: ${[...known].join(", ")}, or "${LSP_SERVERS_NONE}" to disable LSP.`,
      );
    }
  }
  return { disabled: false, ids: unique };
}
