import path from "node:path";

import { collectProviderContext, loadContext } from "../../../src/core/context.js";
import { resolveDiff, extractDiffFiles } from "../../../src/core/diff-resolver.js";
import {
  buildJSONSystemPrompt,
  buildMarkdownSystemPrompt,
  buildSSHUserPrompt,
  buildUserPrompt,
} from "../../../src/core/prompt-builder.js";
import { readDefaultBranch } from "../../../src/core/ui/server/index.js";
import { deepWikiReviewInstruction, resolvePublicGitHubRepo } from "../../../src/core/deepwiki.js";
import { buildSSHDiffCommand, type ReviewCommandArgs } from "../args.js";
import type { CommonHandlerOptions } from "./types.js";

export interface HandleDryRunOptions extends CommonHandlerOptions {
  parsed: ReviewCommandArgs;
  cwd: string;
}

export async function handleDryRun(opts: HandleDryRunOptions): Promise<void> {
  const { parsed, cwd, pi, minSeverity, notify } = opts;

  if (parsed.ssh) {
    const drySSHContextFiles = (await collectProviderContext(pi.events, cwd, [])).flatMap(
      (g) => g.files,
    );
    notify(
      `System prompt:\n\n${buildMarkdownSystemPrompt(minSeverity, undefined, drySSHContextFiles)}`,
    );
    notify(`User prompt:\n\n${buildSSHUserPrompt(buildSSHDiffCommand(parsed))}`);
    return;
  }

  const { diff, source, skippedFiles } = await resolveDiff({
    cwd,
    diff: parsed.diff,
    branch: parsed.branch ?? readDefaultBranch(),
    pr: parsed.pr,
    dir: parsed.dir,
  });
  const context = await loadContext({
    cwd: parsed.dir ? path.resolve(cwd, parsed.dir) : cwd,
    gitRoot: parsed.dir ? cwd : undefined,
  });
  const dryDiffFiles = extractDiffFiles(diff);
  const dryContextFiles = (await collectProviderContext(pi.events, cwd, dryDiffFiles)).flatMap(
    (g) => g.files,
  );
  notify(`Diff source: ${source}`);
  let systemPrompt = buildJSONSystemPrompt(context, minSeverity, dryContextFiles);
  if (parsed.deepwiki) {
    const repo = await resolvePublicGitHubRepo(parsed.dir ? path.resolve(cwd, parsed.dir) : cwd);
    if (repo) systemPrompt = `${systemPrompt}\n\n${deepWikiReviewInstruction(repo)}`;
    else notify("DeepWiki unavailable; could not identify the repository under review", "warning");
  }
  notify(`System prompt:\n\n${systemPrompt}`);
  notify(`User prompt:\n\n${buildUserPrompt(diff, skippedFiles)}`);
}
