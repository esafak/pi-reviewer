import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";

import type { ReviewResult } from "./output.js";
import { hasAiFixProse, MEANINGFUL_PROSE_PATTERN } from "./ai-fix-footer.js";
import type { CodeProfile, DependencyProfile, ReviewProfile } from "./review-profile.js";
import type { UpgradeResearch } from "../ci/dependency/resolve.js";

/**
 * What the review agent decided. The model declares this via the
 * `submit_review` tool; the harness dispatches deterministically:
 *   - "review": publish the structured review (findings and/or summary).
 *   - "none":   nothing to publish; the harness acknowledges the PR itself
 *               (a reaction, when the PR has no open findings) rather than
 *               posting a body.
 *
 * The `none` action carries the research dispositions, because a run that
 * found no breaking change still has to account for the upgrades it was
 * given.
 */
export type ReviewDecision =
  | { action: "review"; result: ReviewResult }
  | { action: "none"; research?: UpgradeResearch[] };

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
const commentsField = (description: string) =>
  Type.Optional(
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
      { description },
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

/**
 * The model-facing guidance about the `none` action, per profile.
 *
 * The guidance appears in three places — the action's description, the
 * comments field's description, and the tool's own description — and a
 * profile that changed only one of them would leave the parameters
 * contradicting the profile's instructions.
 */
const ACTION_DESCRIPTION: Record<ReviewProfile["kind"], string> = {
  code: '"review" to publish comments, finding_updates, and/or the PR overview; "none" when there is nothing to publish (no comments, no updates, no overview — never file a no-findings review).',
  dependency:
    '"review" to publish comments and/or the PR overview, with one research disposition for every upgrade you were given. A run that found no breaking change omits the comments, never the action: "none" is not how a clean dependency review is filed. One research disposition per upgrade is required under either action, so a run that found nothing still accounts for the upgrades it was given.',
};

const COMMENTS_DESCRIPTION: Record<ReviewProfile["kind"], string> = {
  code: 'Inline comments attached to specific diff lines. May be an empty array when finding_updates or the PR overview carries the review; otherwise prefer "none" over an empty review. Omit for "none".',
  dependency:
    'Inline comments attached to specific diff lines. May be an empty array when the PR overview carries the review. A run that found no breaking change omits the field rather than declaring "none".',
};

const TOOL_DESCRIPTION: Record<ReviewProfile["kind"], string> = {
  code: 'Submit the final code review. Call this as your final action after reviewing the diff: declare "review" with comments, finding_updates, and/or the PR overview, or "none" when there is nothing to publish. A clean diff with nothing to report is "none" rather than a "review" with empty comments. Pass the complete result as structured data — do not also emit it as text.',
  dependency:
    'Submit the final dependency review. Call this as your final action after reading the upstream release notes for each upgrade: declare "review" with comments and/or the PR overview, and one research disposition for every upgrade in the <dependency_changes> section. A run that found no breaking change omits comments rather than declaring "none". Pass the complete result as structured data — do not also emit it as text.',
};

/**
 * The research dispositions the model reports for the upgrades it was given.
 *
 * The entry is a flat object rather than a union of two objects: the
 * transport requires a single flat shape, and the field each status needs is
 * enforced in `normalizeDecision` instead.
 */
const researchField = Type.Optional(
  Type.Array(
    Type.Object(
      {
        id: Type.String({
          minLength: 1,
          maxLength: 64,
          description: "The id of the upgrade, copied from the <dependency_changes> section.",
        }),
        status: Type.Union([Type.Literal("researched"), Type.Literal("unverified")], {
          description:
            '"researched" when the breaking changes were determined from the release notes; "unverified" when they could not be.',
        }),
        source: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 2000,
            description:
              'Where the release notes were read, for a researched upgrade: "candidate:<candidate-id>" for a location in the <dependency_changes> section, or "local:<repository-relative-path>" for a file in the checkout, such as the changelog the package shipped. No other form is accepted.',
          }),
        ),
        reason: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 2000,
            description:
              "Why the breaking changes could not be determined, for an unverified upgrade.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    {
      description:
        "One disposition per upgrade in the <dependency_changes> section. Every upgrade you were given needs one, even when you found no breaking change.",
    },
  ),
);

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
      description: ACTION_DESCRIPTION.code,
    }),
    summary: summaryField,
    pr_summary: prSummaryField,
    pr_diagram: prDiagramField,
    comments: commentsField(COMMENTS_DESCRIPTION.code),
    finding_updates: findingUpdatesField,
  },
  { additionalProperties: false },
);

