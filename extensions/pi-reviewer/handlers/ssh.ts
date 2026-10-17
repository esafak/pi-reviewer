import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseAgentResponse,
  extractLastAssistantText,
  type ReviewResult,
} from "../../../src/core/output.js";
import { loadContextSSH } from "../../../src/core/context.js";
import { extractDiffFiles } from "../../../src/core/diff-resolver.js";
import {
  loadSkillContext,
  loadSkillContextRemote,
  resolveSkillDirs,
} from "../../../src/core/skill-context.js";
import { filterDiff } from "../../../src/core/diff-filter.js";
import {
  buildJSONSystemPrompt,
  buildMarkdownSystemPrompt,
  buildUserPrompt,
  type MinSeverity,
} from "../../../src/core/prompt-builder.js";
import {
  readSshFlag,
  resolveSshState,
  localFs,
  sshFs as makeSshFs,
  sshExec,
} from "../../../src/core/ssh.js";
import { sumMessagesUsage } from "../events.js";
import { readDefaultBranch } from "../../../src/core/ui/server/index.js";
import { setReviewFooter } from "../footer.js";
import { handleUIReview } from "./ui.js";
import { buildContextGroups } from "./context.js";
import { buildSSHDiffCommand, buildSSHOriginBaseCommand, type ReviewCommandArgs } from "../args.js";
import type { CommonHandlerOptions } from "./types.js";

export function buildSSHSource(
  parsed: ReviewCommandArgs,
  opts: { branch?: string; head?: string; detectedBase?: string } = {},
): string {
  if (typeof parsed.pr === "number") return `PR #${parsed.pr}`;
  if (parsed.diff) return `git diff ${parsed.diff}`;
  const head = opts.head ?? "HEAD";
  const base = parsed.branch ?? opts.branch ?? opts.detectedBase ?? "origin/HEAD";
  return `${head} vs ${base}`;
}

export interface RunSSHOptions {
  systemPrompt: string;
  userPrompt: string;
  pi: ExtensionAPI;
  stopLoader: () => void;
  notify: (msg: string) => void;
}

export function runSSHReview(opts: RunSSHOptions): void {
  const { systemPrompt, userPrompt, pi, stopLoader, notify } = opts;
  let done = false;

  pi.on("before_agent_start", async () => {
    if (done) return {};
    return { systemPrompt };
  });

  pi.on("agent_end", async () => {
    if (done) return;
    done = true;
    stopLoader();
    notify("Review saved → pi-review.md");
  });

  pi.sendUserMessage(userPrompt);
}

export interface RunSSHWaitOptions {
  systemPrompt: string;
  userPrompt: string;
  diff: string;
  pi: ExtensionAPI;
  minSeverity: MinSeverity;
  stopLoader: () => void;
  notify: (msg: string, type?: "info" | "warning" | "error") => void;
}

