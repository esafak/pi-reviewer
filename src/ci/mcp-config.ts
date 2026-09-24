import { execFileSync } from "node:child_process";
import path from "node:path";

const MAX_MCP_CONFIG_BYTES = 256 * 1024;

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
    if (definition.auth !== undefined && definition.auth !== false && definition.auth !== "bearer")
      throw new Error(`${label} contains an unsupported MCP authentication mode`);
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
    });
  } catch {
    throw new Error("Cannot load MCP config: invalid repository default branch");
  }

  const remoteRef = `refs/remotes/origin/${trimmed}`;
  try {
    execFileSync(
      "git",
      [...gitAuthArgs, "fetch", "--no-tags", "origin", `+refs/heads/${trimmed}:${remoteRef}`],
      { cwd: repoRoot, stdio: "ignore" },
    );
    return execFileSync("git", ["rev-parse", "--verify", `${remoteRef}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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
