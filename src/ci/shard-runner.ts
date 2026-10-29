import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ShardFinding, DigestEntry } from "../core/shard-tool.js";
import type { FindingUpdate } from "../core/output.js";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { createReviewTool } from "../core/review-tool.js";
import { createOverviewTool } from "../core/shard-tool.js";
import { createShardTool } from "../core/shard-tool.js";
import { createSearchClient } from "./search/client.js";
import { resolveSearchConfig, unavailableSearchWarnings } from "./search/config.js";
import { createSearchTools } from "./search/tool.js";
import { createRegistryTools } from "./registry/tool.js";
import {
  resolveGitHubResearchConfig,
  unavailableGitHubResearchWarnings,
} from "./github-research/config.js";
import { createGitHubResearchTools } from "./github-research/tool.js";
import { probeGhCli } from "./github-research/gh-runner.js";
import { resolveCodeExecConfig } from "./code-exec/config.js";
import { createCodeExecTools } from "./code-exec/tool.js";
import {
  describeToolResult,
  extractMcpContentExcerpt,
  extractMcpErrorSignal,
  extractMcpRepositoryIds,
  extractMcpToolIdentity,
  formatDebugToolArgs,
  FORCED_SUBMIT_TOOL,
  isAssistantMessage,
  isThinkingContentPart,
  isUnindexedRejection,
  type McpFailureEntry,
  sanitizeMcpDebugName,
  mcpOutputArtifactDirectory,
  SUBMIT_NUDGE,
  type McpToolIdentity,
} from "./review.js";
import { loadPiLspExtension, partitionExtensionTools } from "../core/lsp/extension.js";
import { restoreAgentDir, setAgentDir, writeTrustedLspConfig } from "../core/lsp/config.js";
import { KNOWN_CI_TOOL_NAMES, LSP_TOOL_NAMES, MCP_TOOL_NAME } from "./tool-names.js";
import type { CiMcpConfig } from "./mcp-config.js";

interface ShardMcpAdapterOptions {
  config: CiMcpConfig;
}
import type { ShardEnvelope, ShardMcpFailure, ShardRequest } from "./shard-protocol.js";
import type { ReviewDecision } from "../core/review-tool.js";
import type { SearchCitation } from "./search/types.js";
import { extractLastAssistantText, type OutputTarget } from "../core/output.js";
import type { Logger } from "../logging/index.js";
import type { ThinkingLevel } from "../core/config.js";
import type { LspFileServer } from "../core/lsp/config.js";

export interface ShardRuntime {
  logger: Logger;
  getApiKey: () => Promise<string>;
  githubToken?: string;
}

export interface ShardRunOptions {
  target: OutputTarget;
  suppressCodeExec: boolean;
}

export interface ShardReviewResult {
  decision: ReviewDecision | ShardToolDecision;
  evidence: readonly SearchCitation[] | undefined;
  mcpFailures: Map<string, McpFailureEntry>;
  requiredSearchFailed: boolean;
}
export type ShardToolDecision = {
  action: "none" | "review";
  result: { findings: ShardFinding[]; finding_updates: FindingUpdate[]; digest: DigestEntry[] };
};

/** MCP verdicts for the wire: computed attribution without raw excerpts. */
export function toShardVerdicts(mcpFailures: Map<string, McpFailureEntry>): ShardMcpFailure[] {
  return [...mcpFailures.values()].map((failure) => ({
    identity: {
      ...(failure.identity.server !== undefined ? { server: failure.identity.server } : {}),
      tool: failure.identity.tool,
    },
    signal: {
      errorClass: failure.signal.errorClass,
      ...(failure.signal.detail !== undefined ? { detail: failure.signal.detail } : {}),
    },
    repoIds: failure.repoIds ?? [],
    unindexed: isUnindexedRejection(failure),
  }));
}

/**
 * Envelope for one finished shard run. A shard whose required search failed
 * is failed, exactly like an infra failure — the run continues and the parent
 * maps either case to `shard_failed`.
 */
export function toShardEnvelope(index: number, result: ShardReviewResult): ShardEnvelope {
  if (result.requiredSearchFailed) {
    return {
      index,
      status: "error",
      decision: "none",
      error: "Required web search failed",
    };
  }
  return {
    index,
    status: "ok",
    decision: result.decision.action,
    ...("result" in result.decision ? { result: result.decision.result } : {}),
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(result.mcpFailures.size > 0 ? { mcpFailures: toShardVerdicts(result.mcpFailures) } : {}),
  };
}

/**
 * Runs one review — fit or shard — through the exact agent lifecycle review()
 * has always used, moved here verbatim: session/extension setup through the
 * agent loop and decision capture. The parent owns prompt assembly, the shard
 * plan, the merge, and sendOutput; this owns everything from session setup
 * through the captured decision so both callers share one implementation.
 * Tool presence that review() used to compute from instances is derived here
 * from the same configs (the constructors are total, so booleans and
 * instances cannot disagree). code-exec and the output target arrive via
 * opts, never the wire request: shards cannot run code-exec.
 */
