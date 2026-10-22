/**
 * The dependency mode's flow.
 *
 * The mode answers one question about the whole pull request: do the upgrades
 * it makes break this repository? The flow is therefore a single pass over
 * the complete range, not an incremental batch:
 *
 * 1. detect from git — the changed paths, and both ends of each changed
 *    manifest — so the size filter on the model-facing diff can never remove a
 *    manifest from the analysis;
 * 2. keep the upgrades whose change is breaking-relevant, and account for the
 *    ones that are not;
 * 3. resolve the upstream locations the model may read;
 * 4. run the review with the dependency profile, which publishes one
 *    disposition per upgrade; and
 * 5. report the result on the check run the caller created.
 *
 * A run with no qualifying upgrade never calls the model: the check still
 * reports, because a required check that goes missing is worse than a check
 * that says it found nothing to analyze.
 */

import { resolveRawDiff } from "../core/diff-resolver.js";
import { buildDependencyProfile } from "../core/review-profile.js";
import type { DependencyChange, VersionChangeKind } from "../core/dependency/types.js";
import { isBreakingRelevant } from "../core/dependency/threshold.js";
import { upgradeId } from "../core/dependency/upgrade-id.js";
import { publishableText } from "../core/credential-scan.js";

import {
  accountForUpgrades,
  type DependencyAccounting,
  type UpgradeAccount,
} from "./dependency/accounting.js";
import { buildDependencyAnchors } from "./dependency/anchors.js";
import { detectDependencyChanges, type DependencyDetection } from "./dependency/detect.js";
import { resolveUpstreams, type UpgradeResearch } from "./dependency/resolve.js";
import type { CheckRunAnalysis } from "./check-run.js";
import { log } from "./log.js";
import { prepareResearch } from "./research-preparation.js";
import { review, type ReviewOptions, type ReviewOutcome } from "./review.js";

/** How many entries of one kind the check summary lists before it counts the rest. */
const MAX_LISTED_ENTRIES = 50;

/** How much of one warning the check summary carries. */
const MAX_WARNING_LENGTH = 400;

/**
 * The options the dependency flow needs.
 *
 * The review options are the run's shared ones — the model, the thinking
 * level, the credentials, the trusted MCP and LSP configuration — minus
 * everything the flow decides itself: the range, the commit the review is
 * posted against, the profile, and the anchors.
 */
export interface DependencyCheckOptions {
  /** The checkout the git objects are read from. */
  repoCwd: string;
  /** The merge base of the pull request; the analysis range starts here. */
  mergeBase: string;
  /** The authenticated pull request head; the analysis range ends here. */
  headSha: string;
  /** The authenticated pull request number. */
  prNumber: number;
  /** The mode's batch marker, recording the whole pull request range. */
  batchMarker: string;
  /** The run's shared review options. */
  review: Omit<
    ReviewOptions,
    | "profile"
    | "dependencyAnchors"
    | "fromSha"
    | "commitId"
    | "pr"
    | "allowEmptyDiff"
    | "batchMarker"
    | "summaryOnly"
    | "dryRun"
    | "activeFindings"
    | "resolvedFindings"
    | "priorSummary"
  >;
}

/**
 * What the analysis published, as the check run reports it.
 *
 * The shape is the check run's own, so the flow's result and the lifecycle's
 * input cannot drift apart.
 */
export type DependencyCheckResult = CheckRunAnalysis;

/**
 * Runs the dependency analysis over the whole pull request range.
 *
 * Detection failures are thrown rather than summarized: a range the harness
 * could not read is not a range in which nothing changed, and a passing check
 * over it would gate the pull request on an analysis that never happened.
 */
