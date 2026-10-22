/**
 * The check run lifecycle of the dependency mode.
 *
 * A check run is the gate: branch protection can require it, and its
 * annotations are what a reviewer sees next to the pull request's diff. Two
 * rules shape this module.
 *
 * - **Every execution creates its own run.** The Checks API *appends*
 *   annotations on update, so a run from an earlier execution is never
 *   reused — it would keep that run's stale annotations. The name stays
 *   stable across runs so branch protection can require it, and the latest
 *   run with that name is the one branch protection evaluates.
 * - **A failure to publish is a warning.** A repository whose workflow
 *   grants `contents: read` and `pull-requests: write` but no
 *   `checks: write` still gets its review, so nothing here is ever raised
 *   as a failure of the action.
 */

import { commentIdentity, partitionComments, parseDiffPositions } from "../core/diff-positions.js";
import type { PublishedFinding, ReviewComment } from "../core/output.js";
import { SEVERITY_RANK, type Severity } from "../core/severity.js";
import type { CheckRun, CheckRunAnnotation, CheckRunConclusion, GitHubClient } from "./github.js";
import { log } from "./log.js";

/**
 * The check run's name.
 *
 * The name is a contract with the repository's branch protection
 * configuration: a required status check is matched by its exact name, so
 * a name a workflow and a branch protection rule could disagree on would
 * block every pull request on a check that never reports. It is therefore
 * fixed rather than configurable, and it cannot change without orphaning
 * every check that requires it. It stays stable across runs, and the
 * latest run with that name is the one branch protection evaluates.
 *
 * It is deliberately not the workflow job's name. The job's own check run
 * succeeds whenever the action exits cleanly — and the action exits
 * cleanly even when the analysis fails — so a required context that both
 * shared would be satisfied by the job and the gate would never fail.
 */
export const CHECK_RUN_NAME = "pi-reviewer/breaking-changes";

/** The API takes at most 50 annotations per request. */
export const MAX_ANNOTATIONS_PER_REQUEST = 50;

/** The API rejects an annotation message longer than this. */
export const MAX_ANNOTATION_MESSAGE_BYTES = 65535;

/** The API rejects a check summary longer than this. */
export const MAX_CHECK_SUMMARY_BYTES = 65535;

/** How many unannotated findings the summary names before it counts the rest. */
const MAX_LISTED_UNANNOTATED_FINDINGS = 50;

/** How much of a finding's body the summary quotes. */
const MAX_EXCERPT_LENGTH = 200;

/** The marker a truncated text carries. */
const TRUNCATION_MARKER = "\n\n… (truncated)";

/** The title the check run's output carries. */
export const CHECK_OUTPUT_TITLE = "Dependency breaking-change analysis";

/** The summary a check run carries while the analysis is still running. */
export const CHECK_IN_PROGRESS_SUMMARY = "The breaking-change analysis is running.";

/** The annotation level each severity is reported as. */
const ANNOTATION_LEVEL: Record<Severity, CheckRunAnnotation["annotation_level"]> = {
  CRITICAL: "failure",
  WARN: "warning",
  INFO: "notice",
};

/** The annotation level a severity is reported as. */
export function annotationLevel(severity: Severity): CheckRunAnnotation["annotation_level"] {
  return ANNOTATION_LEVEL[severity];
}

/**
 * The conclusion the published findings decide.
 *
 * The gate is computed over *all* the published findings, not only the ones
 * that could be annotated: a finding the harness could not place on the diff
 * is still a finding the reviewer must see.
 */
export function conclusionFor(findings: readonly PublishedFinding[]): CheckRunConclusion {
  return findings.some((finding) => finding.severity === "CRITICAL") ? "failure" : "success";
}

/** The findings as the check run reports them. */
export interface CheckRunMapping {
  /** The annotations the findings produced, in the findings' order. */
  annotations: CheckRunAnnotation[];
  /** The findings that could not be annotated; the check summary names them. */
  unannotated: PublishedFinding[];
}

/** A finding and the review comment its annotation would carry. */
interface AnnotatableFinding {
  finding: PublishedFinding;
  comment: ReviewComment;
  /** The identity the finding is published under. */
  identity: string;
}

/**
 * Maps the published findings onto the check run's annotations.
 *
 * A check annotation has no side: it always refers to the head file of the
 * commit the run belongs to. A finding on a removed line — the LEFT side of
 * the diff — therefore has no annotation, and neither has a finding whose
 * line is not in the diff. The rest are named in the check summary, so a
 * finding is never silently dropped.
 *
 * A finding that repeats the identity of an earlier one is the same
 * finding: it is published once, as one annotation, and it is not named
 * again.
 */
