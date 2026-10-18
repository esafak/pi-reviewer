import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitEnv } from "../git-env.js";
import { parseLspServers, PI_REVIEWER_LSP_SERVERS_ENV } from "./inputs.js";
import { getLspPreset, getLspPresets, type LspPresetServer } from "./presets.js";

/** Env var pi-lsp reads for its global config dir (`<dir>/lsp.json`). */
export const PI_AGENT_DIR_ENV = "PI_AGENT_DIR";

const MAX_LSP_CONFIG_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** User-supplied per-id overrides (from the trusted default-branch file). */
export type LspServerOverrides = Record<string, Record<string, unknown>>;

/** A pi-lsp file entry. `installHint` is never serialized (see presets.ts). */
export type LspFileServer = Omit<LspPresetServer, "installHint"> & {
  enabled?: boolean;
  exclude?: string[];
  cwd?: string;
  env?: Record<string, string>;
  config?: string;
  maxFileSizeBytes?: number;
  settings?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
};

/**
 * Merges preset defaults with trusted overrides. Overrides win per field;
 * `enabled: false` removes the server. Unknown ids require a full definition
 * (`bin`) — anything less fails fast instead of vanishing inside pi-lsp's
 * silent sanitizing.
 */
export function buildLspServerEntries(
  ids: readonly string[],
  overrides: LspServerOverrides,
): LspFileServer[] {
  const entries: LspFileServer[] = [];
  for (const id of ids) {
    const preset = getLspPreset(id);
    const override = overrides[id];
    if (override?.enabled === false) continue;
    if (!preset) {
      if (!override || typeof override.bin !== "string" || !override.bin.trim()) {
        throw new Error(`Unknown LSP server "${id}" has no config entry with a "bin" field.`);
      }
      entries.push({
        id,
        bin: override.bin.trim(),
        args: "args" in override ? arrayOfStrings(override.args) : [],
        include: "include" in override ? arrayOfStrings(override.include) : [],
        exclude: "exclude" in override ? arrayOfStrings(override.exclude) : [],
        rootMarkers: "rootMarkers" in override ? arrayOfStrings(override.rootMarkers) : [],
        languageIdByExtension: isRecord(override.languageIdByExtension)
          ? recordOfStrings(override.languageIdByExtension)
          : {},
        startupTimeoutMs: numberOr(override.startupTimeoutMs, 45_000),
        diagnosticsWaitMs: numberOr(override.diagnosticsWaitMs, 2000),
        ...optionalSpawnFields(override),
      });
      continue;
    }
    entries.push({
      id: preset.id,
      bin: stringOr(override?.bin, preset.bin),
      args: override && "args" in override ? arrayOfStrings(override.args) : [...preset.args],
      include:
        override && "include" in override ? arrayOfStrings(override.include) : [...preset.include],
      exclude: override && "exclude" in override ? arrayOfStrings(override.exclude) : [],
      rootMarkers:
        override && "rootMarkers" in override
          ? arrayOfStrings(override.rootMarkers)
          : [...preset.rootMarkers],
      languageIdByExtension:
        override && isRecord(override.languageIdByExtension)
          ? recordOfStrings(override.languageIdByExtension)
          : { ...preset.languageIdByExtension },
      startupTimeoutMs: numberOr(override?.startupTimeoutMs, preset.startupTimeoutMs),
      diagnosticsWaitMs: numberOr(override?.diagnosticsWaitMs, preset.diagnosticsWaitMs),
      ...optionalSpawnFields(override ?? {}),
    });
  }
  // Overrides for ids outside the selection are programmer error — fail fast
  // instead of silently ignoring them.
  const selected = new Set(ids);
  for (const id of Object.keys(overrides)) {
    if (!selected.has(id)) {
      throw new Error(
        `LSP config entry "${id}" does not match any selected server (${ids.join(", ")}).`,
      );
    }
  }
  return entries;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected an array of strings.");
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Expected an array of strings.");
  }
  return [...value];
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Expected an object of strings.");
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error("Expected an object of strings.");
    out[key] = entry;
  }
  return out;
}

function stringOr(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a non-empty string.");
  return value;
}

function numberOr(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Expected a positive number.");
  }
  return value;
}

/**
 * Optional pi-lsp spawn fields passed through untouched: cwd, env, config
 * path, file-size cap, settings, and initialization options. Only trusted
 * (default-branch) overrides ever reach here — PR-head config is rejected at
 * load time — so no untrusted-process-starting values can arrive.
 */
function optionalSpawnFields(override: Record<string, unknown>): {
  cwd?: string;
  env?: Record<string, string>;
  config?: string;
  maxFileSizeBytes?: number;
  settings?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
} {
  return {
    ...(typeof override.cwd === "string" ? { cwd: override.cwd } : {}),
    ...(isRecord(override.env) ? { env: recordOfStrings(override.env) } : {}),
    ...(typeof override.config === "string" ? { config: override.config } : {}),
    ...(typeof override.maxFileSizeBytes === "number"
      ? { maxFileSizeBytes: override.maxFileSizeBytes }
      : {}),
    ...(isRecord(override.settings) ? { settings: override.settings } : {}),
    ...(isRecord(override.initializationOptions)
      ? { initializationOptions: override.initializationOptions }
      : {}),
  };
}