export async function runDependencyCheck(
  options: DependencyCheckOptions,
): Promise<DependencyCheckResult> {
  const detection = detectDependencyChanges(options.repoCwd, options.mergeBase, options.headSha);
  if (detection.error)
    throw new Error(`The dependency analysis could not read the range: ${detection.error}`);
  const analyzed = detection.changes.filter(isBreakingRelevant);
  const skipped = detection.changes.filter((change) => !isBreakingRelevant(change));
  log.info("dependency.detected", "Detected dependency changes", {
    changes: detection.changes.length,
    analyzed: analyzed.length,
    skipped: skipped.length,
    unsupported: detection.unsupported.length,
    warnings: detection.warnings.length,
  });

  // The anchors come from the same range the review resolves, so a warning the
  // harness writes sits on the line the upgrade changed on.
  const raw = await resolveRawDiff({
    cwd: options.repoCwd,
    fromSha: options.mergeBase,
    toSha: options.headSha,
    allowEmpty: true,
  });
  const anchors = buildDependencyAnchors(analyzed, raw.raw);

  if (analyzed.length === 0) {
    // The check always reports. No model is called, because there is nothing
    // for it to analyze: a patch bump is coverage, not an upgrade.
    log.info(
      "dependency.analysis.empty",
      "No breaking-relevant upgrade in the range; the check reports without a review",
    );
    return {
      findings: [],
      diff: raw.raw,
      summary: renderDependencySummary({ detection, analyzed, skipped }),
    };
  }

  const readers = prepareResearch(process.env, { token: options.review.githubToken }).readers;
  const resolutions = await resolveUpstreams(analyzed, analyzed.map(upgradeId), readers);
  const resolvedCount = resolutions.filter((entry) => entry.candidates.length > 0).length;
  log.info("dependency.upstreams.resolved", "Resolved upstream locations", {
    upgrades: analyzed.length,
    resolved: resolvedCount,
    unresolved: analyzed.length - resolvedCount,
  });

  const profile = buildDependencyProfile(analyzed, resolutions);
  const outcome = await review({
    ...options.review,
    pr: options.prNumber,
    commitId: options.headSha,
    fromSha: options.mergeBase,
    allowEmptyDiff: false,
    batchMarker: options.batchMarker,
    profile,
    dependencyAnchors: anchors,
  });

  // The dispositions are recomputed from the decision with the same pure
  // validator the review used, so the summary and the coverage findings cannot
  // describe the same run differently.
  const accounting =
    outcome.kind === "published"
      ? accountForUpgrades(profile.changes, profile.resolutions, reportedResearch(outcome))
      : undefined;

  return {
    findings: outcome.kind === "published" ? outcome.findings : [],
    diff: outcome.kind === "published" ? outcome.diff : raw.raw,
    summary: renderDependencySummary({ detection, analyzed, skipped, accounting }),
  };
}

/** The research dispositions a decision carries, under either action. */
function reportedResearch(
  outcome: Extract<ReviewOutcome, { kind: "published" }>,
): readonly UpgradeResearch[] {
  return outcome.decision.action === "review"
    ? (outcome.decision.result.research ?? [])
    : (outcome.decision.research ?? []);
}

/** The values the check summary is built from. */
interface DependencySummaryInput {
  detection: DependencyDetection;
  analyzed: readonly DependencyChange[];
  skipped: readonly DependencyChange[];
  accounting?: DependencyAccounting;
}

/**
 * The check run's summary.
 *
 * It reports coverage rather than a bare count: what was analyzed, what was
 * not and why, and — for every analyzed upgrade — the disposition the
 * analysis published. *Researched* is the model's assertion: the harness
 * checks which upgrade a disposition belongs to, not that the release notes
 * were read.
 */
export function renderDependencySummary(input: DependencySummaryInput): string {
  const { detection, analyzed, skipped, accounting } = input;
  const lines: string[] = [];
  lines.push(
    `Analyzed ${count(analyzed.length, "breaking-relevant upgrade")} in ${count(
      new Set(detection.changes.map((change) => change.manifest)).size,
      "changed manifest",
    )}.`,
  );

  if (accounting) {
    const researched = accounting.accounts.filter((account) => account.unverifiable === undefined);
    const unverifiable = accounting.accounts.filter(
      (account) => account.unverifiable !== undefined,
    );
    lines.push(
      `Reported researched: ${researched.length}. Unverifiable: ${unverifiable.length}.`,
      "",
      "### Upgrades analyzed",
      "",
    );
    for (const account of accounting.accounts.slice(0, MAX_LISTED_ENTRIES)) {
      lines.push(`- ${describeAccount(account, resolutionOf(account.id, analyzed))}`);
    }
    if (accounting.accounts.length > MAX_LISTED_ENTRIES)
      lines.push(`- …and ${accounting.accounts.length - MAX_LISTED_ENTRIES} more`);
  }

  if (skipped.length > 0) {
    lines.push("", "### Not analyzed", "");
    for (const change of skipped.slice(0, MAX_LISTED_ENTRIES))
      lines.push(`- ${describeChange(change)} — ${describeSkip(change)}`);
    if (skipped.length > MAX_LISTED_ENTRIES)
      lines.push(`- …and ${skipped.length - MAX_LISTED_ENTRIES} more`);
  }

  if (detection.warnings.length > 0) {
    lines.push("", "### Coverage gaps", "");
    for (const warning of detection.warnings.slice(0, MAX_LISTED_ENTRIES))
      lines.push(`- ${bounded(warning)}`);
    if (detection.warnings.length > MAX_LISTED_ENTRIES)
      lines.push(`- …and ${detection.warnings.length - MAX_LISTED_ENTRIES} more`);
  }

  if (detection.unsupported.length > 0) {
    lines.push("", "### Unsupported manifests", "");
    for (const manifest of detection.unsupported.slice(0, MAX_LISTED_ENTRIES))
      lines.push(`- ${codeSpan(manifest)}`);
    if (detection.unsupported.length > MAX_LISTED_ENTRIES)
      lines.push(`- …and ${detection.unsupported.length - MAX_LISTED_ENTRIES} more`);
  }

  if (accounting && accounting.diagnostics.length > 0) {
    lines.push("", "### Dispositions the harness did not accept", "");
    for (const diagnostic of accounting.diagnostics.slice(0, MAX_LISTED_ENTRIES))
      lines.push(`- ${bounded(publishableText(diagnostic))}`);
    if (accounting.diagnostics.length > MAX_LISTED_ENTRIES)
      lines.push(`- …and ${accounting.diagnostics.length - MAX_LISTED_ENTRIES} more`);
  }

  if (!accounting)
    lines.push(
      "",
      "No breaking-relevant upgrade was found, so the model was not asked to research anything.",
    );

  return lines.join("\n");
}

