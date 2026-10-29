import { describe, expect, it } from "vite-plus/test";
import { createShardTool, mapShardFinding, type DigestEntry } from "../../src/core/shard-tool.js";

describe("shard tool", () => {
  it("backfills absent digests and ignores digests outside the shard", async () => {
    const warnings: string[] = [];
    const shard = createShardTool(["a.ts", "b.ts"], (id) => warnings.push(id));
    const digest: DigestEntry[] = [
      { file: "a.ts", what: "change", risks: [] },
      { file: "outside.ts", what: "extra", risks: [] },
    ];
    await shard.tool.execute("call", { findings: [], digest, finding_updates: [] });
    expect(shard.getResult()?.digest).toEqual([
      digest[0],
      { file: "b.ts", what: "(no digest)", risks: [] },
    ]);
    expect(warnings).toContain("review.shard.digest_extra");
    expect(warnings).toContain("review.shard.digest_incomplete");
  });

  it("maps only valid findings with actionable prose", () => {
    expect(
      mapShardFinding({
        file: "a.ts",
        line: 1,
        side: "RIGHT",
        severity: "WARN",
        body: "This can crash because the value is null.",
      }),
    ).toMatchObject({ file: "a.ts", line: 1 });
    expect(
      mapShardFinding({ file: "a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "Bad" }),
    ).toMatchObject({ body: "Bad" });
  });
});

describe("shard-tool schema", () => {
  it("caps digest fields and overview prose via schema maxLength/maxItems", async () => {
    const { createOverviewTool } = await import("../../src/core/shard-tool.js");
    const shardParams = JSON.stringify(createShardTool([]).tool.parameters);
    expect(shardParams).toContain('"maxLength":120');
    expect(shardParams).toContain('"maxItems":5');
    const overviewParams = JSON.stringify(createOverviewTool().tool.parameters);
    expect(overviewParams).toContain('"maxLength":2000');
    expect(overviewParams).toContain('"maxLength":1500');
  });

  it("reuses the identical finding-updates schema object as submit_review", async () => {
    const { createReviewTool } = await import("../../src/core/review-tool.js");
    const shard = createShardTool([]).tool.parameters as {
      properties: { finding_updates: unknown };
    };
    const review = createReviewTool().tool.parameters as unknown as {
      properties: { finding_updates: unknown };
    };
    expect(shard.properties.finding_updates).toBe(review.properties.finding_updates);
  });

  it("maps only valid findings to postable comments", async () => {
    const { isReviewComment } = await import("../../src/core/output.js");
    const { hasAiFixProse } = await import("../../src/core/ai-fix-footer.js");
    expect(mapShardFinding(null)).toBeUndefined();
    expect(
      mapShardFinding({
        file: "a.ts",
        line: 0,
        side: "RIGHT",
        severity: "WARN",
        body: "This can crash because the value is null.",
      }),
    ).toBeUndefined();
    expect(
      mapShardFinding({
        file: "a.ts",
        line: 1,
        side: "MIDDLE",
        severity: "WARN",
        body: "This can crash because the value is null.",
      }),
    ).toBeUndefined();
    const mapped = mapShardFinding({
      file: "a.ts",
      line: 1,
      side: "RIGHT",
      severity: "WARN",
      body: "This can crash because the value is null.",
      suggestion: "fix it",
    });
    expect(mapped).toBeDefined();
    expect(isReviewComment(mapped)).toBe(true);
    expect(hasAiFixProse(mapped!.body)).toBe(true);
  });
});

describe("shard tool identity", () => {
  it("names submit_shard in its nudge and forced tool", async () => {
    const { createShardTool } = await import("../../src/core/shard-tool.js");
    const shard = createShardTool(["a.ts"]);
    expect(shard.nudge).toContain("submit_shard");
    expect(shard.forcedTool).toEqual({ type: "function", function: { name: "submit_shard" } });
    expect(shard.tool.name).toBe("submit_shard");
  });
});

describe("shard tool finding passthrough", () => {
  it("does not filter findings by file so the merge accounts for strays", async () => {
    const warned: Array<{ id: string; fields: Record<string, number> }> = [];
    const shard = createShardTool(["a.ts"], (id, fields) => warned.push({ id, fields }));
    await shard.tool.execute("call-1", {
      findings: [
        {
          file: "a.ts",
          line: 1,
          side: "RIGHT",
          severity: "WARN",
          body: "This can crash because the value is null.",
        },
        {
          file: "b.ts",
          line: 1,
          side: "RIGHT",
          severity: "WARN",
          body: "This can crash because the value is null.",
        },
      ],
      finding_updates: [],
      digest: [{ file: "a.ts", what: "covers a", risks: [] }],
    });
    // Both findings reach the merge (which drops strays with review.shard.stray);
    // only the digest list is file-filtered at the tool boundary.
    expect(shard.getResult()?.findings.map((finding) => finding.file)).toEqual(["a.ts", "b.ts"]);
    expect(warned).toEqual([]);
  });
});
