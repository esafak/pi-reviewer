import { describe, expect, it } from "vite-plus/test";

import { validateToolArguments, type JsonObject, type JsonValue } from "@earendil-works/pi-ai";

import { createReviewTool } from "../../src/core/review-tool.js";

/** The arguments the review tool accepts, taken from the tool itself. */
type ReviewParams = Parameters<ReturnType<typeof createReviewTool>["tool"]["execute"]>[1];

/** One comment as the arguments carry it. */
type ReviewComment = NonNullable<ReviewParams["comments"]>[number];

/**
 * The arguments with their comments present.
 *
 * The comments are required here so a fixture can address one by index; the
 * tool's own type has them optional.
 */
type ReviewFixture = {
  action: ReviewParams["action"];
  summary: string;
  comments: ReviewComment[];
};

/** Minimal ToolCall shape expected by validateToolArguments. */
function toolCall(args: JsonObject) {
  return { type: "toolCall" as const, id: "tc-1", name: "submit_review", arguments: args };
}

function validArgs(): ReviewFixture {
  return {
    action: "review",
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

/**
 * The arguments as the tool receives them, with one comment left mutable.
 *
 * The rejection cases feed the schema a value it must refuse, so the comment
 * is a JSON object whose fields vary rather than the schema's own type.
 */
function argsWithComment(comment: Record<string, JsonValue>): JsonObject {
  return {
    action: "review",
    summary: "Looks good overall.",
    comments: [comment],
  };
}

describe("createReviewTool", () => {
  it("execute populates getResult() with the review decision", async () => {
    const { tool, getResult } = createReviewTool();

    expect(getResult()).toBeUndefined();

    await tool.execute("tc-1", validArgs());

    const decision = getResult();
    expect(decision?.action).toBe("review");
    if (decision?.action !== "review") throw new Error("expected a review decision");
    expect(decision.result.summary).toBe("Looks good overall.");
    expect(decision.result.comments).toHaveLength(2);
    expect(decision.result.comments[0].file).toBe("src/a.ts");
    expect(decision.result.comments[1].severity).toBe("CRITICAL");
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
    await tool.execute("tc-1", { action: "review", summary: "LGTM", comments: [] });

    const decision = getResult();
    if (decision?.action !== "review") throw new Error("expected a review decision");
    expect(decision.result.summary).toBe("LGTM");
    expect(decision.result.comments).toEqual([]);
  });

  it("rejects action review with no summary at runtime", async () => {
    const { tool } = createReviewTool();
    await expect(tool.execute("tc-1", { action: "review", comments: [] })).rejects.toThrow(
      /"summary" is required/,
    );
  });

  // ── None action ────────────────────────────────────────────────────────

  it("captures a none decision", async () => {
    const { tool, getResult } = createReviewTool();
    await tool.execute("tc-1", { action: "none" });

    expect(getResult()).toEqual({ action: "none" });
  });

  it("rejects none carrying review fields", async () => {
    const { tool } = createReviewTool();
    await expect(
      tool.execute("tc-1", { action: "none", summary: "sneaky" } as never),
    ).rejects.toThrow(/must not carry review fields/);
  });

  // ── Schema validation (via validateToolArguments) ──────────────────────

  it("schema accepts valid arguments", () => {
    const { tool } = createReviewTool();
    expect(() => validateToolArguments(tool, toolCall(validArgs()))).not.toThrow();
  });

  it("schema rejects a missing action", () => {
    const { tool } = createReviewTool();
    const { action: _action, ...withoutAction } = validArgs();
    expect(() => validateToolArguments(tool, toolCall(withoutAction))).toThrow(/Validation failed/);
  });

  it("schema rejects an unknown action", () => {
    const { tool } = createReviewTool();
    expect(() =>
      validateToolArguments(tool, toolCall({ ...validArgs(), action: "dismiss" })),
    ).toThrow(/Validation failed/);
  });

  it("schema accepts an optional PR summary and diagram", () => {
    const { tool } = createReviewTool();
    const args = {
      ...validArgs(),
      pr_summary: "What: new auth flow. Why: SSO rollout (inferred). Risks: token expiry.",
      pr_diagram: "sequenceDiagram\nA->>B: login",
    };
    expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
  });

  it("schema rejects an oversized PR summary or diagram", () => {
    const { tool } = createReviewTool();
    expect(() =>
      validateToolArguments(tool, toolCall({ ...validArgs(), pr_summary: "x".repeat(2001) })),
    ).toThrow(/Validation failed/);
    expect(() =>
      validateToolArguments(tool, toolCall({ ...validArgs(), pr_diagram: "x".repeat(1501) })),
    ).toThrow(/Validation failed/);
  });

  it("accepts optional replacement code, including an empty deletion", () => {
    const { tool } = createReviewTool();
    const args: JsonObject = {
      action: "review",
      summary: "Looks good overall.",
      comments: [
        {
          file: "src/a.ts",
          line: 10,
          side: "RIGHT",
          severity: "WARN",
          body: "Consider a null check.",
          suggestion: "return value;",
        },
        {
          file: "src/b.ts",
          line: 5,
          side: "LEFT",
          severity: "CRITICAL",
          body: "This removal breaks callers.",
          suggestion: "",
        },
      ],
    };
    expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
  });

  it("schema rejects an invalid side value", () => {
    const { tool } = createReviewTool();
    const args = argsWithComment({
      file: "src/a.ts",
      line: 10,
      side: "CENTER",
      severity: "WARN",
      body: "Consider a null check.",
    });

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects an invalid severity value", () => {
    const { tool } = createReviewTool();
    const args = argsWithComment({
      file: "src/a.ts",
      line: 10,
      side: "RIGHT",
      severity: "ERROR",
      body: "Consider a null check.",
    });

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects a non-numeric line", () => {
    const { tool } = createReviewTool();
    const args = argsWithComment({
      file: "src/a.ts",
      line: "not-a-number",
      side: "RIGHT",
      severity: "WARN",
      body: "Consider a null check.",
    });

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it("schema rejects fractional line numbers", () => {
    const { tool } = createReviewTool();
    const args = argsWithComment({
      file: "src/a.ts",
      line: 10.5,
      side: "RIGHT",
      severity: "WARN",
      body: "Consider a null check.",
    });

    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });

  it.each(["", "   ", "\n\t", "🟡", "🟡 🔴", "😀", "🧪"])(
    "schema rejects a non-meaningful finding body (%j)",
    (body) => {
      const { tool } = createReviewTool();
      const args = { ...validArgs(), comments: [{ ...validArgs().comments[0], body }] };
      expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
    },
  );

  it.each(["日本語の問題", "Проблема требует исправления"])(
    "schema accepts non-Latin meaningful prose (%j)",
    (body) => {
      const { tool } = createReviewTool();
      const args = { ...validArgs(), comments: [{ ...validArgs().comments[0], body }] };
      expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
    },
  );

  it.each(["🟡", "🟡 🔴", "😀", "🧪"])(
    "runtime rejects an emoji-only finding body (%j)",
    async (body) => {
      const { tool } = createReviewTool();
      const args = { ...validArgs(), comments: [{ ...validArgs().comments[0], body }] };
      await expect(tool.execute("tc-1", args)).rejects.toThrow(/meaningful prose/);
    },
  );

  it("schema validates finding updates", () => {
    const { tool } = createReviewTool();
    const args = {
      ...validArgs(),
      finding_updates: [
        {
          comment_id: 7,
          status: "PARTIALLY_RESOLVED",
          explanation: "Changed validation; logging remains.",
        },
      ],
    };
    expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
    args.finding_updates[0].status = "UNKNOWN";
    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
    const tooLong = {
      ...validArgs(),
      finding_updates: [{ comment_id: 7, status: "RESOLVED", explanation: "x".repeat(2001) }],
    };
    expect(() => validateToolArguments(tool, toolCall(tooLong))).toThrow(/Validation failed/);
  });

  it("schema validates re-raise fields and bounds", () => {
    const { tool } = createReviewTool();
    const args = {
      ...validArgs(),
      comments: [
        {
          ...validArgs().comments[0],
          resolved_finding_id: "inline:42",
          re_raise_reason: "MATERIALLY_CHANGED",
          re_raise_evidence: "behavior changed",
        },
      ],
    };
    expect(() => validateToolArguments(tool, toolCall(args))).not.toThrow();
    args.comments[0].re_raise_reason = "INVALID";
    expect(() => validateToolArguments(tool, toolCall(args))).toThrow(/Validation failed/);
  });
});
