import type { DiffShard } from "../core/diff-filter.js";
import type { MinSeverity } from "../core/prompt-builder.js";
import type { ThinkingLevel } from "../core/config.js";
import type { LspFileServer } from "../core/lsp/config.js";
import type { CiMcpConfig } from "./mcp-config.js";

export interface ShardRequest {
  index: number;
  total: number;
  cwd: string;
  shard: DiffShard;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  minSeverity: MinSeverity;
  debug: boolean;
  tools: {
    lspEntries: LspFileServer[];
    lspEnabled: boolean;
    mcpConfig?: CiMcpConfig;
    mcpServerCwd?: string;
    citationOffset: number;
  };
  tracing: { artifactPath: string } | null;
}

export interface ShardMcpFailure {
  identity: { server?: string; tool: string };
  signal: { errorClass: string; detail?: string };
  repoIds: string[];
  unindexed: boolean;
}

export interface ShardEnvelope {
  index: number;
  status: "ok" | "error";
  decision: "review" | "none";
  result?: unknown;
  evidence?: unknown;
  mcpFailures?: ShardMcpFailure[];
  error?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiffShard(value: unknown): value is DiffShard {
  return (
    record(value) &&
    typeof value.diff === "string" &&
    Array.isArray(value.files) &&
    value.files.every((file) => typeof file === "string")
  );
}

export function isShardRequest(value: unknown): value is ShardRequest {
  if (!record(value) || !record(value.tools)) return false;
  const tools = value.tools;
  const tracing = value.tracing;
  return (
    Number.isInteger(value.index) &&
    Number.isInteger(value.total) &&
    typeof value.cwd === "string" &&
    isDiffShard(value.shard) &&
    typeof value.systemPrompt === "string" &&
    typeof value.userPrompt === "string" &&
    typeof value.model === "string" &&
    typeof value.thinkingLevel === "string" &&
    typeof value.minSeverity === "string" &&
    typeof value.debug === "boolean" &&
    Array.isArray(tools.lspEntries) &&
    typeof tools.lspEnabled === "boolean" &&
    Number.isInteger(tools.citationOffset) &&
    (tools.mcpConfig === undefined || record(tools.mcpConfig)) &&
    (tools.mcpServerCwd === undefined || typeof tools.mcpServerCwd === "string") &&
    (tracing === null || (record(tracing) && typeof tracing.artifactPath === "string"))
  );
}

export function isShardEnvelope(value: unknown): value is ShardEnvelope {
  if (
    !record(value) ||
    !Number.isInteger(value.index) ||
    (value.status !== "ok" && value.status !== "error") ||
    (value.decision !== "review" && value.decision !== "none")
  )
    return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (
    value.mcpFailures !== undefined &&
    (!Array.isArray(value.mcpFailures) ||
      !value.mcpFailures.every(
        (failure) =>
          record(failure) &&
          record(failure.identity) &&
          typeof failure.identity.tool === "string" &&
          (failure.identity.server === undefined || typeof failure.identity.server === "string") &&
          record(failure.signal) &&
          typeof failure.signal.errorClass === "string" &&
          (failure.signal.detail === undefined || typeof failure.signal.detail === "string") &&
          Array.isArray(failure.repoIds) &&
          failure.repoIds.every((id) => typeof id === "string") &&
          typeof failure.unindexed === "boolean",
      ))
  )
    return false;
  return true;
}
