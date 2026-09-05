import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@earendil-works/pi-ai";

export const ALLOWED_REACTIONS = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"] as const;

export type ReplyAction =
  | { action: "react"; content: typeof ALLOWED_REACTIONS[number] }
  | { action: "reply"; body: string }
  | { action: "resolve"; body: string };

const replySchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("react"),
      content: Type.Union([
        Type.Literal("+1"),
        Type.Literal("-1"),
        Type.Literal("laugh"),
        Type.Literal("confused"),
        Type.Literal("heart"),
        Type.Literal("hooray"),
        Type.Literal("rocket"),
        Type.Literal("eyes"),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("reply"),
      body: Type.String({ minLength: 1, maxLength: 4_000, pattern: "\\S" }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("resolve"),
      body: Type.String({ minLength: 1, maxLength: 4_000, pattern: "\\S" }),
    },
    { additionalProperties: false },
  ),
]);

type ReplyParams = Static<typeof replySchema>;

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
      if ("body" in params && (!params.body.trim() || params.body.length > 4_000)) {
        throw new Error("Reply body must be non-empty and at most 4000 characters");
      }
      captured = params;
      return {
        content: [{ type: "text" as const, text: "Reply submitted." }],
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
