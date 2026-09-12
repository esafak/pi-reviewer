import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";

export const ALLOWED_REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;

export type ReplyAction =
  | { action: "react"; content: typeof ALLOWED_REACTIONS[number] }
  | { action: "reply"; body: string }
  | { action: "resolve"; body: string };

// OpenAI-compatible function calling requires a tool's `parameters` to be a
// top-level JSON Schema object. A top-level union serializes to `anyOf`, which
// is not a usable tool schema: the model never calls the tool and silently
// falls back to text. Model the action as a discriminated object and enforce
// the per-action requirements in `execute`. Guarded by
// tests/core/tool-schemas.test.ts.
const replySchema = Type.Object(
  {
    action: Type.Union([Type.Literal("react"), Type.Literal("reply"), Type.Literal("resolve")], {
      description: 'Thread action: "react" for low-information acknowledgements, "reply" for a substantive response, "resolve" only when withdrawing or closing the finding.',
    }),
    content: Type.Optional(
      Type.Union(
        [
          Type.Literal("+1"),
          Type.Literal("-1"),
          Type.Literal("laugh"),
          Type.Literal("confused"),
          Type.Literal("heart"),
          Type.Literal("hooray"),
          Type.Literal("rocket"),
          Type.Literal("eyes"),
        ],
        { description: 'Reaction to add. Required for action "react"; omit for "reply"/"resolve".' },
      ),
    ),
    body: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4_000,
        pattern: "\\S",
        description: 'Reply text. Required for actions "reply" and "resolve"; omit for "react".',
      }),
    ),
  },
  { additionalProperties: false },
);

type ReplyParams = Static<typeof replySchema>;

function normalizeReplyParams(params: ReplyParams): ReplyAction {
  if (params.action === "react") {
    if (params.content === undefined) throw new Error('"content" is required for a react action');
    return { action: "react", content: params.content };
  }
  if (!params.body || !params.body.trim() || params.body.length > 4_000) {
    throw new Error("Reply body must be non-empty and at most 4000 characters");
  }
  return { action: params.action, body: params.body };
}

export interface ReplyTool {
  tool: AgentTool<typeof replySchema, ReplyParams>;
  getResult: () => ReplyAction | undefined;
}

/** Create the provider-visible tool used by the conversation assistant. */
export function createReplyTool(): ReplyTool {
  let captured: ReplyAction | undefined;

  const tool: AgentTool<typeof replySchema, ReplyParams> = {
    name: "submit_reply",
    label: "submit_reply",
    description:
      "Submit the final pull request thread action as structured data. Use react for low-information acknowledgements, reply for substantive responses, or resolve only when explicitly withdrawing or closing the finding. Do not also emit the action as text.",
    parameters: replySchema,
    async execute(_toolCallId: string, params: ReplyParams) {
      const reply = normalizeReplyParams(params);
      captured = reply;
      return {
        content: [{ type: "text" as const, text: "Reply submitted." }],
        details: reply,
        terminate: true,
      };
    },
  };

  return {
    tool,
    getResult: () => captured,
  };
}
