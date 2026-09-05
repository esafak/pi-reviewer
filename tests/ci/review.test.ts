import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../src/core/diff-resolver.js", () => ({
  resolveDiff: vi.fn(),
  extractDiffFiles: vi.fn(() => []),
}));

vi.mock("../../src/core/doc-context.js", () => ({
  loadDocContext: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/core/context.js", () => ({
  loadContext: vi.fn(),
  mergeContextFiles: vi.fn((ctx) => [...(ctx.conventions ?? []), ...(ctx.reviewRules ?? [])]),
}));

vi.mock("../../src/core/output.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/core/output.js")>();
  return { ...actual, sendOutput: vi.fn() };
});

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createReadOnlyTools: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/core/review-tool.js", () => ({
  createReviewTool: vi.fn(() => ({
    tool: {
      name: "submit_review",
      label: "submit_review",
      description: "test",
      parameters: {},
      execute: vi.fn(),
    },
    getResult: () => undefined,
  })),
}));

vi.mock("../../src/core/reply-tool.js", () => ({
  ALLOWED_REACTIONS: ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"],
  createReplyTool: vi.fn(() => ({
    tool: {
      name: "submit_reply",
      label: "submit_reply",
      description: "test",
      parameters: {},
      execute: vi.fn(),
    },
    getResult: () => undefined,
  })),
}));

import { Agent } from "@earendil-works/pi-agent-core";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { loadContext } from "../../src/core/context.js";
import { resolveDiff } from "../../src/core/diff-resolver.js";
import { loadDocContext } from "../../src/core/doc-context.js";
import { sendOutput } from "../../src/core/output.js";
import { createReviewTool } from "../../src/core/review-tool.js";
import { createReplyTool } from "../../src/core/reply-tool.js";
import { ALLOWED_REACTIONS, buildReplyPrompt, defuseReplyMetadata, generateReplyResponse, parseReplyAction, resolveProviderApiKey, review, parseDocDirs, parseThinkingLevel, REPLY_INPUT_LIMITS, truncateReplyInput } from "../../src/ci/review.js";

describe("reply prompt limits", () => {
  it("truncates untrusted reply inputs with an explicit marker", () => {
    expect(truncateReplyInput("12345", 4)).toBe("1234\n[truncated]");
    expect(truncateReplyInput("1234", 4)).toBe("1234");
  });
  it("caps each separately delimited prompt input", () => {
    const prompt = buildReplyPrompt({ parent: "p".repeat(5_000), userReply: "u".repeat(5_000), thread: "t".repeat(9_000) });
    expect(prompt).toContain(`${"p".repeat(REPLY_INPUT_LIMITS.parent)}\n[truncated]\n</parent-finding>`);
    expect(prompt).toContain(`${"u".repeat(REPLY_INPUT_LIMITS.userReply)}\n[truncated]\n</user-reply>`);
    expect(prompt).toContain(`${"t".repeat(REPLY_INPUT_LIMITS.thread)}\n[truncated]\n</nearby-thread>`);
  });
  it.each(ALLOWED_REACTIONS)("accepts the allowed reaction %s", (content) => {
    expect(parseReplyAction(JSON.stringify({ action: "react", content }))).toEqual({ action: "react", content });
  });
  it.each(["", "not json", "{}", '{"action":"react","content":"thumbs-up"}', '{"action":"reply","body":""}', '{"action":"reply","body":"ok"}\nextra'])("rejects malformed or unsupported actions: %s", (raw) => {
    expect(parseReplyAction(raw)).toBeUndefined();
  });
  it("accepts an explicit resolve action with a non-empty body", () => {
    expect(parseReplyAction('{"action":"resolve","body":"Withdrawing this concern"}')).toEqual({ action: "resolve", body: "Withdrawing this concern" });
    expect(parseReplyAction('{"action":"resolve","body":""}')).toBeUndefined();
  });
  it("defuses reserved metadata while preserving normal markdown and code", () => {
    const action = parseReplyAction(JSON.stringify({ action: "reply", body: "Use **this** and `<!-- pi-reviewer:finding:v1 -->`" }));
    expect(action).toEqual({ action: "reply", body: "Use **this** and `<!-- pi-reviewer : reserved metadata -->`" });
    expect(defuseReplyMetadata("<!-- pi-reviewer:status:v1 {} -->")).not.toContain("<!-- pi-reviewer:");
  });
  it("requires replies for substantive input in the prompt contract", () => {
    const prompt = buildReplyPrompt({ parent: "finding", userReply: "Please explain this technical issue", thread: "" });
    expect(prompt).toContain("Substantive questions, requests, disagreements, uncertainty, or technical information require action=reply");
    expect(prompt).toContain("submit_reply");
    expect(prompt).toContain("fallback object");
    expect(prompt).toContain("untrusted context");
    expect(prompt).toContain("Never include a commit SHA unless the human explicitly asks for it; never add one as boilerplate");
  });
});

