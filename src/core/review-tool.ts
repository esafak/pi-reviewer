import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";

import type { ReviewResult } from "./output.js";
import { hasAiFixProse, MEANINGFUL_PROSE_PATTERN } from "./ai-fix-footer.js";

/**
 * What the review agent decided. The model declares this via the
 * `submit_review` tool; the harness dispatches deterministically:
 *   - "review": publish the structured review (findings and/or summary).
 *   - "none":   nothing to publish; the harness acknowledges the PR itself
 *               (a reaction, when the PR has no open findings) rather than
 *               posting a body.
 */
export type ReviewDecision = { action: "review"; result: ReviewResult } | { action: "none" };

const summaryField = Type.Optional(
  Type.String({
    description:
      'Overall review written in Markdown. Required for action "review"; omit for "none". Use bullet points and bold for clarity. In JSON, encode each Markdown newline once as \\n; never double-escape formatting newlines as \\\\n.',
  }),
);
const prSummaryField = Type.Optional(
  Type.String({
    maxLength: 2000,
    description:
      "What/Why/Risk overview of the shown diff for the PR summary block. What: bulleted file/feature changes. Why: inferred intent, labeled as inference. Risks: edge cases and follow-ups. Structure the overview with `### What`, `### Why`, and `### Risks` Markdown headings — never bold text. Markdown with single-escaped newlines; at most 2000 characters. Omit entirely for follow-up batches or when summary output is disabled.",
  }),
);
const prDiagramField = Type.Optional(
  Type.String({
    maxLength: 1500,
    description:
      "Raw Mermaid source (no fences) for the PR summary block, at most 1500 characters. Emit only when the diff introduces or alters a multi-component interaction (new subsystem, cross-file flow, changed state machine); prefer flowchart TD for structure and sequenceDiagram for call order. Omit for localized changes.",
  }),
);
const commentsField = Type.Optional(
  Type.Array(
    Type.Object(
      {
        file: Type.String({ description: "Relative path from repo root." }),
        line: Type.Number({
          minimum: 1,
          multipleOf: 1,
          description:
            "Positive integer line number of a changed or context line within a diff hunk. Only lines that appear in the diff can receive comments — do not comment on arbitrary lines outside the diff.",
        }),
        side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")], {
          description: '"RIGHT" for added/context lines, "LEFT" for removed lines.',
        }),
        severity: Type.Union(
          [Type.Literal("CRITICAL"), Type.Literal("WARN"), Type.Literal("INFO")],
          {
            description: "Issue severity tier.",
          },
        ),
        body: Type.String({
          minLength: 1,
          pattern: MEANINGFUL_PROSE_PATTERN,
          description:
            "Non-empty inline comment text containing meaningful prose, may use Markdown.",
        }),
        suggestion: Type.Optional(
          Type.String({
            description:
              "Optional replacement code for this finding. Provide only when a concrete replacement is useful; an empty string intentionally deletes the anchored line. Applies to one RIGHT-side line, though replacement code may span multiple lines.",
          }),
        ),
        resolved_finding_id: Type.Optional(Type.String({ maxLength: 200 })),
        re_raise_reason: Type.Optional(
          Type.Union([
            Type.Literal("REINTRODUCED"),
            Type.Literal("MATERIALLY_CHANGED"),
            Type.Literal("CONTRADICTORY_EVIDENCE"),
          ]),
        ),
        re_raise_evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
      },
      { additionalProperties: false },
    ),
    {
      description:
        'Inline comments attached to specific diff lines. May be an empty array when finding_updates or the PR overview carries the review; otherwise prefer "none" over an empty review. Omit for "none".',
    },
  ),
);
const findingUpdatesField = Type.Optional(
  Type.Array(
    Type.Object(
      {
        comment_id: Type.Integer({
          minimum: 1,
          description: "ID of an existing finding supplied in the prompt.",
        }),
        status: Type.Union([
          Type.Literal("RESOLVED"),
          Type.Literal("PARTIALLY_RESOLVED"),
          Type.Literal("STILL_OPEN"),
        ]),
        explanation: Type.String({ maxLength: 2000 }),
      },
      { additionalProperties: false },
    ),
  ),
);