export function toAnnotations(
  findings: readonly PublishedFinding[],
  diff: string,
): CheckRunMapping {
  const resolved = resolveFindings(findings);
  const positions = parseDiffPositions(diff);
  const pairs: AnnotatableFinding[] = [];
  for (const [identity, finding] of resolved) {
    const comment = annotatableComment(finding);
    if (comment) pairs.push({ finding, comment, identity });
  }

  const { inline } = partitionComments(
    pairs.map((pair) => pair.comment),
    positions,
  );
  const annotated = new Set(inline);
  const annotations: CheckRunAnnotation[] = [];
  const annotatedIdentities = new Set<string>();
  for (const pair of pairs) {
    if (!annotated.has(pair.comment)) continue;
    annotations.push(toAnnotation(pair.comment, pair.finding));
    annotatedIdentities.add(pair.identity);
  }

  const unannotated: PublishedFinding[] = [];
  for (const [identity, finding] of resolved) {
    if (!annotatedIdentities.has(identity)) unannotated.push(finding);
  }
  return { annotations, unannotated };
}

/** The check run a dependency analysis reports into. */
export interface CreateCheckRunOptions {
  repo: string;
  /** The commit the check run belongs to. */
  headSha: string;
}

/**
 * Creates the check run the analysis reports into.
 *
 * The run is created `in_progress` and concluded by
 * `concludeDependencyCheckRun`, so a failure in the analysis still leaves a
 * terminal conclusion.
 *
 * A failure is a warning: the run is not created, the caller carries on,
 * and the review is still posted.
 */
export async function createDependencyCheckRun(
  client: GitHubClient,
  options: CreateCheckRunOptions,
): Promise<CheckRun | undefined> {
  try {
    return await client.createCheckRun(options.repo, {
      head_sha: options.headSha,
      name: CHECK_RUN_NAME,
      status: "in_progress",
      output: { title: CHECK_OUTPUT_TITLE, summary: CHECK_IN_PROGRESS_SUMMARY },
    });
  } catch (error) {
    log.warn("check_run.create_failed", "Could not create the check run", {
      repo: options.repo,
      error: errorMessage(error),
    });
    return undefined;
  }
}

/** What a check run concludes with. */
export interface ConcludeCheckRunOptions {
  repo: string;
  /** The check run's id. */
  id: number;
  /** The published findings the annotations are built from. */
  findings: readonly PublishedFinding[];
  /** The diff the findings were positioned against. */
  diff: string;
  /** The summary the check reports; the findings that could not be annotated are named in it. */
  summary: string;
  /**
   * Concludes the run `failure`, whatever the findings say.
   *
   * The gate belongs to the findings, and a caller may only make it
   * stricter: an analysis that ended in an error has no findings to gate
   * on, and it must not report a passing check.
   */
  failed?: boolean;
}

/**
 * Concludes the check run with the findings the analysis published.
 *
 * The annotations are sent in chunks of at most 50, which is the API's
 * per-request limit. The first update carries the conclusion, and the later
 * ones append the remaining annotations to the run it concluded — the API
 * appends annotations rather than replacing them, so one update per chunk
 * publishes them all.
 *
 * A failure is a warning: the review is still posted.
 */
export async function concludeDependencyCheckRun(
  client: GitHubClient,
  options: ConcludeCheckRunOptions,
): Promise<boolean> {
  try {
    const { annotations, unannotated } = toAnnotations(options.findings, options.diff);
    const conclusion = options.failed ? "failure" : conclusionFor(options.findings);
    const summary = renderCheckSummary(options.summary, unannotated);
    for (const chunk of chunkAnnotations(annotations)) {
      await client.updateCheckRun(options.repo, options.id, {
        status: "completed",
        conclusion,
        output: {
          title: CHECK_OUTPUT_TITLE,
          summary,
          ...(chunk.length ? { annotations: chunk } : {}),
        },
      });
    }
    return true;
  } catch (error) {
    log.warn("check_run.update_failed", "Could not conclude the check run", {
      repo: options.repo,
      error: errorMessage(error),
    });
    return false;
  }
}

/**
 * The findings to publish, one per finding identity.
 *
 * A finding that repeats the identity of an earlier one is the same
 * finding: it is published once. The repeated one keeps the higher
 * severity, so what a reader sees does not depend on the order the
 * findings arrived in — and the rule is applied once, so the annotation
 * and the summary cannot resolve the same pair differently.
 */
function resolveFindings(findings: readonly PublishedFinding[]): Map<string, PublishedFinding> {
  const resolved = new Map<string, PublishedFinding>();
  for (const finding of findings) {
    const identity = findingIdentity(finding);
    const seen = resolved.get(identity);
    if (seen && SEVERITY_RANK[seen.severity] >= SEVERITY_RANK[finding.severity]) continue;
    resolved.set(identity, finding);
  }
  return resolved;
}

/**
 * The identity a finding is published under.
 *
 * A finding with a position is identified the way the partition identifies
 * a comment, so the module's notion of "the same finding" is the review's.
 * A finding without one is identified by its body, so a repeated body-only
 * finding is published once.
 */