/** The change a reported account belongs to, for its version range. */
function resolutionOf(
  id: string,
  analyzed: readonly DependencyChange[],
): DependencyChange | undefined {
  return analyzed.find((change) => upgradeId(change) === id);
}

/** One analyzed upgrade, and what the analysis published about it. */
function describeAccount(account: UpgradeAccount, change: DependencyChange | undefined): string {
  const subject =
    account.name === undefined
      ? `upgrade ${codeSpan(account.id)}`
      : `${codeSpan(account.name)}${change ? ` ${describeRange(change)}` : ""}${
          account.manifest ? ` in ${codeSpan(account.manifest)}` : ""
        }`;
  // Every string below is model-reported or registry-reported, so each one is
  // scanned before it is published: a credential shape is replaced, never
  // rendered, and the disposition it belongs to survives.
  if (account.unverifiable !== undefined)
    return `${subject} — **unverifiable** — ${bounded(publishableText(account.unverifiable))}`;
  if (account.checkoutPath !== undefined)
    // A local citation is a path in the checkout, not a source the harness
    // opened or verified: the reader is told exactly what it is.
    return `${subject} — researched via ${codeSpan(publishableText(account.checkoutPath))} (a path in the checkout; the harness did not open it)`;
  const citation = account.citation?.startsWith("candidate:")
    ? account.citation.slice("candidate:".length)
    : account.citation;
  return `${subject} — researched via candidate ${codeSpan(publishableText(citation ?? "unknown"))}`;
}

/** One change the analysis did not analyze. */
function describeChange(change: DependencyChange): string {
  return `${codeSpan(change.name)} ${describeRange(change)} in ${codeSpan(change.manifest)}`;
}

/**
 * Why a change was not analyzed.
 *
 * Keyed by the closed kind union, so a kind added to the vocabulary is a
 * compile error here rather than an unlabelled row in the summary.
 */
const SKIP_REASON: Record<VersionChangeKind, string> = {
  // A major and a pre-1.0 minor change are always analyzed, so these two
  // entries describe a state the filter cannot produce.
  major: "a major change the filter did not analyze",
  "pre-1.0-minor": "a pre-1.0 minor change the filter did not analyze",
  minor: "a library minor change, below the threshold",
  patch: "a patch change, below the threshold",
  downgrade: "a downgrade",
  unresolved: "a version the harness could not compare",
  added: "an added dependency",
  removed: "a removed dependency",
};

/** Why a change was not analyzed. */
function describeSkip(change: DependencyChange): string {
  return SKIP_REASON[change.kind];
}

/** The version range a change spans, as the report writes it. */
function describeRange(change: DependencyChange): string {
  const from = change.from ?? (change.fromVersion ? `v${change.fromVersion}` : "?");
  const to = change.to ?? (change.toVersion ? `v${change.toVersion}` : "?");
  return `${codeSpan(from)} → ${codeSpan(to)}`;
}

/** `1 upgrade` / `2 upgrades`, without a pluralization library. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * A value as a code span.
 *
 * The value came from a manifest or from metadata a package author wrote, so
 * it is held to text: a backtick would close the span and a control character
 * is not text.
 */
function codeSpan(value: string): string {
  const readable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/`/g, "'");
  return `\`${readable}\``;
}

/** A harness-written line, bounded. */
function bounded(value: string): string {
  const readable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("")
    .replace(/`/g, "'")
    .trim();
  if (readable.length <= MAX_WARNING_LENGTH) return readable;
  return `${readable.slice(0, MAX_WARNING_LENGTH - 1)}…`;
}
