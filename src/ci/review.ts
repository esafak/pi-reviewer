import { Agent } from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";

import { loadContext, mergeContextFiles } from "../core/context.js";
import { resolveDiff, extractDiffFiles } from "../core/diff-resolver.js";
import { loadDocContext } from "../core/doc-context.js";
import { sendOutput, extractLastAssistantText, normalizeFinding, type OutputTarget, type Severity } from "../core/output.js";
import { buildJSONSystemPrompt, buildUserPrompt, type MinSeverity, type ActiveFindingContext } from "../core/prompt-builder.js";
import { createReviewTool } from "../core/review-tool.js";
import type { ThinkingLevel } from "../core/config.js";

export interface ReviewOptions {
  cwd?: string;
  pr?: number;
  diff?: string;
  branch?: string;
  output?: OutputTarget;
  dryRun?: boolean;
  githubToken?: string;
  piApiKey?: string;
  repo?: string;
  commitId?: string;
  model?: string; // format: "provider/modelId" e.g. "anthropic/claude-opus-4-6"
  thinking?: ThinkingLevel;
  minSeverity?: MinSeverity;
  docDirs?: string[]; // dirs to scan for doc-context; empty = inject nothing (opt-in)
  fromSha?: string;
  batchMarker?: string;
  activeFindings?: ActiveFindingContext[];
  allowEmptyDiff?: boolean;
  priorSummary?: string;
  reactOnNoFindings?: boolean;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  const value = raw ?? "off";
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new Error(`Invalid thinking level: ${value}. Expected: ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ThinkingLevel;
}

/** Parses a comma/newline-separated doc-dirs string into a trimmed, non-empty list. */
export function parseDocDirs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[,\n]/).map(d => d.trim()).filter(Boolean);
}

export async function review(options: ReviewOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY;

  const { diff, source, warning, skippedFiles } = await resolveDiff({
    pr: options.pr,
    diff: options.diff,
    branch: options.branch,
    cwd,
    fromSha: options.fromSha,
    toSha: options.commitId,
    allowEmpty: options.allowEmptyDiff,
  });
  console.log(`[pi-reviewer] diff resolved — source: ${source}, size: ${diff.length} chars`);
  if (warning) console.warn(`[pi-reviewer] ${warning}`);

  const context = await loadContext({ cwd });
  const loadedPaths = mergeContextFiles(context).map(f => f.path);
  if (loadedPaths.length > 0) {
    console.log(`[pi-reviewer] context loaded: ${loadedPaths.join(", ")}`);
  } else {
    console.log("[pi-reviewer] context: no conventions found (AGENTS.md / CLAUDE.md / REVIEW.md)");
  }

  const docDirs = options.docDirs ?? parseDocDirs(process.env.PI_REVIEWER_DOC_DIRS);
  const docContextFiles = docDirs.length > 0
    ? await loadDocContext({ cwd, diffFiles: extractDiffFiles(diff), docDirs })
    : [];
  if (docContextFiles.length > 0) {
    console.log(`[pi-reviewer] doc-context loaded: ${docContextFiles.map(f => f.path).join(", ")}`);
  }

  const systemPrompt = buildJSONSystemPrompt(context, options.minSeverity, docContextFiles, options.activeFindings, options.priorSummary);
  const userPrompt = buildUserPrompt(diff, skippedFiles);

  const target: OutputTarget =
    options.output ?? (process.env.GITHUB_ACTIONS === "true" ? "comment" : "terminal");

  if (options.dryRun) {
    console.log(`Diff source: ${source}`);
    console.log(`System prompt:\n\n${systemPrompt}`);
    console.log(`User prompt:\n\n${userPrompt}`);
    return;
  }

  const modelStr = options.model ?? process.env.PI_REVIEWER_MODEL;
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
  const resolvedModel = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined;
  if (!resolvedModel) {
    throw new Error(`Unknown model "${modelStr}" — not found in the pi model registry.`);
  }
  console.log(`[pi-reviewer] running agent (model: ${resolvedModel.api})`);

  const { tool: reviewTool, getResult } = createReviewTool();
  const models = builtinModels();

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: resolvedModel,
      tools: [...createReadOnlyTools(cwd), reviewTool],
      thinkingLevel: options.thinking ?? "off",
    },
    streamFn: models.streamSimple.bind(models),
    getApiKey: async () => {
      const key = options.piApiKey ?? process.env.PI_API_KEY;
      if (!key) throw new Error("PI_API_KEY is not set.");
      return key;
    },
  });

  let unsubscribe: (() => void) | undefined;

  try {
    let finalResponse = "";
    let structuredResult: ReturnType<typeof getResult>;

    const ended = new Promise<void>((resolve, reject) => {
      unsubscribe = agent.subscribe((event: unknown) => {
        if (!event || typeof event !== "object") return;
        if ((event as { type?: string }).type !== "agent_end") return;

        const ev = event as { messages?: unknown; stopReason?: string; errorMessage?: string };
        const msgs = Array.isArray(ev.messages) ? ev.messages : [];
        const lastAssistant = [...msgs]
          .reverse()
          .find((m) => (m as { role?: string })?.role === "assistant") as
          | { stopReason?: string; errorMessage?: string; content?: unknown }
          | undefined;

        // The error may surface on the agent_end event OR on the last assistant
        // message (e.g. provider 402/429/401 — pi-agent-core attaches it there).
        const errorMessage =
          (ev.stopReason === "error" ? ev.errorMessage : undefined) ??
          (lastAssistant?.stopReason === "error" ? lastAssistant.errorMessage : undefined);
        if (errorMessage) {
          console.error(`[pi-reviewer] agent error: ${errorMessage}`);
          reject(new Error(`Agent failed: ${errorMessage}`));
          return;
        }

        // Prefer the submit_review tool result (schema-validated happy path).
        // Fall back to text extraction + the fixed parser for models that don't
        // call the tool.
        const toolResult = getResult();
        if (toolResult) {
          structuredResult = toolResult;
          console.log(
            `[pi-reviewer] agent completed via submit_review tool — ${toolResult.comments.length} comment(s)`,
          );
          resolve();
          return;
        }

        finalResponse = extractLastAssistantText(ev.messages);

        if (!finalResponse.trim()) {
          let shape: unknown = typeof lastAssistant?.content;
          if (Array.isArray(lastAssistant?.content)) {
            shape = (lastAssistant!.content as Array<Record<string, unknown>>).map((p) => ({
              type: p?.type ?? typeof p,
              len: typeof p?.text === "string" ? p.text.length : typeof p?.thinking === "string" ? p.thinking.length : 0,
            }));
          }
          console.error(
            `[pi-reviewer] agent returned an empty response — stopReason=${ev.stopReason ?? "unknown"}, assistantMessages=${msgs.filter((m) => (m as { role?: string })?.role === "assistant").length}, lastAssistantContent=${JSON.stringify(shape)}`,
          );
          reject(new Error("Agent returned an empty response"));
          return;
        }

        // Preserve the exact text fallback in CI logs. Prefix every line so
        // model-generated `::command` text cannot be interpreted as a GitHub
        // Actions command. This is the only artifact available when a model
        // emits a textual/tool-protocol response instead of calling
        // submit_review.
        console.warn("[pi-reviewer] submit_review was not called; using text fallback");
        console.log("::group::Pi Reviewer raw assistant response (text fallback)");
        for (const line of finalResponse.split(/\r?\n/)) {
          console.log(`| ${line}`);
        }
        console.log("::endgroup::");
        console.log(`[pi-reviewer] agent completed — response: ${finalResponse.length} chars`);
        resolve();
      });
    });

    await agent.prompt(userPrompt);
    await ended;

    await sendOutput({
      target,
      content: finalResponse,
      structuredResult,
      cwd,
      githubToken,
      prNumber: options.pr,
      repo,
      commitId: options.commitId,
      minSeverity: options.minSeverity as Severity | undefined,
      diff,
      batchMarker: options.batchMarker,
      existingFindings: options.activeFindings?.map(f => ({ commentId: f.commentId, threadId: f.threadId })),
      existingFindingKeys: new Set(options.activeFindings?.filter(f => f.file && f.line && f.side).map(f => normalizeFinding({ file: f.file!, line: f.line!, side: f.side as "LEFT" | "RIGHT", body: f.body }))),
      allowedFindingIds: new Set(options.activeFindings?.map(f => f.commentId)),
      reactOnNoFindings: options.reactOnNoFindings,
    });
  } finally {
    unsubscribe?.();
  }
}
