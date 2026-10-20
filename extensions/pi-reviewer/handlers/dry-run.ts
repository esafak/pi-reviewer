import path from "node:path";

import { collectProviderContext, loadContext } from "../../../src/core/context.js";
import { resolveRawDiff, extractDiffFiles } from "../../../src/core/diff-resolver.js";
import {
  filterDiff,
  resolveExplicitMaxDiffChars,
  resolveMaxDiffChars,
  stripNoiseFiles,
} from "../../../src/core/diff-filter.js";
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
  const { parsed, cwd, pi, minSeverity, notify, currentModelId } = opts;

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

  const { raw, source, changedFiles } = await resolveRawDiff({
    cwd,
    diff: parsed.diff,
    branch: parsed.branch ?? readDefaultBranch(),
    pr: parsed.pr,
    dir: parsed.dir,
  });
  // Context covers the noise-stripped candidate set — every file the final
  // size filter could keep (size selection skips rather than prefixing).
  const explicitMaxDiffChars = resolveExplicitMaxDiffChars(parsed.maxDiffChars);
  const dryDiffFiles = extractDiffFiles(stripNoiseFiles(raw).kept.join(""));
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
          trustFiles: changedFiles,
          gitRoot: parsed.dir ? cwd : undefined,
          skillDirs: drySkillDirs,
        })
      : null;
  const dryContextFiles = (await collectProviderContext(pi.events, cwd, dryDiffFiles)).flatMap(
    (g) => g.files,
  );
  notify(`Diff source: ${source}`);
  if (drySkillContext && drySkillContext.skills.length > 0) {
    notify(`Skills:\n${drySkillContext.skills.map((s) => `  ${s.name}`).join("\n")}`);
  }
  for (const warning of drySkillContext?.warnings ?? []) notify(warning, "warning");
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
  // The cap follows the same rule as a real review; an unset model falls back.
  const { diff, skippedFiles } = filterDiff(
    raw,
    resolveMaxDiffChars({
      explicit: explicitMaxDiffChars,
      model: currentModelId,
      nonDiffChars: systemPrompt.length,
    }),
  );
  notify(`System prompt:\n\n${systemPrompt}`);
  notify(`User prompt:\n\n${buildUserPrompt(diff, skippedFiles)}`);
}
