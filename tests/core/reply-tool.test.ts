import { describe, expect, it } from "vite-plus/test";

import { validateToolArguments } from "@earendil-works/pi-ai";

import { ALLOWED_REACTIONS, createReplyTool } from "../../src/core/reply-tool.js";

function toolCall(args: Record<string, unknown>) {
  return { type: "toolCall" as const, id: "tc-1", name: "submit_reply", arguments: args };
}

describe("createReplyTool", () => {
  it.each(ALLOWED_REACTIONS)("captures the %s reaction", async (content) => {
    const { tool, getResult } = createReplyTool();
    await tool.execute("tc-1", { action: "react", content });
    expect(getResult()).toEqual({ action: "react", content });
  });

  it.each([
    ["reply", { action: "reply", body: "Here is the explanation." }],
    ["resolve", { action: "resolve", body: "I am withdrawing this concern." }],
  ] as const)("captures a %s response", async (_name, params) => {
    const { tool, getResult } = createReplyTool();
    await tool.execute("tc-1", params);
    expect(getResult()).toEqual(params);
  });

  it("returns a terminating tool result with matching details", async () => {
    const { tool } = createReplyTool();
    const params = { action: "reply" as const, body: "Answer" };
    const result = await tool.execute("tc-1", params);
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual(params);
    expect(result.content).toEqual([{ type: "text", text: "Reply submitted." }]);
  });

  it("rejects blank bodies at execution time", async () => {
    const { tool } = createReplyTool();
    await expect(tool.execute("tc-1", { action: "reply", body: "  " })).rejects.toThrow(/non-empty/);
  });

  it("accepts each valid action through schema validation", () => {
    const { tool } = createReplyTool();
    expect(() => validateToolArguments(tool, toolCall({ action: "react", content: "+1" }))).not.toThrow();
    expect(() => validateToolArguments(tool, toolCall({ action: "reply", body: "Answer" }))).not.toThrow();
    expect(() => validateToolArguments(tool, toolCall({ action: "resolve", body: "Closed" }))).not.toThrow();
  });

  it.each([
    { action: "react", content: "thumbs-up" },
    { action: "reply" },
    { action: "reply", body: "" },
    { action: "reply", body: "x".repeat(4_001) },
    { action: "resolve", body: "   " },
    { action: "reply", body: "Answer", extra: true },
    { action: "unknown", body: "Answer" },
  ])("rejects invalid tool arguments: %j", (args) => {
    const { tool } = createReplyTool();
    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });
});