/**
 * The schema of the dependency profile.
 *
 * It carries the code schema's fields and adds the research dispositions,
 * because a run that found no breaking change still has to account for the
 * upgrades it was given.
 *
 * The overview fields carry the dependency profile's own descriptions: the
 * code profile's say a diagram belongs in a multi-component diff, which is
 * the opposite of what this mode asks for, and a parameter description that
 * contradicts the profile's instructions undoes the profile.
 */
export const dependencyReviewSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("review"), Type.Literal("none")], {
      description: ACTION_DESCRIPTION.dependency,
    }),
    summary: summaryField,
    pr_summary: Type.Optional(
      Type.String({
        maxLength: 2000,
        description:
          "What/Why/Risk overview of the upgrades for the PR summary block. What: the upgraded packages and their version ranges. Why: inferred intent, labeled as inference. Risks: the breaking changes this repository may hit. Structure the overview with `### What`, `### Why`, and `### Risks` Markdown headings — never bold text. Markdown with single-escaped newlines; at most 2000 characters. Omit entirely when summary output is disabled.",
      }),
    ),
    pr_diagram: Type.Optional(
      Type.String({
        maxLength: 1500,
        description:
          "Omit it. A dependency bump is not a multi-component interaction, so this mode emits no diagram.",
      }),
    ),
    comments: commentsField(COMMENTS_DESCRIPTION.dependency),
    finding_updates: Type.Optional(
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
        {
          description:
            "Omit it. This mode analyzes the whole pull request against the upstream release notes, and it supplies no active findings to update.",
        },
      ),
    ),
    research: researchField,
  },
  { additionalProperties: false },
);

type ReviewParams = Static<typeof reviewSchema>;
type DependencyReviewParams = Static<typeof dependencyReviewSchema>;

export interface ReviewTool<TParameters extends TSchema = typeof reviewSchema> {
  tool: AgentTool<TParameters, Static<TParameters>>;
  getResult: () => ReviewDecision | undefined;
}

/** The review tool of the dependency profile. */
export type DependencyReviewTool = ReviewTool<typeof dependencyReviewSchema>;

/** The research entry as the tool's schema carries it. */
type DependencyResearchEntry = NonNullable<
  Static<typeof dependencyReviewSchema>["research"]
>[number];

/**
 * Checks the research dispositions the model reported.
 *
 * The shape is the harness's contract: a researched upgrade names the source
 * it read, and an unverified one names the reason it could not determine the
 * breaking changes. A malformed entry is rejected rather than published,
 * because a disposition the harness cannot read is not a disposition.
 */
function normalizeResearch(entries: readonly DependencyResearchEntry[]): UpgradeResearch[] {
  return entries.map((entry) => {
    if (entry.status === "researched") {
      if (typeof entry.source !== "string" || !entry.source.trim())
        throw new Error(
          `upgrade ${entry.id}: a "researched" disposition must name the source it read`,
        );
      if (entry.reason !== undefined)
        throw new Error(`upgrade ${entry.id}: a "researched" disposition must not carry a reason`);
      return { id: entry.id, status: "researched", source: entry.source };
    }
    if (entry.status === "unverified") {
      if (typeof entry.reason !== "string" || !entry.reason.trim())
        throw new Error(
          `upgrade ${entry.id}: an "unverified" disposition must give the reason it could not be determined`,
        );
      if (entry.source !== undefined)
        throw new Error(`upgrade ${entry.id}: an "unverified" disposition must not carry a source`);
      return { id: entry.id, status: "unverified", reason: entry.reason };
    }
    throw new Error(`upgrade ${entry.id}: unknown research status ${String(entry.status)}`);
  });
}

/** The arguments the two profiles' schemas share. */
interface ReviewArgs {
  action: "review" | "none";
  summary?: string;
  pr_summary?: string;
  pr_diagram?: string;
  comments?: unknown;
  finding_updates?: unknown;
}

/**
 * The review fields every profile's schema carries.
 *
 * The research dispositions are the one field the dependency profile adds,
 * so they travel beside the fields rather than inside them.
 */
