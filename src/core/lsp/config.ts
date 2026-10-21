import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitEnv } from "../git-env.js";
import {
  parseLspServers,
  PI_REVIEWER_LSP_SERVERS_ENV,
  type LspEnabledSelection,
} from "./inputs.js";
import { getLspCandidate, getLspGroups, type LspCandidate, type LspGroup } from "./presets.js";

/** Env var pi-lsp reads for its global config dir (`<dir>/lsp.json`). */
export const PI_AGENT_DIR_ENV = "PI_AGENT_DIR";

const MAX_LSP_CONFIG_BYTES = 256 * 1024;

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_DIAGNOSTICS_WAIT_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** User-supplied per-id overrides (from the trusted default-branch file). */
export type LspServerOverrides = Record<string, Record<string, unknown>>;

/** A pi-lsp file entry — the shape written into lsp.json. */
export interface LspFileServer {
  id: string;
  bin: string;
  args: string[];
  include: string[];
  exclude?: string[];
  rootMarkers: string[];
  languageIdByExtension: Record<string, string>;
  startupTimeoutMs: number;
  diagnosticsWaitMs: number;
  cwd?: string;
  env?: Record<string, string>;
  config?: string;
  maxFileSizeBytes?: number;
  settings?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
}

/** One language group with the candidate servers that may serve it. */
export interface LspGroupPlan {
  group: LspGroup;
  /** Effective candidate entries, in preference order. */
  candidates: LspFileServer[];
}

/** Everything the review needs to know about the LSP setup, before probing. */
export interface LspPlan {
  disabled: boolean;
  groups: LspGroupPlan[];
  /** Config-file servers outside every group; they run as defined. */
  custom: LspFileServer[];
}

function emptyPlan(): LspPlan {
  return { disabled: true, groups: [], custom: [] };
}

/**
 * Merges group defaults, the candidate's own fields, and trusted overrides
 * into the entry pi-lsp will run. Overrides win per field.
 */
function candidateEntry(
  group: LspGroup,
  candidate: LspCandidate,
  override: Record<string, unknown> | undefined,
): LspFileServer {
  return {
    id: candidate.id,
    bin: stringOr(override?.bin, candidate.bin),
    args: override && "args" in override ? arrayOfStrings(override.args) : [...candidate.args],
    include:
      override && "include" in override ? arrayOfStrings(override.include) : [...group.include],
    exclude: override && "exclude" in override ? arrayOfStrings(override.exclude) : undefined,
    rootMarkers:
      override && "rootMarkers" in override
        ? arrayOfStrings(override.rootMarkers)
        : [...group.rootMarkers],
    languageIdByExtension:
      override && isRecord(override.languageIdByExtension)
        ? recordOfStrings(override.languageIdByExtension)
        : { ...group.languageIdByExtension },
    startupTimeoutMs: numberOr(override?.startupTimeoutMs, candidate.startupTimeoutMs),
    diagnosticsWaitMs: numberOr(override?.diagnosticsWaitMs, candidate.diagnosticsWaitMs),
    ...optionalSpawnFields(override ?? {}),
  };
}

/**
 * A config-file server outside every group. It needs a full definition
 * (`bin`) — anything less fails fast instead of vanishing inside pi-lsp's
 * silent sanitizing.
 */
function customEntry(id: string, override: Record<string, unknown>): LspFileServer {
  if (typeof override.bin !== "string" || !override.bin.trim()) {
    throw new Error(`Unknown LSP server "${id}" has no config entry with a "bin" field.`);
  }
  return {
    id,
    bin: override.bin.trim(),
    args: "args" in override ? arrayOfStrings(override.args) : [],
    include: "include" in override ? arrayOfStrings(override.include) : [],
    exclude: "exclude" in override ? arrayOfStrings(override.exclude) : undefined,
    rootMarkers: "rootMarkers" in override ? arrayOfStrings(override.rootMarkers) : [],
    languageIdByExtension: isRecord(override.languageIdByExtension)
      ? recordOfStrings(override.languageIdByExtension)
      : {},
    startupTimeoutMs: numberOr(override.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS),
    diagnosticsWaitMs: numberOr(override.diagnosticsWaitMs, DEFAULT_DIAGNOSTICS_WAIT_MS),
    ...optionalSpawnFields(override),
  };
}