export function runShardReview(
  request: ShardRequest,
  runtime: ShardRuntime,
  opts: ShardRunOptions & { suppressCodeExec: false },
): Promise<ShardReviewResult & { decision: ReviewDecision }>;
export function runShardReview(
  request: ShardRequest,
  runtime: ShardRuntime,
  opts: ShardRunOptions & { suppressCodeExec: true },
): Promise<ShardReviewResult & { decision: ShardToolDecision }>;
export async function runShardReview(
  request: ShardRequest,
  runtime: ShardRuntime,
  opts: ShardRunOptions,
): Promise<ShardReviewResult> {
  const logger = runtime.logger;
  const cwd = request.cwd;
  const mcpConfig = request.tools.mcpConfig;
  const lspEnabled = request.tools.lspEnabled;
  const lspEntries = request.tools.lspEntries;
  const githubToken = runtime.githubToken;
  const searchConfig = opts.target === "comment" ? resolveSearchConfig() : {};
  if (opts.target === "comment") {
    for (const warning of unavailableSearchWarnings())
      logger.warn("review.search.unavailable", warning);
    if (
      process.env.PI_REVIEWER_SEARCH_REQUIRED === "true" &&
      process.env.PI_REVIEWER_WEB_SEARCH === "true" &&
      !searchConfig.regular
    )
      throw new Error("Required regular web search is unavailable");
    if (
      process.env.PI_REVIEWER_AI_SEARCH_REQUIRED === "true" &&
      process.env.PI_REVIEWER_AI_SEARCH === "true" &&
      !searchConfig.ai
    )
      throw new Error("Required AI web search is unavailable");
  }
  const searchClient =
    searchConfig.regular || searchConfig.ai
      ? createSearchClient(searchConfig, request.tools.citationOffset)
      : undefined;
  const searchTools = searchClient
    ? createSearchTools(searchClient, {
        regular: Boolean(searchConfig.regular),
        ai: Boolean(searchConfig.ai),
      })
    : [];
  const registryTools = opts.target === "comment" ? createRegistryTools() : [];
  const githubResearchConfig =
    opts.target === "comment" ? resolveGitHubResearchConfig(process.env, githubToken) : undefined;
  if (opts.target === "comment") {
    for (const warning of unavailableGitHubResearchWarnings(process.env, githubToken))
      logger.warn("review.github_research.unavailable", warning);
    if (githubResearchConfig && !(await probeGhCli()))
      logger.warn(
        "review.github_research.unavailable",
        "GitHub research is unavailable (gh CLI was not found; install with setup-gh-cli)",
      );
  }
  const githubResearchTools = githubResearchConfig
    ? createGitHubResearchTools(githubResearchConfig)
    : [];
  // Resolve once so the startup diagnostic, the system prompt policy, and the
  // registered tools observe the same configuration.
  const codeExecConfig = resolveCodeExecConfig();
  const codeExecTools =
    opts.target === "comment" && !opts.suppressCodeExec
      ? createCodeExecTools(codeExecConfig, { cwd })
      : [];
  // Startup visibility complements the unavailable warnings above: operators
  // need the effective tool set in one line, not just what is missing.
  if (opts.target === "comment") {
    const available = [
      ...searchTools,
      ...registryTools,
      ...githubResearchTools,
      ...codeExecTools,
    ].map((tool) => tool.name);
    if (mcpConfig) available.push(MCP_TOOL_NAME);
    if (lspEnabled) available.push(...LSP_TOOL_NAMES);
    logger.info("review.tools.status", "Tool availability", {
      available,
      unavailable: KNOWN_CI_TOOL_NAMES.filter((name) => !available.includes(name)),
    });
  }
  const modelStr = request.model;
  if (!modelStr) {
    throw new Error(
      `No model configured. Set the "model" action input (or PI_REVIEWER_MODEL) to a "provider/modelId" — e.g. "openrouter/openai/gpt-5.4-mini".`,
    );
  }
  // Split on the FIRST slash so OpenRouter ids that contain slashes survive
  // (e.g. "openrouter/openai/gpt-5.4-mini" → provider "openrouter", id "openai/gpt-5.4-mini").
  const slash = modelStr.indexOf("/");
  if (slash <= 0 || slash === modelStr.length - 1) {
    throw new Error(
      `Invalid model format "${modelStr}". Expected "provider/modelId" — e.g. "anthropic/claude-opus-4-6" or "openrouter/openai/gpt-5.4-mini"`,
    );
  }
  const provider = modelStr.slice(0, slash);
  const modelId = modelStr.slice(slash + 1);
  // pi-ai 0.84 moved the static catalog helpers out of the package root.
  // Use the built-in catalog directly; dynamic model discovery is not needed
  // here because the action accepts the same provider/model catalog entries.
  const resolvedModel = getBuiltinModel(provider as never, modelId as never) as
    | Model<Api>
    | undefined;
  if (!resolvedModel) {
    throw new Error(`Unknown model "${modelStr}" — not found in the pi model registry.`);
  }
  logger.info("review.agent.started", "Running agent", { model: resolvedModel.api });

  const shardTool = opts.suppressCodeExec
    ? createShardTool(request.shard.files, (id, fields) =>
        logger.warn(
          id,
          id === "review.shard.digest_extra"
            ? "Shard digest names files outside the shard"
            : "Shard digest is incomplete",
          fields,
        ),
      )
    : undefined;
  const reviewToolState = opts.suppressCodeExec ? undefined : createReviewTool();
  const submitTool = shardTool?.tool ?? reviewToolState?.tool;
  const submitName = shardTool ? "submit_shard" : "submit_review";
  const getResult = (): ReviewDecision | ShardToolDecision | undefined => {
    if (shardTool) {
      const result = shardTool.getResult();
      if (!result) return undefined;
      // No action field on the wire: non-empty findings or updates mean
      // review. Anything else is "none" — but the digest still rides along,
      // because clean shards' digests feed the overview synth.
      if (result.findings.length > 0 || result.finding_updates.length > 0)
        return { action: "review", result };
      return { action: "none", result };
    }
    return reviewToolState?.getResult();
  };
  const models = builtinModels();

  const readOnlyTools = createReadOnlyTools(cwd);
  const baseTools: AgentTool[] = [
    ...readOnlyTools,
    ...searchTools,
    ...registryTools,
    ...githubResearchTools,
    ...codeExecTools,
    ...(submitTool ? [submitTool] : []),
  ];

  let agent: Agent;
  let closeExtensionSession: (() => Promise<void>) | undefined;
  const registeredMcpTools = new Set<string>();
  const registeredLspTools = new Set<string>();
  const mcpToolCalls = new Map<string, McpToolIdentity>();
  const mcpToolCallArgs = new Map<string, unknown>();
  const mcpOutputArtifacts = new Set<string>();
  let restoreExtensionEnvironment = () => {};
  const failedMcpCalls = new Map<string, McpFailureEntry>();
  const knownMcpServers = new Set<string>(mcpConfig ? Object.keys(mcpConfig.mcpServers) : []);
  // Which arguments a server owner declared to carry a repository
  // identifier, per server. A name two servers share — they differ only in
  // what the log can see — is ambiguous, and an ambiguous name carries no
  // declaration rather than an arbitrary one. Every configured server
  // counts towards the ambiguity, declared or not.
  const mcpServerNameCounts = new Map<string, number>();
  for (const name of knownMcpServers) {
    const key = sanitizeMcpDebugName(name);
    mcpServerNameCounts.set(key, (mcpServerNameCounts.get(key) ?? 0) + 1);
  }
  const ambiguousMcpServers = new Set(
    [...mcpServerNameCounts].filter(([, count]) => count > 1).map(([key]) => key),
  );
  const mcpLoggableArgs = new Map<string, string[]>();
  for (const [name, definition] of Object.entries(mcpConfig?.mcpServers ?? {})) {
    const declared = definition.loggableArgs;
    const names = Array.isArray(declared)
      ? declared.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (names.length === 0) continue;
    const key = sanitizeMcpDebugName(name);
    if (ambiguousMcpServers.has(key)) continue;
    mcpLoggableArgs.set(key, names);
  }
  // The declaration authorizes disclosure for the server the call used. A
  // call that names no server could only have involved the one there is, so
  // its declaration still applies — that is authorization, not attribution.
  const soleMcpServer = knownMcpServers.size === 1 ? [...knownMcpServers][0] : undefined;
  const loggableArgsFor = (server: string | undefined): readonly string[] => {
    const name = server ?? soleMcpServer;
    if (name === undefined) return [];
    const key = sanitizeMcpDebugName(name);
    if (ambiguousMcpServers.has(key)) return [];
    return mcpLoggableArgs.get(key) ?? [];
  };
  // The extension session path serves both MCP and LSP. It exists whenever
  // either is configured; otherwise the agent runs without extensions. LSP
  // counts as configured even when no server binary turned out to be
  // installed: the tool surface stays the same on every runner.
  const needsExtensionSession = Boolean(mcpConfig) || lspEnabled;
  if (needsExtensionSession) {
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-agent-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const previousMcpOutputGuard = process.env.MCP_OUTPUT_GUARD;
      const previousMcpUiDebug = process.env.MCP_UI_DEBUG;
      if (mcpConfig) {
        process.env.MCP_OUTPUT_GUARD = "1";
        process.env.MCP_UI_DEBUG = "0";
      }
      // pi-lsp reads its trusted global config from PI_AGENT_DIR. Point it at
      // the per-run agent dir so config, trust store, and runtime state are
      // isolated and cleaned up with the session.
      const previousPiAgentDir = setAgentDir(agentDir);
      restoreExtensionEnvironment = () => {
        if (previousMcpOutputGuard === undefined) delete process.env.MCP_OUTPUT_GUARD;
        else process.env.MCP_OUTPUT_GUARD = previousMcpOutputGuard;
        if (previousMcpUiDebug === undefined) delete process.env.MCP_UI_DEBUG;
        else process.env.MCP_UI_DEBUG = previousMcpUiDebug;
        restoreAgentDir(previousPiAgentDir);
      };
      if (lspEnabled) {
        await writeTrustedLspConfig(agentDir, lspEntries);
      }
      const extensionFactories: never[] = [];
      if (mcpConfig) {
        // The adapter ships Pi-extension TypeScript sources, so keep the import
        // dynamic and untyped: it is loaded only for opted-in CI reviews.
        const adapterPackage = "pi-mcp-adapter";
        const { createMcpAdapter } = (await import(adapterPackage)) as {
          createMcpAdapter(options: ShardMcpAdapterOptions): unknown;
        };
        extensionFactories.push(
          createMcpAdapter({
            config: {
              ...mcpConfig,
              settings: {
                ...mcpConfig.settings,
                allowInstall: false,
                agentPluginPaths: [],
                outputGuard: true,
              },
              mcpServers: Object.fromEntries(
                Object.entries(mcpConfig.mcpServers).map(([name, definition]) => {
                  const auth =
                    definition.auth ??
                    (definition.bearerToken !== undefined || definition.bearerTokenEnv !== undefined
                      ? "bearer"
                      : false);
                  const { loggableArgs: _loggableArgs, ...server } = definition;
                  if (typeof definition.command !== "string")
                    return [name, { ...server, auth, debug: false }];
                  if (!request.tools.mcpServerCwd)
                    throw new Error(
                      "Stdio MCP servers require a working directory from the trusted default branch",
                    );
                  return [
                    name,
                    {
                      ...server,
                      auth,
                      cwd: request.tools.mcpServerCwd,
                      debug: false,
                      inheritEnv: false,
                    },
                  ];
                }),
              ),
            },
          }) as never,
        );
      }
      // pi-lsp ships untyped TypeScript sources (see loadPiLspExtension), so
      // it is loaded only when LSP is enabled for CI comment reviews.
      if (lspEnabled) {
        extensionFactories.push((await loadPiLspExtension()) as never);
      }
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: request.systemPrompt,
        extensionFactories,
      });
      await resourceLoader.reload();
      // Reviewer tools must be registered as session custom tools: the session
      // rebuilds state.tools from registry names on every turn, and
      // setActiveToolsByName only activates registered tools.
      const created = await createAgentSession({
        cwd,
        agentDir,
        sessionManager: SessionManager.inMemory(),
        resourceLoader,
        tools: [
          ...new Set([
            "read",
            "grep",
            "find",
            "ls",
            ...(mcpConfig ? ["mcp"] : []),
            // The tools list is also the registration allowlist: names
            // missing here are filtered from the tool registry, so the
            // session could never activate them below even though their
            // extension registered them.
            ...(lspEnabled ? LSP_TOOL_NAMES : []),
            ...baseTools.map((tool) => tool.name),
          ]),
        ],
        customTools: baseTools,
      });
      session = created.session;
      // Extension tools are namespaced by origin: pi-lsp names every tool
      // `lsp_*`; everything else registered belongs to MCP. The partition
      // keeps LSP failures out of the MCP failure accounting below
      // (failedMcpCalls, DeepWiki veto).
      const { lsp: lspToolNames, mcp: mcpToolNames } = partitionExtensionTools(
        session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
      );
      for (const name of mcpToolNames) registeredMcpTools.add(name);
      for (const name of lspToolNames) registeredLspTools.add(name);
      if (mcpConfig && mcpToolNames.length === 0)
        throw new Error("MCP adapter did not register any tools for the configured servers");
      if (lspEnabled && lspToolNames.length === 0)
        throw new Error("pi-lsp did not register any tools");
      session.setActiveToolsByName([
        ...new Set([
          "read",
          "grep",
          "find",
          // Each family is gated on its own config: an unrelated extension's
          // `lsp_*` tool must not leak into an MCP-only review or vice versa.
          ...(mcpConfig ? mcpToolNames : []),
          ...(lspEnabled ? lspToolNames : []),
          ...baseTools.map((tool) => tool.name),
        ]),
      ]);
      // setActiveToolsByName assigns agent.state.tools synchronously via
      // the registry, so a missing tool here means the allowlist filtered
      // it at session creation — exactly the "tools were not enabled"
      // failure seen in CI before lsp_* joined the tools list above.
      const mcpTools = session.agent.state.tools.filter((tool) => mcpToolNames.includes(tool.name));
      if (mcpConfig && mcpTools.length === 0)
        throw new Error("MCP adapter tools were not enabled in the review agent");
      const lspTools = session.agent.state.tools.filter((tool) => lspToolNames.includes(tool.name));
      if (lspEnabled && lspTools.length === 0)
        throw new Error("LSP tools were not enabled in the review agent");

      agent = session.agent;
      // The system prompt is seeded via the resource loader's leading system
      // message; state.systemPrompt replays the transcript and is read-only.
      // Tools are already active from the registry, so leave state.tools alone.
      agent.state.model = resolvedModel;
      agent.state.thinkingLevel = request.thinkingLevel;
      agent.streamFunction = models.streamSimple.bind(models);
      agent.getApiKey = runtime.getApiKey;
      closeExtensionSession = async () => {
        try {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          try {
            session?.dispose();
          } finally {
            try {
              await Promise.all(
                [...mcpOutputArtifacts].map((directory) =>
                  rm(directory, { recursive: true, force: true }),
                ),
              );
            } finally {
              try {
                await rm(agentDir, { recursive: true, force: true });
              } finally {
                restoreExtensionEnvironment();
              }
            }
          }
        }
      };
      if (mcpConfig)
        logger.info("review.mcp.enabled", "MCP enabled", { toolCount: registeredMcpTools.size });
      if (lspEnabled)
        logger.info("review.lsp.enabled", "LSP enabled", {
          servers: lspEntries.map((entry) => entry.id),
          toolCount: registeredLspTools.size,
        });
    } catch (error) {
      try {
        if (session) {
          await session.extensionRunner
            .emit({ type: "session_shutdown", reason: "quit" })
            .catch(() => undefined);
          session.dispose();
        }
      } finally {
        try {
          await rm(agentDir, { recursive: true, force: true });
        } finally {
          restoreExtensionEnvironment();
        }
      }
      throw error;
    }
  } else {
    agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: resolvedModel,
        tools: baseTools,
        thinkingLevel: request.thinkingLevel,
      },
      streamFn: models.streamSimple.bind(models),
      getApiKey: runtime.getApiKey,
    });
  }

  let unsubscribe: (() => void) | undefined;

  try {
    let reviewDecision: ReviewDecision | ShardToolDecision | undefined;
    let runMessages: unknown[] = [];
    let forceSubmit = false;
    // The retry pins tool_choice to the run's submit tool. The declared tool set is left
    // alone so each request keeps matching the transcript it carries. Compose
    // with whatever stream function the setup installed (the MCP session's or the
    // constructor's) rather than re-deriving it, so there stays exactly one
    // source of truth for the base stream.
    const baseStream = agent.streamFunction;
    agent.streamFunction = (model, context, options) =>
      baseStream(
        model,
        context,
        forceSubmit
          ? {
              ...options,
              toolChoice: shardTool
                ? (shardTool.forcedTool as unknown as typeof FORCED_SUBMIT_TOOL)
                : FORCED_SUBMIT_TOOL,
            }
          : options,
      );
    const thinkingTrace: Array<Record<string, unknown>> = [];
    let pendingThinking: { timestamp: string; text: string } | undefined;
    let thinkingDeltaCount = 0;
    let thinkingChars = 0;
    // Per-run baselines: run_end reports only the current prompt's thinking,
    // so a retry does not inherit the previous run's totals.
    let runStartDeltas = 0;
    let runStartChars = 0;
    let finalMessageThinkingCaptured = false;
    const traceEnabled = request.debug && Boolean(process.env.PI_REVIEWER_THINKING_ARTIFACT);
    const addTraceEvent = (type: string, fields: Record<string, unknown> = {}) => {
      if (!traceEnabled) return;
      thinkingTrace.push({
        timestamp: new Date().toISOString(),
        type,
        ...fields,
      });
    };
    const flushThinking = () => {
      if (!pendingThinking) return;
      addTraceEvent("thinking", {
        timestamp: pendingThinking.timestamp,
        endTimestamp: new Date().toISOString(),
        text: pendingThinking.text,
      });
      pendingThinking = undefined;
    };
    const writeThinkingTrace = async () => {
      const artifactPath = process.env.PI_REVIEWER_THINKING_ARTIFACT;
      if (!traceEnabled || !artifactPath || thinkingTrace.length === 0) return;
      try {
        await writeFile(
          artifactPath,
          `${thinkingTrace.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch (error) {
        logger.warn("review.agent.thinking_artifact_failed", "Could not write thinking artifact", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    let settleRun: (() => void) | undefined;
    let failRun: ((error: Error) => void) | undefined;
    unsubscribe = agent.subscribe((event: unknown) => {
      if (!event || typeof event !== "object") return;
      const eventType = (event as { type?: string }).type;
      if (eventType === "message_update" && traceEnabled) {
        const update = event as {
          assistantMessageEvent?: { type?: string; delta?: unknown };
        };
        const thinkingEvent = update.assistantMessageEvent;
        if (thinkingEvent?.type === "thinking_delta" && typeof thinkingEvent.delta === "string") {
          thinkingDeltaCount++;
          thinkingChars += thinkingEvent.delta.length;
          if (pendingThinking) pendingThinking.text += thinkingEvent.delta;
          else pendingThinking = { timestamp: new Date().toISOString(), text: thinkingEvent.delta };
        } else {
          flushThinking();
        }
      }
      if (eventType === "tool_execution_start" || eventType === "tool_execution_end") {
        flushThinking();
        const toolEvent = event as {
          toolName?: unknown;
          toolCallId?: unknown;
          args?: unknown;
          result?: unknown;
          isError?: unknown;
        };
        const rawToolName = typeof toolEvent.toolName === "string" ? toolEvent.toolName : "unknown";
        const rawCallId =
          typeof toolEvent.toolCallId === "string" ? toolEvent.toolCallId : undefined;
        // Stable identity per tool call: the end event reuses the start
        // event's identity so arg-less end payloads cannot drift.
        const mcpIdentity =
          eventType === "tool_execution_end" && rawCallId
            ? (mcpToolCalls.get(rawCallId) ??
              extractMcpToolIdentity(
                rawToolName,
                toolEvent.args,
                registeredMcpTools,
                knownMcpServers,
              ))
            : extractMcpToolIdentity(
                rawToolName,
                toolEvent.args,
                registeredMcpTools,
                knownMcpServers,
              );
        const mcpKey = mcpIdentity ? `${mcpIdentity.server ?? ""}\0${mcpIdentity.tool}` : undefined;
        const contentExcerpt =
          eventType === "tool_execution_end" && mcpIdentity
            ? extractMcpContentExcerpt(toolEvent.result)
            : undefined;
        if (traceEnabled) {
          // Error signal is failure-only: successful adapter results also
          // carry details, which must not surface as errorClass.
          const endSignal =
            eventType === "tool_execution_end" && mcpIdentity && toolEvent.isError === true
              ? extractMcpErrorSignal(toolEvent.result)
              : undefined;
          // Fingerprint only: sizes decide empty-vs-useful triage, the trace
          // never persists tool output.
          const fingerprint =
            eventType === "tool_execution_end" ? describeToolResult(toolEvent.result) : undefined;
          addTraceEvent(eventType === "tool_execution_start" ? "tool_start" : "tool_end", {
            ...(mcpIdentity
              ? {
                  ...(mcpIdentity.server !== undefined ? { server: mcpIdentity.server } : {}),
                  tool: mcpIdentity.tool.slice(0, 200),
                }
              : { tool: sanitizeMcpDebugName(rawToolName).slice(0, 200) }),
            callId: rawCallId ? sanitizeMcpDebugName(rawCallId).slice(0, 128) : undefined,
            ...(eventType === "tool_execution_end"
              ? {
                  status: toolEvent.isError === true ? "error" : "success",
                  ...(fingerprint
                    ? {
                        resultBytes: fingerprint.resultBytes,
                        resultEmpty: fingerprint.resultEmpty,
                      }
                    : {}),
                }
              : {}),
            ...(endSignal
              ? {
                  errorClass: endSignal.errorClass,
                  ...(endSignal.detail !== undefined ? { detail: endSignal.detail } : {}),
                }
              : {}),
          });
        }
        if (eventType === "tool_execution_start") {
          if (mcpIdentity) {
            if (rawCallId) {
              mcpToolCalls.set(rawCallId, mcpIdentity);
              // The arguments are kept per call so the end event can read the
              // declared fields from them; they are never logged whole.
              mcpToolCallArgs.set(rawCallId, toolEvent.args);
            }
            if (request.debug)
              logger.debug("review.mcp.tool_call", "MCP tool call", {
                ...(mcpIdentity.server !== undefined ? { server: mcpIdentity.server } : {}),
                tool: mcpIdentity.tool,
                callId: rawCallId,
              });
          } else if (request.debug) {
            const args = formatDebugToolArgs(toolEvent.args);
            logger.debug("review.tool.call", "Tool call", {
              tool: rawToolName,
              callId: rawCallId,
              args,
            });
          }
        } else {
          // The repositories the call named, from the fields the server
          // owner declared loggable.
          const repoIds = mcpIdentity
            ? extractMcpRepositoryIds(
                (rawCallId ? mcpToolCallArgs.get(rawCallId) : undefined) ?? toolEvent.args,
                loggableArgsFor(mcpIdentity.server),
              )
            : [];
          if (mcpIdentity && mcpKey && toolEvent.isError === true) {
            const signal = extractMcpErrorSignal(toolEvent.result) ?? {
              errorClass: "unknown" as const,
            };
            failedMcpCalls.set(mcpKey, {
              identity: mcpIdentity,
              signal,
              ...(repoIds.length > 0 ? { repoIds } : {}),
              contentExcerpt,
            });
          } else if (mcpIdentity && mcpKey) failedMcpCalls.delete(mcpKey);
          const outputArtifact = mcpIdentity
            ? mcpOutputArtifactDirectory(toolEvent.result)
            : undefined;
          if (outputArtifact) mcpOutputArtifacts.add(outputArtifact);
          if (request.debug)
            logger.debug(
              mcpIdentity ? "review.mcp.tool_result" : "review.tool.result",
              mcpIdentity ? "MCP tool result" : "Tool result",
              {
                ...(mcpIdentity
                  ? {
                      ...(mcpIdentity.server !== undefined ? { server: mcpIdentity.server } : {}),
                      tool: mcpIdentity.tool,
                    }
                  : { tool: rawToolName }),
                callId: rawCallId,
                status: toolEvent.isError === true ? "error" : "success",
                ...(mcpIdentity && toolEvent.isError === true
                  ? (() => {
                      const signal = extractMcpErrorSignal(toolEvent.result);
                      return signal
                        ? {
                            errorClass: signal.errorClass,
                            ...(signal.detail !== undefined ? { detail: signal.detail } : {}),
                          }
                        : {};
                    })()
                  : {}),
              },
            );
          if (rawCallId) {
            mcpToolCalls.delete(rawCallId);
            mcpToolCallArgs.delete(rawCallId);
          }
        }
      }
      if (eventType !== "agent_end") return;
      flushThinking();

      const ev = event as { messages?: unknown; stopReason?: string; errorMessage?: string };
      const msgs = Array.isArray(ev.messages) ? ev.messages : [];
      runMessages = msgs;
      const lastAssistant = [...msgs]
        .reverse()
        .find((m) => (m as { role?: string })?.role === "assistant") as
        | { stopReason?: string; errorMessage?: string; content?: unknown }
        | undefined;

      if (traceEnabled && thinkingDeltaCount === 0 && !finalMessageThinkingCaptured) {
        for (const message of msgs) {
          if (!isAssistantMessage(message) || !Array.isArray(message.content)) continue;
          for (const part of message.content) {
            if (!isThinkingContentPart(part)) continue;
            const timestamp = new Date().toISOString();
            addTraceEvent("thinking", {
              timestamp,
              endTimestamp: timestamp,
              text: part.thinking,
            });
            thinkingChars += part.thinking.length;
            finalMessageThinkingCaptured = true;
          }
        }
      }

      if (traceEnabled) {
        // Terminal marker: without it a trace that ends in thinking is
        // ambiguous between a quiet stop and a stop that starved the tool
        // call of output budget. Raw stopReason plus the thinking text lets
        // the reader infer budget starvation without a heuristic bit.
        const stopReason =
          typeof ev.stopReason === "string"
            ? ev.stopReason
            : typeof lastAssistant?.stopReason === "string"
              ? lastAssistant.stopReason
              : undefined;
        addTraceEvent("run_end", {
          ...(stopReason !== undefined ? { stopReason } : {}),
          hasDecision: getResult() !== undefined,
          thinkingDeltas: thinkingDeltaCount - runStartDeltas,
          thinkingChars: thinkingChars - runStartChars,
        });
      }

      // The error may surface on the agent_end event OR on the last assistant
      // message (e.g. provider 402/429/401 — pi-agent-core attaches it there).
      const errorMessage =
        (ev.stopReason === "error" ? ev.errorMessage : undefined) ??
        (lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage : undefined);
      if (errorMessage) {
        logger.error("review.agent.error", "Agent error", { error: errorMessage });
        failRun?.(new Error(`Agent failed: ${errorMessage}`));
        return;
      }

      // The submit tool is the only structured contract; a text-only response is
      // a failed review, so the harness never parses model prose.
      const decision = getResult();
      if (decision) reviewDecision = decision;
      settleRun?.();
    });

    const runAgent = async (message: string) => {
      const ended = new Promise<void>((resolve, reject) => {
        settleRun = resolve;
        failRun = reject;
      });
      // The rejection may land while prompt() is still settling; mark it
      // observed up front so the window before the await below never reads
      // as an unhandled rejection. Awaiting ended afterwards still throws.
      void ended.catch(() => {});
      // Baseline per-run thinking: run_end reports this prompt's deltas only.
      runStartDeltas = thinkingDeltaCount;
      runStartChars = thinkingChars;
      // Sequential on purpose: agent.prompt() settles only after agent_end
      // listeners have run and the run is fully idle. Awaiting both
      // concurrently lets ended reject first while prompt() still holds the
      // run open, so the immediate bare-nudge retry collides with "Agent is
      // already processing a prompt".
      await agent.prompt(message);
      await ended;
    };

    try {
      await runAgent(request.userPrompt);
      if (!reviewDecision) {
        // The model stopped without calling its submit tool. Ask once more with
        // the transcript intact: the nudge applies to every provider, and the
        // pinned tool_choice is best-effort on top. Support and wire shape vary
        // per provider, so a rejected pin has to degrade to the bare nudge —
        // never to a failed run. A normal stop with no decision is deliberately
        // not retried bare: the pin carries no evidence of being the cause, so
        // an identical third call would not differ.
        try {
          forceSubmit = true;
          await runAgent(shardTool?.nudge ?? SUBMIT_NUDGE);
        } catch (error) {
          // Only the pinned attempt's failure is anticipated: the pinned value
          // is a documented type-lie whose support varies by provider, so it
          // degrades to the nudge. The bare retry is the last attempt, carries
          // nothing provider-specific, and swallowing its failure could only
          // relabel it — so it propagates.
          logger.warn(
            "review.agent.forced_call_failed",
            `Pinned ${shardTool ? "submit_shard" : "submit_review"} call failed; retrying with the nudge alone`,
            { error: error instanceof Error ? error.message : String(error) },
          );
          forceSubmit = false;
          await runAgent(shardTool?.nudge ?? SUBMIT_NUDGE);
        } finally {
          forceSubmit = false;
        }
      }
    } finally {
      await writeThinkingTrace();
    }

    if (!reviewDecision) {
      // The model finished without calling its submit tool. The prose it
      // may have emitted is deliberately not parsed, so there is nothing to
      // post. Log a bounded, command-inert excerpt for diagnosis, then fail.
      const lastText = extractLastAssistantText(runMessages);
      const excerpt = lastText
        .slice(-4000)
        .split("\n")
        .map((line) => (line.startsWith("::") ? ` ${line}` : line))
        .join("\n");
      logger.error("review.agent.no_decision", `Agent finished without calling ${submitName}`, {
        textLength: lastText.length,
        textExcerpt: excerpt,
      });
      throw new Error(`Agent finished without calling ${submitName}`);
    }
    logger.info("review.agent.completed", `Agent completed via ${submitName} tool`, {
      action: reviewDecision.action,
      comments:
        reviewDecision.action === "review"
          ? "comments" in reviewDecision.result
            ? reviewDecision.result.comments.length
            : reviewDecision.result.findings.length
          : 0,
    });
    const runResult: ShardReviewResult = {
      decision: reviewDecision,
      evidence: searchClient?.snapshot(),
      mcpFailures: failedMcpCalls,
      requiredSearchFailed: searchClient?.hasRequiredFailure() ?? false,
    };
    return runResult;
  } finally {
    unsubscribe?.();
    await closeExtensionSession?.();
  }
}

export interface SynthRunRequest {
  cwd: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  userPrompt: string;
  lspEntries: LspFileServer[];
  lspEnabled: boolean;
}

export interface SynthRunResult {
  pr_summary?: string;
  pr_diagram?: string;
}

/**
 * Overview synthesis (Phase 3 reduce). Runs in-process after the barrier —
 * no shards run concurrently, so no child process is needed — in its own
 * extension session when LSP is enabled (own agentDir, own LSP set, disposed
 * in a finally). Verification tools only: read-only + LSP when enabled +
 * code_exec + submit_overview (no search/registry/MCP). The absence of
 * submit_review from the tool list is what enforces "never re-review the
 * diff", not the prompt sentence. code_exec is safe here because no shard
 * runs concurrently. A missing tool call is an omitted overview, never an
 * error: the caller falls back to findings plus the coverage line.
 */
export async function runSynthOverview(
  request: SynthRunRequest,
  runtime: ShardRuntime,
): Promise<SynthRunResult | undefined> {
  const logger = runtime.logger;
  const modelStr = request.model;
  if (!modelStr) {
    throw new Error(
      `No model configured. Set the "model" action input (or PI_REVIEWER_MODEL) to a "provider/modelId" — e.g. "openrouter/openai/gpt-5.4-mini".`,
    );
  }
  const slash = modelStr.indexOf("/");
  if (slash <= 0 || slash === modelStr.length - 1) {
    throw new Error(
      `Invalid model format "${modelStr}". Expected "provider/modelId" — e.g. "anthropic/claude-opus-4-6" or "openrouter/openai/gpt-5.4-mini"`,
    );
  }
  const provider = modelStr.slice(0, slash);
  const modelId = modelStr.slice(slash + 1);
  const resolvedModel = getBuiltinModel(provider as never, modelId as never) as
    | Model<Api>
    | undefined;
  if (!resolvedModel) {
    throw new Error(`Unknown model "${modelStr}" — not found in the pi model registry.`);
  }
  const models = builtinModels();
  const { tool: overviewTool, getResult } = createOverviewTool();

  const readOnlyTools = createReadOnlyTools(request.cwd);
  const codeExecConfig = resolveCodeExecConfig();
  const codeExecTools = codeExecConfig.enabled
    ? createCodeExecTools(codeExecConfig, { cwd: request.cwd })
    : [];
  const baseTools: AgentTool[] = [...readOnlyTools, ...codeExecTools, overviewTool];

  let agent: Agent;
  let closeExtensionSession: (() => Promise<void>) | undefined;
  if (request.lspEnabled) {
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-synth-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const previousPiAgentDir = setAgentDir(agentDir);
    const restoreExtensionEnvironment = () => restoreAgentDir(previousPiAgentDir);
    try {
      // pi-lsp reads its trusted global config from PI_AGENT_DIR. Point it at
      // the per-run agent dir so config, trust store, and runtime state are
      // isolated and cleaned up with the session.
      await writeTrustedLspConfig(agentDir, request.lspEntries);
      // pi-lsp ships untyped TypeScript sources (see loadPiLspExtension), so
      // it is loaded only when LSP is enabled for CI comment reviews.
      const extensionFactories: never[] = [(await loadPiLspExtension()) as never];
      const resourceLoader = new DefaultResourceLoader({
        cwd: request.cwd,
        agentDir,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: request.systemPrompt,
        extensionFactories,
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: request.cwd,
        agentDir,
        sessionManager: SessionManager.inMemory(),
        resourceLoader,
        tools: [
          ...new Set([
            "read",
            "grep",
            "find",
            "ls",
            ...LSP_TOOL_NAMES,
            ...baseTools.map((tool) => tool.name),
          ]),
        ],
        customTools: baseTools,
      });
      session = created.session;
      const lspToolNames = partitionExtensionTools(
        session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
      ).lsp;
      if (lspToolNames.length === 0) throw new Error("pi-lsp did not register any tools");
      session.setActiveToolsByName([
        ...new Set([
          "read",
          "grep",
          "find",
          ...lspToolNames,
          ...baseTools.map((tool) => tool.name),
        ]),
      ]);
      const lspTools = session.agent.state.tools.filter((tool) => lspToolNames.includes(tool.name));
      if (lspTools.length === 0) throw new Error("LSP tools were not enabled in the synth agent");

      agent = session.agent;
      agent.state.model = resolvedModel;
      agent.state.thinkingLevel = request.thinkingLevel;
      agent.streamFunction = models.streamSimple.bind(models);
      agent.getApiKey = runtime.getApiKey;
      closeExtensionSession = async () => {
        try {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          try {
            session?.dispose();
          } finally {
            try {
              await rm(agentDir, { recursive: true, force: true });
            } finally {
              restoreExtensionEnvironment();
            }
          }
        }
      };
      logger.info("review.synth.enabled", "Synth extension session ready", {
        servers: request.lspEntries.map((entry) => entry.id),
      });
    } catch (error) {
      try {
        if (session) {
          await session.extensionRunner
            .emit({ type: "session_shutdown", reason: "quit" })
            .catch(() => undefined);
          session.dispose();
        }
      } finally {
        try {
          await rm(agentDir, { recursive: true, force: true });
        } finally {
          restoreExtensionEnvironment();
        }
      }
      throw error;
    }
  } else {
    agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model: resolvedModel,
        tools: baseTools,
        thinkingLevel: request.thinkingLevel,
      },
      streamFn: models.streamSimple.bind(models),
      getApiKey: runtime.getApiKey,
    });
  }

  let settleRun: (() => void) | undefined;
  let failRun: ((error: Error) => void) | undefined;
  const unsubscribe = agent.subscribe((event: unknown) => {
    if (!event || typeof event !== "object") return;
    const eventType = (event as { type?: string }).type;
    if (eventType !== "agent_end") return;
    const ev = event as { stopReason?: string; errorMessage?: string };
    const errorMessage = ev.stopReason === "error" ? ev.errorMessage : undefined;
    if (errorMessage) {
      failRun?.(new Error(`Agent failed: ${errorMessage}`));
      return;
    }
    settleRun?.();
  });

  try {
    const ended = new Promise<void>((resolve, reject) => {
      settleRun = resolve;
      failRun = reject;
    });
    void ended.catch(() => {});
    await agent.prompt(request.userPrompt);
    await ended;
    const result = getResult();
    if (result) {
      logger.info("review.synth.completed", "Synth overview captured", {
        hasSummary: result.pr_summary !== undefined,
        hasDiagram: result.pr_diagram !== undefined,
      });
    }
    return result ?? undefined;
  } finally {
    unsubscribe?.();
    await closeExtensionSession?.();
  }
}
