import { describe, expect, it } from "vite-plus/test";

import { validateToolArguments } from "@earendil-works/pi-ai";

import { createReviewTool } from "../../src/core/review-tool.js";

/** Minimal ToolCall shape expected by validateToolArguments. */
function toolCall(args: Record<string, unknown>) {
  return { type: "toolCall" as const, id: "tc-1", name: "submit_review", arguments: args };
}

function validArgs() {
  return {
    summary: "Looks good overall.",
    comments: [
      {
        file: "src/a.ts",
        line: 10,
        side: "RIGHT",
        severity: "WARN",
        body: "Consider a null check.",
      },
      {
        file: "src/b.ts",
        line: 5,
        side: "LEFT",
        severity: "CRITICAL",
        body: "This removal breaks callers.",
      },
    ],
  };
}

describe("createReviewTool", () => {
  it("execute populates getResult() with the submitted review", async () => {
    const { tool, getResult } = createReviewTool();

    expect(getResult()).toBeUndefined();

    const args = validArgs();
    await tool.execute("tc-1", args);

    const result = getResult();
    expect(result).toBeDefined();
    expect(result!.summary).toBe("Looks good overall.");
    expect(result!.comments).toHaveLength(2);
    expect(result!.comments[0].file).toBe("src/a.ts");
    expect(result!.comments[1].severity).toBe("CRITICAL");
  });

  it("execute returns terminate: true", async () => {
    const { tool } = createReviewTool();
    const result = await tool.execute("tc-1", validArgs());

    expect(result.terminate).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Review submitted." }]);
  });

  it("execute stores details equal to the params", async () => {
    const { tool } = createReviewTool();
    const args = validArgs();
    const result = await tool.execute("tc-1", args);

    expect(result.details).toEqual(args);
  });

  it("accepts an empty comments array", async () => {
    const { tool, getResult } = createReviewTool();
    const args = { summary: "LGTM", comments: [] };
    await tool.execute("tc-1", args);

    const result = getResult();
    expect(result!.summary).toBe("LGTM");
    expect(result!.comments).toEqual([]);
  });

  // ── Schema validation (via validateToolArguments) ──────────────────────

  it("schema accepts valid arguments", () => {
    const { tool } = createReviewTool();
    expect(() => validateToolArguments(tool, toolCall(validArgs()))).not.toThrow();
  });

  it("schema rejects an invalid side value", () => {
    const { tool } = createReviewTool();
    const args = validArgs();
    (args.comments[0] as Record<string, unknown>).side = "CENTER";

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects an invalid severity value", () => {
    const { tool } = createReviewTool();
    const args = validArgs();
    (args.comments[0] as Record<string, unknown>).severity = "ERROR";

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects a non-numeric line", () => {
    const { tool } = createReviewTool();
    const args = validArgs();
    (args.comments[0] as Record<string, unknown>).line = "not-a-number";

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects fractional line numbers", () => {
    const { tool } = createReviewTool();
    const args = validArgs();
    (args.comments[0] as Record<string, unknown>).line = 10.5;

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects a missing summary", () => {
    const { tool } = createReviewTool();
    const args = { comments: [] } as Record<string, unknown>;

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it.each(["", "   ", "\n\t"]) ("schema rejects an empty finding body (%j)", (body) => {
    const { tool } = createReviewTool();
    const args = { ...validArgs(), comments: [{ ...validArgs().comments[0], body }] };
    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema validates finding updates", () => {
    const { tool } = createReviewTool();
    const args = { ...validArgs(), finding_updates: [{ comment_id: 7, status: "PARTIALLY_RESOLVED", explanation: "Changed validation; logging remains." }] };
    expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
    args.finding_updates[0].status = "UNKNOWN";
    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
    const tooLong = { ...validArgs(), finding_updates: [{ comment_id: 7, status: "RESOLVED", explanation: "x".repeat(2001) }] };
    expect(() => validateToolArguments(tool, toolCall(tooLong))).toThrow(/Validation failed/);
  });

  it("schema validates re-raise fields and bounds", () => {
    const { tool } = createReviewTool();
    const args = { ...validArgs(), comments: [{ ...validArgs().comments[0], resolved_finding_id: "inline:42", re_raise_reason: "MATERIALLY_CHANGED", re_raise_evidence: "behavior changed" }] };
    expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
    args.comments[0].re_raise_reason = "INVALID";
    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });
});