/**
 * Turns a selection plus trusted overrides into the servers to probe.
 *
 * Each language group contributes its candidates in preference order; a
 * pinned group contributes only the named ones. A group-level override
 * (`{"id": "python", "enabled": false}`) switches that language off, and a
 * candidate-level `enabled: false` drops that candidate so the group falls
 * back to the next one.
 */
export function buildLspPlan(
  selection: LspEnabledSelection,
  overrides: LspServerOverrides,
): LspPlan {
  const groups: LspGroupPlan[] = [];
  const custom: LspFileServer[] = [];
  const consumed = new Set<string>();

  for (const group of getLspGroups()) {
    const groupOverride = overrides[group.id];
    if (groupOverride) {
      consumed.add(group.id);
      const fields = Object.keys(groupOverride).filter((field) => field !== "enabled");
      if (fields.length > 0) {
        throw new Error(
          `LSP config entry "${group.id}" may only set "enabled"; per-server fields belong on a candidate id.`,
        );
      }
    }
    const groupEnabled = groupOverride?.enabled !== false;
    const pinnedIds = selection.pinned[group.id];
    if (!groupEnabled && pinnedIds) {
      throw new Error(
        `lsp-servers pins ${group.id} to ${pinnedIds.join(", ")}, but lsp-config-file switches ${group.id} off.`,
      );
    }
    const candidates: LspFileServer[] = [];
    const disabled: string[] = [];
    for (const candidateId of group.candidates) {
      const candidate = getLspCandidate(candidateId);
      if (!candidate) throw new Error(`Unknown LSP candidate "${candidateId}".`);
      const override = overrides[candidateId];
      // A built-in candidate is never a custom server, whatever the group
      // does with it: consuming it here keeps a disabled language from
      // reappearing as an unnamed server.
      if (override) consumed.add(candidateId);
      if (!groupEnabled) continue;
      if (override?.enabled === false) {
        disabled.push(candidateId);
        continue;
      }
      if (pinnedIds && !pinnedIds.includes(candidateId)) {
        // The group was pinned to other candidates: this override configures
        // a server that will not run.
        continue;
      }
      candidates.push(candidateEntry(group, candidate, override));
    }
    if (pinnedIds && candidates.length === 0) {
      throw new Error(
        `lsp-servers pins ${group.id} to ${pinnedIds.join(", ")}, but lsp-config-file disables ${disabled.join(", ")}.`,
      );
    }
    if (!groupEnabled) continue;
    groups.push({ group, candidates });
  }

  // Config-file servers outside every group are custom servers: they need a
  // full definition and always run, whatever the selection pinned.
  for (const [id, override] of Object.entries(overrides)) {
    if (consumed.has(id)) continue;
    if (override.enabled === false) continue;
    custom.push(customEntry(id, override));
  }

  return { disabled: false, groups, custom };
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
 * (custom ids come from the trusted overrides) and merges group defaults,
 * candidate fields, and overrides. Non-comment targets get no servers. The
 * caller probes the plan, picks one server per group, and writes the result
 * with `writeTrustedLspConfig`.
 */
export function resolveLspPlan(
  target: string,
  rawServers: string | undefined,
  overrides: LspServerOverrides,
): LspPlan {
  if (target !== "comment") return emptyPlan();
  const selection = parseLspServers(
    rawServers ?? process.env[PI_REVIEWER_LSP_SERVERS_ENV],
    Object.keys(overrides),
  );
  if (selection.disabled) return emptyPlan();
  return buildLspPlan(selection, overrides);
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

/** The install hint of a built-in candidate, if it has one. */
export function lspInstallHint(id: string): string | undefined {
  return getLspCandidate(id)?.installHint;
}