function findingIdentity(finding: PublishedFinding): string {
  if (finding.file === undefined || finding.line === undefined) return `body:${finding.body}`;
  return commentIdentity({
    file: finding.file,
    line: finding.line,
    side: finding.side ?? "RIGHT",
    body: finding.body,
  });
}

/**
 * The review comment an annotation would carry, or undefined when the
 * finding cannot be one.
 *
 * A finding with no position is published in the review body rather than
 * inline, and a finding on a removed line names a line the head file does
 * not have.
 */
function annotatableComment(finding: PublishedFinding): ReviewComment | undefined {
  if (finding.file === undefined || finding.line === undefined) return undefined;
  if (finding.side === "LEFT") return undefined;
  return {
    file: finding.file,
    line: finding.line,
    side: "RIGHT",
    severity: finding.severity,
    body: finding.body,
  };
}

function toAnnotation(comment: ReviewComment, finding: PublishedFinding): CheckRunAnnotation {
  return {
    path: comment.file,
    start_line: comment.line,
    end_line: comment.line,
    annotation_level: annotationLevel(finding.severity),
    message: truncate(finding.body, MAX_ANNOTATION_MESSAGE_BYTES),
    title: finding.severity,
  };
}

/**
 * Splits the annotations into the requests the API accepts.
 *
 * The list always holds at least one chunk: a run with no annotation is
 * still concluded.
 */
function chunkAnnotations(annotations: readonly CheckRunAnnotation[]): CheckRunAnnotation[][] {
  if (annotations.length === 0) return [[]];
  const chunks: CheckRunAnnotation[][] = [];
  for (let index = 0; index < annotations.length; index += MAX_ANNOTATIONS_PER_REQUEST)
    chunks.push(annotations.slice(index, index + MAX_ANNOTATIONS_PER_REQUEST));
  return chunks;
}

/**
 * The check summary: the caller's summary, and the findings that could not
 * be annotated named in it.
 *
 * The section is never cut: the caller's summary is shortened to leave room
 * for it, because the section is the coverage the annotations cannot carry.
 */
function renderCheckSummary(summary: string, unannotated: readonly PublishedFinding[]): string {
  if (unannotated.length === 0) return truncate(summary, MAX_CHECK_SUMMARY_BYTES);
  const section = renderUnannotatedSection(unannotated);
  const separator = "\n\n";
  const room = Math.max(
    0,
    MAX_CHECK_SUMMARY_BYTES -
      Buffer.byteLength(section, "utf8") -
      Buffer.byteLength(separator, "utf8"),
  );
  const head = truncate(summary, room);
  return head ? `${head}${separator}${section}` : section;
}

/** The section of the summary that names the findings without an annotation. */
function renderUnannotatedSection(unannotated: readonly PublishedFinding[]): string {
  const shown = unannotated.slice(0, MAX_LISTED_UNANNOTATED_FINDINGS);
  const lines = shown.map((finding) => `- ${describeFinding(finding)}`);
  if (unannotated.length > shown.length)
    lines.push(`- …and ${unannotated.length - shown.length} more`);
  return truncate(
    ["### Findings that could not be annotated", "", ...lines].join("\n"),
    MAX_CHECK_SUMMARY_BYTES,
  );
}

/** How a finding is named in the check summary. */
function describeFinding(finding: PublishedFinding): string {
  const position = describePosition(finding);
  const excerpt = findingExcerpt(finding.body);
  return excerpt
    ? `${position} — ${finding.severity} — ${excerpt}`
    : `${position} — ${finding.severity}`;
}

/**
 * How a finding's position is named in the check summary.
 *
 * A finding on a removed line names a line the head file does not have, and
 * the summary says so rather than pointing at an unrelated line.
 */
function describePosition(finding: PublishedFinding): string {
  if (finding.file === undefined || finding.line === undefined) return "no position";
  const place = `\`${finding.file.replace(/`/g, "'")}:${finding.line}\``;
  return finding.side === "LEFT" ? `${place} (removed line)` : place;
}

/** The first line of a finding's body, bounded. */
function findingExcerpt(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= MAX_EXCERPT_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

/**
 * Truncates a text to the API's limit, which is a size in bytes.
 *
 * A byte is not a character: a message of 65535 characters can be twice
 * that in bytes, and the API would reject it. The text is cut on a
 * character boundary, never inside a character, and — when the budget
 * leaves room for it — the cut is marked, so a reader can see that it was
 * cut.
 */
function truncate(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  if (markerBytes >= maxBytes) return cutToBytes(text, maxBytes);
  return `${cutToBytes(text, maxBytes - markerBytes)}${TRUNCATION_MARKER}`;
}

/**
 * Cuts a text to a number of bytes, on a character boundary.
 *
 * The cut never falls inside a character, so the result is always text
 * rather than half a surrogate pair.
 */
function cutToBytes(text: string, budget: number): string {
  if (budget <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    bytes += size;
    end += character.length;
  }
  return text.slice(0, end);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