const resolveDiffMock = vi.mocked(resolveDiff);
const loadContextMock = vi.mocked(loadContext);
const loadDocContextMock = vi.mocked(loadDocContext);
const sendOutputMock = vi.mocked(sendOutput);
const AgentMock = vi.mocked(Agent);
const createReadOnlyToolsMock = vi.mocked(createReadOnlyTools);
const createReviewToolMock = vi.mocked(createReviewTool);
const createReplyToolMock = vi.mocked(createReplyTool);

function makeFakeAgent(text = "LGTM") {
  return {
    subscribe: vi.fn((cb: (event: unknown) => void) => {
      cb({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      });
      return vi.fn();
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
  };
}

describe("review", () => {
  beforeEach(() => {
    vi.restoreAllMocks();

    resolveDiffMock.mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts",
      source: "git diff origin/main...HEAD",
    });
    loadContextMock.mockResolvedValue({
      conventions: [{ path: "AGENTS.md", content: "- Use strict typing" }],
      reviewRules: [],
    });
    sendOutputMock.mockResolvedValue(undefined);
    createReadOnlyToolsMock.mockReturnValue([]);
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => undefined,
    });
    createReplyToolMock.mockReturnValue({
      tool: {
        name: "submit_reply",
        label: "submit_reply",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => undefined,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent() as any;
    });

    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.PI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.PI_REVIEWER_DOC_DIRS;
    // model is mandatory — provide a default for tests that don't exercise it
    process.env.PI_REVIEWER_MODEL = "anthropic/claude-opus-4-6";
  });

  it("dry-run logs source and prompt, without calling agent or output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await review({ cwd: "/repo", dryRun: true });

    expect(logSpy).toHaveBeenCalledWith("Diff source: git diff origin/main...HEAD");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("System prompt:\n\nYou are a code reviewer"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "User prompt:\n\nReview this diff:\n<diff>\ndiff --git a/a.ts b/a.ts",
      ),
    );
    expect(AgentMock).not.toHaveBeenCalled();
    expect(sendOutputMock).not.toHaveBeenCalled();
  });

  it("uses terminal output target in local mode", async () => {
    await review({ cwd: "/repo" });

    expect(createReadOnlyToolsMock).toHaveBeenCalledWith("/repo");
    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          tools: expect.arrayContaining([expect.objectContaining({ name: "submit_review" })]),
          thinkingLevel: "off",
        }),
      }),
    );
    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "terminal",
        content: "LGTM",
        cwd: "/repo",
      }),
    );
  });

  it("passes the configured thinking level to the agent", async () => {
    await review({ cwd: "/repo", thinking: "high" });

    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({ thinkingLevel: "high" }),
      }),
    );
  });

  it("uses comment output target in CI mode", async () => {
    process.env.GITHUB_ACTIONS = "true";

    await review({ cwd: "/repo", pr: 42, githubToken: "token", repo: "owner/repo" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "comment",
        prNumber: 42,
        githubToken: "token",
        repo: "owner/repo",
      }),
    );
  });

  it("passes the resolved diff to sendOutput for position validation", async () => {
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n";
    resolveDiffMock.mockResolvedValue({ diff, source: "git diff origin/main...HEAD" });

    await review({ cwd: "/repo" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        diff,
      }),
    );
  });

  it("reviews an explicit multi-commit range as one batch", async () => {
    sendOutputMock.mockClear();
    await review({ cwd: "/repo", fromSha: "base-sha", commitId: "head-sha", output: "comment", pr: 42, githubToken: "token", repo: "owner/repo" });
    expect(resolveDiffMock).toHaveBeenCalledWith(expect.objectContaining({ fromSha: "base-sha", toSha: "head-sha" }));
    expect(sendOutputMock).toHaveBeenCalledWith(expect.objectContaining({ baseCommitId: "base-sha" }));
    expect(sendOutputMock).toHaveBeenCalledTimes(1);
  });

  it("allows explicit output option to override auto-detect", async () => {
    process.env.GITHUB_ACTIONS = "true";

    await review({ cwd: "/repo", output: "file" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "file",
      }),
    );
  });

  it("continues normally when AGENTS.md context is missing", async () => {
    loadContextMock.mockResolvedValue({ conventions: [], reviewRules: [] });

    await review({ cwd: "/repo" });

    expect(AgentMock).toHaveBeenCalled();
    expect(sendOutputMock).toHaveBeenCalled();
  });

  it("does not scan doc dirs when none are configured (opt-in)", async () => {
    await review({ cwd: "/repo" });

    expect(loadDocContextMock).not.toHaveBeenCalled();
  });

  it("scans configured doc dirs and injects matching docs into the system prompt", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    loadDocContextMock.mockResolvedValueOnce([
      { path: ".pi/notes/auth.md", content: "auth doc body" },
    ]);

    await review({ cwd: "/repo", dryRun: true, docDirs: [".pi/notes"] });

    expect(loadDocContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", docDirs: [".pi/notes"] }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("System prompt:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("auth doc body"));
  });

  it("reads doc dirs from PI_REVIEWER_DOC_DIRS env when option absent", async () => {
    process.env.PI_REVIEWER_DOC_DIRS = ".pi/notes, docs/review";

    await review({ cwd: "/repo" });

    expect(loadDocContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ docDirs: [".pi/notes", "docs/review"] }),
    );
  });

  it("parseDocDirs splits on commas and newlines, trims, drops empties", () => {
    expect(parseDocDirs(undefined)).toEqual([]);
    expect(parseDocDirs("")).toEqual([]);
    expect(parseDocDirs(".pi/notes, docs/review")).toEqual([".pi/notes", "docs/review"]);
    expect(parseDocDirs(".pi/notes\n\ndocs/review,")).toEqual([".pi/notes", "docs/review"]);
  });

  it("resolves a provider/modelId with slashes (OpenRouter) for the agent", async () => {
    await review({ cwd: "/repo", model: "openrouter/openai/gpt-5.4-mini" });

    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: expect.objectContaining({ provider: "openrouter", id: "openai/gpt-5.4-mini" }),
        }),
      }),
    );
  });

  it.each([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["zai", "ZAI_API_KEY"],
  ] as const)("reads the provider-specific API key for %s", (provider, envName) => {
    process.env[envName] = "provider-key";
    expect(resolveProviderApiKey(provider)).toBe("provider-key");
  });

  it("prefers the explicit action key over provider-specific keys", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    expect(resolveProviderApiKey("openai", "explicit-key")).toBe("explicit-key");
  });

  it("prefers the provider-specific key over PI_API_KEY", () => {
    process.env.PI_API_KEY = "shared-key";
    process.env.OPENAI_API_KEY = "openai-key";
    expect(resolveProviderApiKey("openai")).toBe("openai-key");
  });

  it("falls back to PI_API_KEY for an unmapped provider", () => {
    process.env.PI_API_KEY = "shared-key";
    expect(resolveProviderApiKey("openrouter")).toBe("shared-key");
  });

  it("ignores an empty explicit key", () => {
    process.env.OPENAI_API_KEY = "openai-key";
    expect(resolveProviderApiKey("openai", "")).toBe("openai-key");
  });

  it("throws on an invalid model format", async () => {
    await expect(review({ cwd: "/repo", model: "gpt-5" })).rejects.toThrow(/Invalid model format/);
  });

  it("throws when no model is configured", async () => {
    delete process.env.PI_REVIEWER_MODEL;
    await expect(review({ cwd: "/repo" })).rejects.toThrow(/No model configured/);
  });

  it("surfaces a provider error attached to the last assistant message", async () => {
    AgentMock.mockImplementation(function () {
      return {
        subscribe: vi.fn((cb: (event: unknown) => void) => {
          cb({
            type: "agent_end",
            // agent_end has no top-level error; it lives on the message (e.g. 402)
            messages: [
              { role: "user", content: [{ type: "text", text: "diff" }] },
              {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "402 This request requires more credits",
              },
            ],
          });
          return vi.fn();
        }),
        prompt: vi.fn().mockResolvedValue(undefined),
      } as any;
    });

    await expect(review({ cwd: "/repo" })).rejects.toThrow(
      /Agent failed: 402 This request requires more credits/,
    );
  });

  it("surfaces a provider error attached to the reply assistant message", async () => {
    AgentMock.mockImplementation(function () {
      return {
        subscribe: vi.fn((cb: (event: unknown) => void) => {
          cb({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "401 Invalid API key" }] });
          return vi.fn();
        }),
        prompt: vi.fn().mockResolvedValue(undefined),
      } as any;
    });

    await expect(generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" })).rejects.toThrow(
      /Agent failed: 401 Invalid API key/,
    );
  });

  it("uses the submit_reply tool result before assistant text", async () => {
    const toolAction = { action: "reply" as const, body: "First\\n\\n<!-- pi-reviewer:finding:v1 -->" };
    createReplyToolMock.mockReturnValue({
      tool: { name: "submit_reply", label: "submit_reply", description: "test", parameters: {}, execute: vi.fn() },
      getResult: () => toolAction,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent('{"action":"react","content":"heart"}') as any;
    });

    await expect(generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" })).resolves.toEqual({
      action: "reply",
      body: "First\n\n<!-- pi-reviewer : reserved metadata -->",
    });
    expect(AgentMock).toHaveBeenCalledWith(expect.objectContaining({
      initialState: expect.objectContaining({
        tools: [expect.objectContaining({ name: "submit_reply" })],
      }),
    }));
  });

  it("rejects a malformed captured submit_reply result", async () => {
    createReplyToolMock.mockReturnValue({
      tool: { name: "submit_reply", label: "submit_reply", description: "test", parameters: {}, execute: vi.fn() },
      getResult: () => ({ action: "invalid" } as any),
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent('{"action":"react","content":"heart"}') as any;
    });

    await expect(generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" })).rejects.toThrow(
      /malformed reply action/,
    );
  });

  it("falls back to the legacy JSON reply protocol when no tool result exists", async () => {
    AgentMock.mockImplementation(function () {
      return makeFakeAgent('{"action":"react","content":"heart"}') as any;
    });

    await expect(generateReplyResponse({ parent: "finding", userReply: "thanks", thread: "thread" })).resolves.toEqual({
      action: "react",
      content: "heart",
    });
  });

  it("rejects arbitrary assistant prose when the reply tool was not called", async () => {
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("plain text") as any;
    });

    await expect(generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" })).rejects.toThrow(
      /malformed reply action/,
    );
  });

  it("passes final agent response to sendOutput", async () => {
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("Please fix null checks in src/a.ts") as any;
    });

    await review({ cwd: "/repo" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Please fix null checks in src/a.ts",
      }),
    );
  });

  it("uses submit_review tool result when the model called the tool", async () => {
    const toolReview = {
      summary: "Tool-based review",
      comments: [
        { file: "src/a.ts", line: 7, side: "RIGHT", severity: "WARN", body: "Handle undefined" },
      ],
    };
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => toolReview,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("") as any;
    });

    await review({ cwd: "/repo" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredResult: toolReview,
      }),
    );
  });

  it("passes body-finding lifecycle metadata through to sendOutput", async () => {
    const activeFinding = {
      commentId: 12345,
      threadId: undefined,
      reviewId: 42,
      bodyFinding: true,
      reviewBody: "visible review body",
      file: "src/a.ts",
      line: 7,
      side: "RIGHT",
      body: "body finding",
    };
    const toolReview = {
      summary: "Updated body finding",
      comments: [],
      finding_updates: [{ comment_id: activeFinding.commentId, status: "RESOLVED" as const, explanation: "fixed" }],
    };
    createReviewToolMock.mockReturnValue({
      tool: { name: "submit_review", label: "submit_review", description: "test", parameters: {}, execute: vi.fn() },
      getResult: () => toolReview,
    });
    AgentMock.mockImplementation(function () { return makeFakeAgent("") as any; });

    await review({ cwd: "/repo", output: "comment", pr: 42, githubToken: "token", repo: "owner/repo", commitId: "head", activeFindings: [activeFinding] });

    expect(sendOutputMock).toHaveBeenCalledWith(expect.objectContaining({
      existingFindings: [{ commentId: 12345, threadId: undefined, reviewId: 42, bodyFinding: true, reviewBody: "visible review body" }],
      allowedFindingIds: new Set([12345]),
    }));
  });

  it("passes resolved-finding history through to sendOutput for suppression", async () => {
    const resolvedFindings = [{
      historicalFindingId: "inline:42",
      commentId: 42,
      kind: "inline" as const,
      file: "src/a.ts",
      line: 7,
      side: "RIGHT" as const,
      body: "old finding",
      originalBody: "old finding",
    }];
    createReviewToolMock.mockReturnValue({
      tool: { name: "submit_review", label: "submit_review", description: "test", parameters: {}, execute: vi.fn() },
      getResult: () => ({ summary: "Tool-based review", comments: [] }),
    });
    AgentMock.mockImplementation(function () { return makeFakeAgent("") as any; });

    await review({ cwd: "/repo", resolvedFindings });

    expect(sendOutputMock).toHaveBeenCalledWith(expect.objectContaining({ resolvedFindings }));
  });

  it("falls back to text extraction when the model did not call submit_review", async () => {
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => undefined,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("Text-based review without tool") as any;
    });

    await review({ cwd: "/repo" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Text-based review without tool",
      }),
    );
  });

  it("logs the raw text fallback in CI-safe lines", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => undefined,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("first line\n::warning::not-a-command") as any;
    });

    await review({ cwd: "/repo" });

    expect(log).toHaveBeenCalledWith("::group::Pi Reviewer raw assistant response (text fallback)");
    expect(log).toHaveBeenCalledWith("| first line");
    expect(log).toHaveBeenCalledWith("| ::warning::not-a-command");
    expect(log).toHaveBeenCalledWith("::endgroup::");
  });
});

describe("parseThinkingLevel", () => {
  it("defaults to off", () => {
    expect(parseThinkingLevel(undefined)).toBe("off");
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh"])("accepts %s", (level) => {
    expect(parseThinkingLevel(level)).toBe(level);
  });

  it("rejects unknown levels", () => {
    expect(() => parseThinkingLevel("turbo")).toThrow(/Invalid thinking level/);
  });
});
