import { describe, expect, it } from "vite-plus/test";

import { createReplyTool } from "../../src/core/reply-tool.js";
import { createReviewTool } from "../../src/core/review-tool.js";

// OpenAI-compatible function calling requires each tool's `parameters` to be a
// top-level JSON Schema object. A top-level union serializes to `anyOf`, which
// providers reject or ignore, so the model never calls the tool and silently
// falls back to text. This contract test guards every provider-visible tool.
const tools = [
  { name: "submit_reply", parameters: createReplyTool().tool.parameters },
  { name: "submit_review", parameters: createReviewTool().tool.parameters },
];

describe("provider-visible tool schemas", () => {
  it.each(tools)("$name parameters are a top-level object", ({ parameters }) => {
    const schema = parameters as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  });
});