interface ReviewFields {
  action: "review" | "none";
  summary?: string;
  pr_summary?: string;
  pr_diagram?: string;
  comments?: ReviewResult["comments"];
  finding_updates?: ReviewResult["finding_updates"];
}

/**
 * Reads the shared review fields off the tool arguments.
 *
 * Both profiles' schemas carry the same fields, so one reader serves both:
 * a field added to a schema has to be remembered in one place.
 */
function reviewFields(params: ReviewArgs): ReviewFields {
  return {
    action: params.action,
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
    ...(params.pr_summary !== undefined ? { pr_summary: params.pr_summary } : {}),
    ...(params.pr_diagram !== undefined ? { pr_diagram: params.pr_diagram } : {}),
    ...(params.comments !== undefined
      ? { comments: params.comments as ReviewResult["comments"] }
      : {}),
    ...(params.finding_updates !== undefined
      ? { finding_updates: params.finding_updates as ReviewResult["finding_updates"] }
      : {}),
  };
}

/**
 * Turn validated tool arguments into the harness dispatch decision. Per-action
 * required fields are enforced here because the transport requires a single
 * flat object (see `reviewSchema`); a violation throws and is returned to the
 * model as an error tool result for auto-retry.
 *
 * The research dispositions are accepted under both actions: a run that
 * found no breaking change still has to account for the upgrades it was
 * given, and the harness — not the model — renders the unverifiable ones.
 */
function normalizeDecision(fields: ReviewFields, research?: UpgradeResearch[]): ReviewDecision {
  if (fields.action === "none") {
    if (
      fields.summary !== undefined ||
      fields.pr_summary !== undefined ||
      fields.pr_diagram !== undefined ||
      fields.comments !== undefined ||
      fields.finding_updates !== undefined
    ) {
      throw new Error('action "none" must not carry review fields');
    }
    return { action: "none", ...(research ? { research } : {}) };
  }
  if (typeof fields.summary !== "string" || fields.summary.trim() === "") {
    throw new Error('"summary" is required for action "review"');
  }
  const comments = fields.comments ?? [];
  if (comments.some((comment) => !hasAiFixProse(comment.body))) {
    throw new Error("Finding body must contain meaningful prose");
  }
  return {
    action: "review",
    result: {
      summary: fields.summary,
      comments,
      finding_updates: fields.finding_updates ?? [],
      ...(fields.pr_summary !== undefined ? { pr_summary: fields.pr_summary } : {}),
      ...(fields.pr_diagram !== undefined ? { pr_diagram: fields.pr_diagram } : {}),
      ...(research ? { research } : {}),
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
 *
 * The profile selects the schema and the descriptions. The code profile's
 * schema and descriptions are the ones this tool has always carried, so
 * every existing caller keeps working unchanged.
 */
export function createReviewTool(profile: DependencyProfile): DependencyReviewTool;
export function createReviewTool(profile: CodeProfile): ReviewTool;
export function createReviewTool(
  profile: ReviewProfile | undefined,
): ReviewTool | DependencyReviewTool;
export function createReviewTool(): ReviewTool;
export function createReviewTool(
  profile: ReviewProfile | undefined = undefined,
): ReviewTool | DependencyReviewTool {
  let captured: ReviewDecision | undefined;

  if (profile?.kind === "dependency") {
    const tool: AgentTool<typeof dependencyReviewSchema, DependencyReviewParams> = {
      name: "submit_review",
      label: "submit_review",
      description: TOOL_DESCRIPTION.dependency,
      parameters: dependencyReviewSchema,
      async execute(_toolCallId: string, params: DependencyReviewParams) {
        const research = params.research ? normalizeResearch(params.research) : undefined;
        captured = normalizeDecision(reviewFields(params), research);
        return {
          content: [{ type: "text" as const, text: "Review submitted." }],
          details: params,
          terminate: true,
        };
      },
    };
    return { tool, getResult: () => captured };
  }

  const tool: AgentTool<typeof reviewSchema, ReviewParams> = {
    name: "submit_review",
    label: "submit_review",
    description: TOOL_DESCRIPTION.code,
    parameters: reviewSchema,
    async execute(_toolCallId: string, params: ReviewParams) {
      captured = normalizeDecision(reviewFields(params));
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