/** Serializes entries to the pi-lsp global config file format. */
export function serializeLspConfig(entries: readonly LspFileServer[]): string {
  return JSON.stringify({ version: 1, servers: entries }, null, 2);
}

/** Writes the trusted config into an isolated agent dir. Never the checkout. */
export async function writeTrustedLspConfig(
  agentDir: string,
  entries: readonly LspFileServer[],
): Promise<string> {
  await mkdir(agentDir, { recursive: true });
  const filePath = path.join(agentDir, "lsp.json");
  await writeFile(filePath, `${serializeLspConfig(entries)}\n`, "utf8");
  return filePath;
}

/**
 * Sets `PI_AGENT_DIR` for the calling process, returning the previous value
 * (possibly undefined) for `restoreAgentDir`. pi-lsp has no other config
 * root, so this single variable isolates trusted global config, the trust
 * store, and all runtime state for the lifetime of a review.
 */
export function setAgentDir(agentDir: string): string | undefined {
  const previous = process.env[PI_AGENT_DIR_ENV];
  process.env[PI_AGENT_DIR_ENV] = agentDir;
  return previous;
}

/** Undoes `setAgentDir`, restoring absence when there was none. */
export function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) delete process.env[PI_AGENT_DIR_ENV];
  else process.env[PI_AGENT_DIR_ENV] = previous;
}

/**
 * Runs `fn` with `PI_AGENT_DIR` pointed at an isolated dir, restoring the
 * previous value (or absence) afterwards — even on failure.
 */
export async function withIsolatedAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = setAgentDir(agentDir);
  try {
    return await fn();
  } finally {
    restoreAgentDir(previous);
  }
}

/** Parses the `servers` array out of a pi-lsp config file's text — the same
 * shape pi-lsp itself reads (`{ version, servers: [{ id, ... }] }`). Returns
 * overrides keyed by id. */
export function parseLspOverridesFile(text: string, label: string): LspServerOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Could not parse ${label}: invalid JSON.`);
  }
  if (!isRecord(parsed))
    throw new Error(`Could not parse ${label}: top-level value must be an object.`);
  const { servers } = parsed;
  if (servers === undefined) return {};
  if (!Array.isArray(servers))
    throw new Error(`Could not parse ${label}: "servers" must be an array.`);
  const overrides: LspServerOverrides = {};
  for (const item of servers) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      throw new Error(
        `Could not parse ${label}: every server entry must be an object with a non-empty "id".`,
      );
    }
    const id = item.id;
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (key !== "id") rest[key] = value;
    }
    overrides[id] = rest;
  }
  return overrides;
}

/**
 * Single entry point for LSP setup: parses the `lsp-servers` selection
 * (custom ids come from the trusted overrides) and merges presets with
 * overrides. Non-comment targets get no servers. The caller writes the
 * result with `writeTrustedLspConfig`.
 */
export function resolveLspEntries(
  target: string,
  rawServers: string | undefined,
  overrides: LspServerOverrides,
): LspFileServer[] {
  if (target !== "comment") return [];
  const selection = parseLspServers(
    rawServers ?? process.env[PI_REVIEWER_LSP_SERVERS_ENV],
    Object.keys(overrides),
  );
  if (selection.disabled) return [];
  return buildLspServerEntries(selection.ids, overrides);
}

function validateRepoRelativePath(rawPath: string, label: string): string {
  const filePath = rawPath.trim();
  const segments = filePath.split("/");
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    path.posix.normalize(filePath) !== filePath
  ) {
    throw new Error(`${label} must be a normalized repository-relative path`);
  }
  return filePath;
}

/**
 * Reads the LSP overrides file from the trusted default-branch revision —
 * never from the PR checkout, where it would be attacker-controlled.
 * Mirrors loadMcpConfigFromBase (same size cap, same git hygiene).
 */
export function loadLspOverridesFromBase(
  repoRoot: string,
  baseSha: string,
  rawPath: string | undefined,
): LspServerOverrides {
  if (!rawPath?.trim()) return {};
  if (!/^[a-f0-9]{40}$/i.test(baseSha))
    throw new Error("Cannot load lsp-config-file: invalid default branch SHA");
  const label = "lsp-config-file";
  const filePath = validateRepoRelativePath(rawPath, label);
  let text: string;
  try {
    text = execFileSync("git", ["show", `${baseSha}:${filePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: MAX_LSP_CONFIG_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOBUFS")
      throw new Error("lsp-config-file exceeds the 256 KiB limit");
    throw new Error("Could not load lsp-config-file from the trusted default branch revision");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_LSP_CONFIG_BYTES) {
    throw new Error("lsp-config-file exceeds the 256 KiB limit");
  }
  return parseLspOverridesFile(text, label);
}

export function presetInstallHint(id: string): string | undefined {
  return getLspPresets().find((preset) => preset.id === id)?.installHint;
}
