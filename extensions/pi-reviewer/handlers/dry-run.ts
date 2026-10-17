import path from "node:path";

import { collectProviderContext, loadContext } from "../../../src/core/context.js";
import { resolveDiff, extractDiffFiles } from "../../../src/core/diff-resolver.js";
import { loadSkillContext, resolveSkillDirs } from "../../../src/core/skill-context.js";
import {
  buildJSONSystemPrompt,
  buildMarkdownSystemPrompt,
  buildSSHUserPrompt,
  buildUserPrompt,
} from "../../../src/core/prompt-builder.js";
import { readDefaultBranch } from "../../../src/core/ui/server/index.js";
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
  const dryDiffFiles = extractDiffFiles(diff);
  const context = await loadContext({
    cwd: parsed.dir ? path.resolve(cwd, parsed.dir) : cwd,
    gitRoot: parsed.dir ? cwd : undefined,
    diffFiles: dryDiffFiles,
  });
  const drySkillDirs = resolveSkillDirs();
  const drySkillContext =
    drySkillDirs.length > 0
      ? await loadSkillContext({
          cwd: parsed.dir ? path.resolve(cwd, parsed.dir) : cwd,
          diffFiles: dryDiffFiles,
          gitRoot: parsed.dir ? cwd : undefined,
          skillDirs: drySkillDirs,
        })
      : null;
  const dryContextFiles = (await collectProviderContext(pi.events, cwd, dryDiffFiles)).flatMap(
    (g) => g.files,
  );
  notify(`Diff source: ${source}`);
  const systemPrompt = buildJSONSystemPrompt(
    context,
    minSeverity,
    dryContextFiles,
    undefined,
    undefined,
    undefined,
    undefined,
    drySkillContext ? { skills: drySkillContext } : undefined,
  );
  notify(`System prompt:\n\n${systemPrompt}`);
  notify(`User prompt:\n\n${buildUserPrompt(diff, skippedFiles)}`);
}