export function runSSHReviewAndWait(opts: RunSSHWaitOptions): Promise<ReviewResult> {
  const { systemPrompt, userPrompt, diff, pi, minSeverity, stopLoader } = opts;
  let done = false;

  return new Promise<ReviewResult>((resolve, reject) => {
    pi.on("before_agent_start", async () => {
      if (done) return {};
      return { systemPrompt };
    });

    pi.on("agent_end", async (event) => {
      if (done) return;
      done = true;
      stopLoader();

      const text = extractLastAssistantText(event.messages);
      if (!text) {
        reject(new Error("SSH agent returned an empty response"));
        return;
      }

      try {
        const result = parseAgentResponse(text, minSeverity);
        const tokenUsage = sumMessagesUsage(event.messages);
        resolve({ ...result, diff, ...(tokenUsage ? { tokenUsage } : {}) });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    pi.sendUserMessage(userPrompt);
  });
}

export interface HandleSSHReviewOptions extends CommonHandlerOptions {
  parsed: ReviewCommandArgs;
  ctx: ExtensionContext;
}

export async function handleSSHReview(opts: HandleSSHReviewOptions): Promise<void> {
  const {
    parsed,
    ctx,
    pi,
    loaderState,
    minSeverity,
    currentModelId,
    thinking,
    defaultModel,
    availableModels,
    defaultThinking,
    notify,
  } = opts;

  notify("Fetching SSH diff and context…");
  const sshFlag = readSshFlag();
  const sshState = sshFlag ? await resolveSshState(sshFlag).catch(() => null) : null;
  const sshRemoteCwd = sshState
    ? parsed.dir
      ? path.posix.join(sshState.remoteCwd, parsed.dir)
      : sshState.remoteCwd
    : ctx.cwd;
  const providerFs = sshState ? makeSshFs(sshState.remote) : localFs();

  const gitCmd = `git -C ${JSON.stringify(sshRemoteCwd)}`;
  const [rawSshDiff, sshHeadBranch, sshOriginBase] = await Promise.all([
    sshState
      ? sshExec(
          sshState.remote,
          buildSSHDiffCommand(parsed, { remoteCwd: sshRemoteCwd, branch: readDefaultBranch() }),
        ).catch(() => "")
      : Promise.resolve(""),
    sshState
      ? sshExec(sshState.remote, `${gitCmd} rev-parse --abbrev-ref HEAD`).catch(() => "HEAD")
      : Promise.resolve("HEAD"),
    sshState
      ? sshExec(sshState.remote, buildSSHOriginBaseCommand(gitCmd)).catch(() => "origin/main")
      : Promise.resolve("origin/main"),
  ]);

  const {
    diff: sshDiff,
    warning: sshDiffWarning,
    skippedFiles: sshSkippedFiles,
  } = filterDiff(rawSshDiff);
  if (sshDiffWarning) notify(sshDiffWarning, "warning");

  // Context follows the filtered diff so providers and conventions describe
  // the files actually under review, matching local mode and CI. Trust uses
  // the raw list: files dropped by filterDiff stay attacker-controlled.
  const sshDiffFiles = extractDiffFiles(sshDiff);
  const sshTrustFiles = extractDiffFiles(rawSshDiff);
  const sshContext = sshState
    ? await loadContextSSH(
        sshState.remote,
        sshRemoteCwd,
        parsed.dir ? sshState.remoteCwd : undefined,
        sshDiffFiles,
      ).catch(() => ({ conventions: [], reviewRules: [] }))
    : { conventions: [], reviewRules: [] };

  const sshSkillDirs = resolveSkillDirs();
  const sshSkillContext =
    sshSkillDirs.length > 0
      ? await (
          sshState
            ? loadSkillContextRemote({
                remote: sshState.remote,
                fs: providerFs,
                remoteCwd: sshRemoteCwd,
                gitRoot: parsed.dir ? sshState.remoteCwd : undefined,
                trustFiles: sshTrustFiles,
                skillDirs: sshSkillDirs,
              })
            : loadSkillContext({
                cwd: ctx.cwd,
                trustFiles: sshTrustFiles,
                skillDirs: sshSkillDirs,
              })
        ).catch((error) => {
          notify(
            `Skills skipped: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
          return null;
        })
      : null;
  if (sshSkillContext && sshSkillContext.skills.length > 0) {
    notify(`Skills:\n${sshSkillContext.skills.map((s) => `  ${s.name}`).join("\n")}`);
  }
  for (const warning of sshSkillContext?.warnings ?? []) notify(warning, "warning");

  const source = buildSSHSource(parsed, {
    branch: readDefaultBranch(),
    head: sshHeadBranch.trim() || "HEAD",
    detectedBase: sshOriginBase.trim() || undefined,
  });

  const sshGitRoot = parsed.dir ? (sshState ? sshState.remoteCwd : ctx.cwd) : undefined;
  const {
    groups: sshAllContextGroups,
    contextFiles: sshContextFiles,
    contextPaths: allSshContextPaths,
  } = await buildContextGroups(
    pi.events,
    sshRemoteCwd,
    sshContext,
    sshDiffFiles,
    providerFs,
    sshGitRoot,
  );
  if (allSshContextPaths.length > 0)
    notify(`Context:\n${allSshContextPaths.map((p) => `  ${p}`).join("\n")}`);

  const userPrompt = buildUserPrompt(sshDiff, sshSkippedFiles);

  if (!parsed.ui) {
    const systemPrompt = buildMarkdownSystemPrompt(
      minSeverity,
      sshContext,
      sshContextFiles,
      sshSkillContext ?? undefined,
    );
    loaderState.stop = setReviewFooter(ctx, source, { model: currentModelId, thinking });
    runSSHReview({ systemPrompt, userPrompt, pi, stopLoader: loaderState.stop, notify });
    return;
  }

  const systemPrompt = buildJSONSystemPrompt(
    sshContext,
    minSeverity,
    sshContextFiles,
    undefined,
    undefined,
    undefined,
    undefined,
    sshSkillContext ? { skills: sshSkillContext } : undefined,
  );
  loaderState.stop = setReviewFooter(ctx, source, { model: currentModelId, thinking });
  const result = await runSSHReviewAndWait({
    systemPrompt,
    userPrompt,
    diff: sshDiff,
    pi,
    minSeverity,
    stopLoader: loaderState.stop,
    notify,
  });
  let sshSaveTriggered = false;
  const injectionMsg = await handleUIReview({
    result,
    diff: sshDiff,
    source,
    ssh: true,
    cwd: ctx.cwd,
    notify,
    currentModel: currentModelId,
    currentThinking: thinking,
    defaultModel,
    availableModels,
    defaultThinking,
    contextGroups: sshAllContextGroups,
    saveRemote: (md) => {
      sshSaveTriggered = true;
      pi.sendUserMessage(
        `Run \`git rev-parse --show-toplevel\` to get the project root path, then write the following content to that path + "/pi-review.md" (e.g. if the root is /some/path, write to /some/path/pi-review.md):\n\n${md}`,
      );
    },
  });
  if (injectionMsg) {
    if (sshSaveTriggered) {
      // ExtensionAPI has no .once(); guard with `sent` flag to fire only once
      let sent = false;
      pi.on("agent_end", async () => {
        if (sent) return;
        sent = true;
        pi.sendUserMessage(injectionMsg);
      });
    } else {
      pi.sendUserMessage(injectionMsg);
    }
  }
}