const ACTION_DESCRIPTION =
  '"review" to publish comments, finding_updates, and/or the PR overview; "none" when there is nothing to publish (no comments, no updates, no overview — never file a no-findings review).';

/**
 * TypeBox schema for the `submit_review` tool parameters.
 *
 * This schema reaches the model provider as the tool's `input_schema`
 * (Anthropic) / `parameters` (OpenAI), giving schema-validated structured
 * output without relying on text parsing. `validateToolArguments` runs
 * client-side before `execute`, so invalid args are rejected and sent back to
 * the model as an error tool result for auto-retry.
 *
 * The output is a discriminated object keyed by `action`, not a top-level
 * union: a top-level union serializes to `anyOf`, which is not a usable tool
 * schema (see reply-tool.ts). Fields that only apply to `action: "review"` are
 * therefore optional here and enforced in `execute`.
 *
 * `action` names only what the model has — content to publish, or nothing —
 * never a harness outcome (a reaction, a comment) whose policy and state the
 * harness owns. The schema is therefore constant across runs.
 */
export const reviewSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("review"), Type.Literal("none")], {
      description: ACTION_DESCRIPTION,
    }),
    summary: summaryField,
    pr_summary: prSummaryField,
    pr_diagram: prDiagramField,
    comments: commentsField,
    finding_updates: findingUpdatesField,
  },
  { additionalProperties: false },
);

type ReviewParams = Static<typeof reviewSchema>;

export interface ReviewTool {
  tool: AgentTool<typeof reviewSchema, ReviewParams>;
  getResult: () => ReviewDecision | undefined;
}

/**
 * Turn validated tool arguments into the harness dispatch decision. Per-action
 * required fields are enforced here because the transport requires a single
 * flat object (see `reviewSchema`); a violation throws and is returned to the
 * model as an error tool result for auto-retry.
 */
function normalizeDecision(params: ReviewParams): ReviewDecision {
  if (params.action === "none") {
    if (
      params.summary !== undefined ||
      params.pr_summary !== undefined ||
      params.pr_diagram !== undefined ||
      params.comments !== undefined ||
      params.finding_updates !== undefined
    ) {
      throw new Error('action "none" must not carry review fields');
    }
    return { action: "none" };
  }
  if (typeof params.summary !== "string" || params.summary.trim() === "") {
    throw new Error('"summary" is required for action "review"');
  }
  const comments = params.comments ?? [];
  if (comments.some((comment) => !hasAiFixProse(comment.body))) {
    throw new Error("Finding body must contain meaningful prose");
  }
  return {
    action: "review",
    result: {
      summary: params.summary,
      comments: comments as ReviewResult["comments"],
      finding_updates: params.finding_updates ?? [],
      ...(params.pr_summary !== undefined ? { pr_summary: params.pr_summary } : {}),
      ...(params.pr_diagram !== undefined ? { pr_diagram: params.pr_diagram } : {}),
    },
  };
}

/**
 * Create a `submit_review` tool that lets compliant models return the review as
 * a schema-validated tool call instead of emitting JSON as text.
 *
 * The tool is a plain `AgentTool` (4-arg `execute`, no `ctx`) — matching the
 * bare in-process `Agent` call site used in CI mode.
 *
 * `terminate: true` is set as a batch-conditional optimization: when
 * `submit_review` is the sole tool call in its batch the inner agent loop ends
 * immediately. When batched with read-only tools it does not, but the result
 * is always captured via the closure and read in the `agent_end` handler
 * regardless of how the loop terminates.
 */
export function createReviewTool(): ReviewTool {
  let captured: ReviewDecision | undefined;

  const tool: AgentTool<typeof reviewSchema, ReviewParams> = {
    name: "submit_review",
    label: "submit_review",
    description:
      'Submit the final code review. Call this as your final action after reviewing the diff: declare "review" with comments, finding_updates, and/or the PR overview, or "none" when there is nothing to publish. A clean diff with nothing to report is "none" rather than a "review" with empty comments. Pass the complete result as structured data — do not also emit it as text.',
    parameters: reviewSchema,
    async execute(_toolCallId: string, params: ReviewParams) {
      captured = normalizeDecision(params);
      return {
        content: [{ type: "text" as const, text: "Review submitted." }],
        details: params,
        terminate: true,
      };
    },
  };

  return {
    tool,
    getResult: () => captured,
  };
}
