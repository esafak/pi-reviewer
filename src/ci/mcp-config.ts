import { execFileSync } from "node:child_process";
import path from "node:path";

const MAX_MCP_CONFIG_BYTES = 256 * 1024;

// Repo-location variables git exports into hook processes (notably GIT_DIR)
// would redirect these repoRoot-scoped commands at the hook's repository,
// so every git invocation below runs with them removed.
export const GIT_LOCATION_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR",
] as const;

/**
 * Argument names whose values may be disclosed in the review logs, such as
 * the argument that names a repository. The declaration is per server: what
 * one server's arguments carry is that server owner's call, not the
 * harness's.
 */
export const MAX_MCP_LOGGABLE_ARGS = 20;
const LOGGABLE_ARG_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function parseLoggableArgs(value: unknown, serverName: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`MCP config server "${serverName}" loggableArgs must be an array`);
  if (value.length > MAX_MCP_LOGGABLE_ARGS)
    throw new Error(
      `MCP config server "${serverName}" loggableArgs must list at most ${MAX_MCP_LOGGABLE_ARGS} arguments`,
    );
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !LOGGABLE_ARG_NAME_PATTERN.test(entry))
      throw new Error(
        `MCP config server "${serverName}" loggableArgs entries must be argument names`,
      );
    if (!names.includes(entry)) names.push(entry);
  }
  return names;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV_VARS) delete env[key];
  return env;
}

export interface CiMcpConfig {
  mcpServers: Record<string, Record<string, unknown>>;
  settings?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function isEnvironmentReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function isCredentialField(name: string): boolean {
  return /authorization|api[-_]?key|(?:^|[-_])key(?:$|[-_])|token|secret|credential|password|passphrase|cookie/i.test(
    name,
  );
}

function validateCredentialReferences(
  record: Record<string, unknown>,
  label: string,
  field: string,
): void {
  for (const [name, value] of Object.entries(record)) {
    if (isCredentialField(name) && (typeof value !== "string" || !isEnvironmentReference(value)))
      throw new Error(
        `${label} credential ${field} "${name}" must reference an environment variable`,
      );
  }
}

export function validateMcpConfig(value: unknown, label = "MCP config"): CiMcpConfig {
  if (!isRecord(value) || !isRecord(value.mcpServers))
    throw new Error(`${label} must contain an mcpServers object`);
  const unsupportedKey = Object.keys(value).find(
    (key) => key !== "mcpServers" && key !== "settings",
  );
  if (unsupportedKey)
    throw new Error(`${label} contains unsupported config key "${unsupportedKey}"`);

  const entries = Object.entries(value.mcpServers);
  if (entries.length === 0) throw new Error(`${label} must configure at least one MCP server`);
  for (const [name, definition] of entries) {
    if (!name.trim() || !isRecord(definition))
      throw new Error(`${label} contains an invalid MCP server definition`);
    if (typeof definition.url === "string") {
      const authority = definition.url.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/)?.[1];
      if (authority?.includes("@"))
        throw new Error(`${label} server URL must not contain embedded credentials`);
    }
    if (
      definition.auth === "oauth" ||
      (definition.oauth !== undefined && definition.oauth !== false)
    )
      throw new Error(`${label} does not support OAuth servers in unattended CI`);
    if (
      typeof definition.bearerToken === "string" &&
      !/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|env:[A-Za-z_][A-Za-z0-9_]*)$/.test(definition.bearerToken)
    )
      throw new Error(`${label} bearerToken must reference an environment variable`);
    if (
      definition.bearerTokenEnv !== undefined &&
      (typeof definition.bearerTokenEnv !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(definition.bearerTokenEnv))
    )
      throw new Error(`${label} bearerTokenEnv must be an environment variable name`);
    if (isRecord(definition.headers))
      validateCredentialReferences(definition.headers, label, "header");
    if (isRecord(definition.env)) validateCredentialReferences(definition.env, label, "env value");
    if (definition.auth !== undefined && definition.auth !== false && definition.auth !== "bearer")
      throw new Error(`${label} contains an unsupported MCP authentication mode`);
    // Validated here so an invalid declaration fails the run loudly.
    parseLoggableArgs(definition.loggableArgs, name);
  }
  if (value.settings !== undefined && !isRecord(value.settings))
    throw new Error(`${label} settings must be an object`);
  if (
    isRecord(value.settings) &&
    Array.isArray(value.settings.agentPluginPaths) &&
    value.settings.agentPluginPaths.length > 0
  )
    throw new Error(`${label} does not support settings.agentPluginPaths in CI`);

  return {
    mcpServers: value.mcpServers as Record<string, Record<string, unknown>>,
    ...(isRecord(value.settings) ? { settings: value.settings } : {}),
  };
}

export function parseMcpConfigJson(text: string, label = "MCP config"): CiMcpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return validateMcpConfig(parsed, label);
}

export function resolveDefaultBranchSha(
  repoRoot: string,
  branch: string,
  gitAuthArgs: string[] = [],
): string {
  const trimmed = branch.trim();
  if (!trimmed || trimmed.startsWith("-") || hasControlCharacters(trimmed))
    throw new Error("Cannot load MCP config: invalid repository default branch");
  try {
    execFileSync("git", ["check-ref-format", "--branch", trimmed], {
      cwd: repoRoot,
      stdio: "ignore",
      env: gitEnv(),
    });
  } catch {
    throw new Error("Cannot load MCP config: invalid repository default branch");
  }

  const remoteRef = `refs/remotes/origin/${trimmed}`;
  try {
    execFileSync(
      "git",
      [...gitAuthArgs, "fetch", "--no-tags", "origin", `+refs/heads/${trimmed}:${remoteRef}`],
      { cwd: repoRoot, stdio: "ignore", env: gitEnv() },
    );
    return execFileSync("git", ["rev-parse", "--verify", `${remoteRef}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    }).trim();
  } catch {
    throw new Error("Could not resolve the repository default branch for MCP config");
  }
}

function validateRepoRelativePath(rawPath: string): string {
  const filePath = rawPath.trim();
  const segments = filePath.split("/");
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    hasControlCharacters(filePath) ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    path.posix.normalize(filePath) !== filePath
  )
    throw new Error("mcp-config-file must be a normalized repository-relative path");
  return filePath;
}

export function loadMcpConfigFromBase(
  repoRoot: string,
  baseSha: string,
  rawPath: string | undefined,
): CiMcpConfig | undefined {
  if (!rawPath?.trim()) return undefined;
  if (!/^[a-f0-9]{40}$/i.test(baseSha))
    throw new Error("Cannot load MCP config: invalid default branch SHA");
  const filePath = validateRepoRelativePath(rawPath);

  let text: string;
  try {
    text = execFileSync("git", ["show", `${baseSha}:${filePath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: MAX_MCP_CONFIG_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnv(),
    });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOBUFS")
      throw new Error("mcp-config-file exceeds the 256 KiB limit");
    throw new Error("Could not load mcp-config-file from the trusted default branch revision");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MCP_CONFIG_BYTES)
    throw new Error("mcp-config-file exceeds the 256 KiB limit");
  return parseMcpConfigJson(text, "mcp-config-file");
}
