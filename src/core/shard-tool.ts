import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hasAiFixProse } from "./ai-fix-footer.js";
import { isReviewComment } from "./output.js";
import { findingUpdatesField } from "./review-tool.js";
import type { ReviewComment } from "./output.js";

export interface DigestEntry {
  file: string;
  what: string;
  risks: string[];
}
export interface ShardFinding {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: "CRITICAL" | "WARN" | "INFO";
  body: string;
  suggestion?: string;
}

const findingField = Type.Object(
  {
    file: Type.String(),
    line: Type.Number({ minimum: 1, multipleOf: 1 }),
    side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
    severity: Type.Union([Type.Literal("CRITICAL"), Type.Literal("WARN"), Type.Literal("INFO")]),
    body: Type.String({ minLength: 1 }),
    suggestion: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const digestField = Type.Object(
  {
    file: Type.String(),
    what: Type.String({ maxLength: 120 }),
    risks: Type.Array(Type.String(), { maxItems: 5 }),
  },
  { additionalProperties: false },
);
const shardSchema = Type.Object(
  {
    findings: Type.Array(findingField),
    finding_updates: findingUpdatesField,
    digest: Type.Array(digestField),
  },
  { additionalProperties: false },
);
type ShardParams = Static<typeof shardSchema>;
const overviewSchema = Type.Object(
  {
    pr_summary: Type.Optional(Type.String({ maxLength: 2000 })),
    pr_diagram: Type.Optional(Type.String({ maxLength: 1500 })),
  },
  { additionalProperties: false },
);
type OverviewParams = Static<typeof overviewSchema>;

export interface ShardTool {
  tool: AgentTool<typeof shardSchema, ShardParams>;
  getResult: () =>
    | {
        findings: ShardFinding[];
        finding_updates: NonNullable<ShardParams["finding_updates"]>;
        digest: DigestEntry[];
      }
    | undefined;
  nudge: string;
  forcedTool: { type: "function"; function: { name: "submit_shard" } };
}

export function createShardTool(
  files: string[],
  warn: (id: string, fields: Record<string, number>) => void = () => {},
): ShardTool {
  let captured: ReturnType<ShardTool["getResult"]>;
  const tool: ShardTool["tool"] = {
    name: "submit_shard",
    label: "submit_shard",
    description:
      "Submit structured findings, finding updates, and a concise per-file digest for this shard.",
    parameters: shardSchema,
    async execute(_id, params) {
      // Findings pass through unfiltered: the merge owns stray/hallucinated
      // accounting (review.shard.stray with shard attribution), which would go
      // dark if the tool silently dropped files here. Only digests are
      // filtered, since the merge concatenates them without per-file checks.
      const allowed = new Set(files);
      const findings = params.findings;
      const extra = params.digest.filter((item) => !allowed.has(item.file)).length;
      if (extra) warn("review.shard.digest_extra", { count: extra });
      const digest = params.digest.filter((item) => allowed.has(item.file));
      const existing = new Set(digest.map((item) => item.file));
      const missing = files.filter((file) => !existing.has(file));
      if (missing.length) warn("review.shard.digest_incomplete", { count: missing.length });
      for (const file of missing) digest.push({ file, what: "(no digest)", risks: [] });
      captured = { findings, finding_updates: params.finding_updates ?? [], digest };
      return {
        content: [{ type: "text" as const, text: "Shard submitted." }],
        details: params,
        terminate: true,
      };
    },
  };
  return {
    tool,
    getResult: () => captured,
    nudge:
      "Submit your shard now by calling submit_shard with findings, finding_updates, and digest.",
    forcedTool: { type: "function", function: { name: "submit_shard" } },
  };
}

export function createOverviewTool(): {
  tool: AgentTool<typeof overviewSchema, OverviewParams>;
  getResult: () => OverviewParams | undefined;
} {
  let result: OverviewParams | undefined;
  const tool: AgentTool<typeof overviewSchema, OverviewParams> = {
    name: "submit_overview",
    label: "submit_overview",
    description: "Submit the optional PR overview and diagram.",
    parameters: overviewSchema,
    async execute(_id, params) {
      result = params;
      return {
        content: [{ type: "text" as const, text: "Overview submitted." }],
        details: params,
        terminate: true,
      };
    },
  };
  return { tool, getResult: () => result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapShardFinding(value: unknown): ReviewComment | undefined {
  if (!isRecord(value)) return undefined;
  const item = value;
  if (
    typeof item.file !== "string" ||
    typeof item.line !== "number" ||
    !Number.isInteger(item.line) ||
    item.line < 1 ||
    (item.side !== "LEFT" && item.side !== "RIGHT") ||
    (item.severity !== "CRITICAL" && item.severity !== "WARN" && item.severity !== "INFO") ||
    typeof item.body !== "string" ||
    !hasAiFixProse(item.body) ||
    (item.suggestion !== undefined && typeof item.suggestion !== "string")
  )
    return undefined;
  const mapped: ReviewComment = {
    file: item.file,
    line: item.line,
    side: item.side,
    severity: item.severity,
    body: item.body,
    ...(typeof item.suggestion === "string" ? { suggestion: item.suggestion } : {}),
  };
  // Belt and braces: the field-by-field narrowing above must always produce a
  // postable comment; fail closed rather than post a malformed one.
  return isReviewComment(mapped) ? mapped : undefined;
}
