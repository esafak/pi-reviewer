import { Type } from "@earendil-works/pi-ai";
/**
 * TypeBox schema for the `submit_review` tool parameters.
 *
 * This schema reaches the model provider as the tool's `input_schema`
 * (Anthropic) / `parameters` (OpenAI), giving schema-validated structured
 * output without relying on text parsing. `validateToolArguments` runs
 * client-side before `execute`, so invalid args are rejected and sent back
 * to the model as an error tool result for auto-retry.
 */
const reviewSchema = Type.Object({
    summary: Type.String({
        description: "Overall review written in Markdown. Use bullet points and bold for clarity.",
    }),
    comments: Type.Array(Type.Object({
        file: Type.String({ description: "Relative path from repo root." }),
        line: Type.Number({
            minimum: 1,
            multipleOf: 1,
            description: 'Positive integer line number of a changed or context line within a diff hunk. Only lines that appear in the diff can receive comments — do not comment on arbitrary lines outside the diff.',
        }),
        side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")], {
            description: '"RIGHT" for added/context lines, "LEFT" for removed lines.',
        }),
        severity: Type.Union([Type.Literal("CRITICAL"), Type.Literal("WARN"), Type.Literal("INFO")], { description: "Issue severity tier." }),
        body: Type.String({ description: "Inline comment text, may use Markdown." }),
    }, { additionalProperties: false }), { description: "Inline comments attached to specific diff lines. May be empty." }),
}, { additionalProperties: false });
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
export function createReviewTool() {
    let captured;
    const tool = {
        name: "submit_review",
        label: "submit_review",
        description: "Submit the final code review. Call this as your final action after reviewing the diff. Pass the complete review as structured data — do not also emit it as text.",
        parameters: reviewSchema,
        async execute(_toolCallId, params) {
            captured = params;
            return {
                content: [{ type: "text", text: "Review submitted." }],
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
