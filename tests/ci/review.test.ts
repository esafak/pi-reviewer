import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, createMemorySink, formatGroup } from "../../src/logging/index.js";

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

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
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn(function () {
    return { reload: vi.fn().mockResolvedValue(undefined) };
  }),
  SessionManager: { inMemory: vi.fn(() => ({})) },
}));

vi.mock("pi-mcp-adapter", () => ({
  createMcpAdapter: vi.fn(() => () => {}),
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
import { createAgentSession, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { loadContext } from "../../src/core/context.js";
import { resolveDiff } from "../../src/core/diff-resolver.js";
import { loadDocContext } from "../../src/core/doc-context.js";
import { sendOutput } from "../../src/core/output.js";
import { createReviewTool } from "../../src/core/review-tool.js";
import { createReplyTool } from "../../src/core/reply-tool.js";
import type { CiMcpConfig } from "../../src/ci/mcp-config.js";
import {
  ALLOWED_REACTIONS,
  buildReplyPrompt,
  defuseReplyMetadata,
  generateReplyResponse,
  parseReplyAction,
  resolveProviderApiKey,
  review,
  parseDocDirs,
  parseThinkingLevel,
  REPLY_INPUT_LIMITS,
  truncateReplyInput,
} from "../../src/ci/review.js";

describe("reply prompt limits", () => {
  it("truncates untrusted reply inputs with an explicit marker", () => {
    expect(truncateReplyInput("12345", 4)).toBe("1234\n[truncated]");
    expect(truncateReplyInput("1234", 4)).toBe("1234");
  });
  it("caps each separately delimited prompt input", () => {
    const prompt = buildReplyPrompt({
      parent: "p".repeat(5_000),
      userReply: "u".repeat(5_000),
      thread: "t".repeat(9_000),
    });
    expect(prompt).toContain(
      `${"p".repeat(REPLY_INPUT_LIMITS.parent)}\n[truncated]\n</parent-finding>`,
    );
    expect(prompt).toContain(
      `${"u".repeat(REPLY_INPUT_LIMITS.userReply)}\n[truncated]\n</user-reply>`,
    );
    expect(prompt).toContain(
      `${"t".repeat(REPLY_INPUT_LIMITS.thread)}\n[truncated]\n</nearby-thread>`,
    );
  });
  it.each(ALLOWED_REACTIONS)("accepts the allowed reaction %s", (content) => {
    expect(parseReplyAction(JSON.stringify({ action: "react", content }))).toEqual({
      action: "react",
      content,
    });
  });
  it.each([
    "",
    "not json",
    "{}",
    '{"action":"react","content":"thumbs-up"}',
    '{"action":"reply","body":""}',
    '{"action":"reply","body":"ok"}\nextra',
  ])("rejects malformed or unsupported actions: %s", (raw) => {
    expect(parseReplyAction(raw)).toBeUndefined();
  });
  it("accepts an explicit resolve action with a non-empty body", () => {
    expect(parseReplyAction('{"action":"resolve","body":"Withdrawing this concern"}')).toEqual({
      action: "resolve",
      body: "Withdrawing this concern",
    });
    expect(parseReplyAction('{"action":"resolve","body":""}')).toBeUndefined();
  });
  it("defuses reserved metadata while preserving normal markdown and code", () => {
    const action = parseReplyAction(
      JSON.stringify({
        action: "reply",
        body: "Use **this** and `<!-- pi-reviewer:finding:v1 -->`",
      }),
    );
    expect(action).toEqual({
      action: "reply",
      body: "Use **this** and `<!-- pi-reviewer : reserved metadata -->`",
    });
    expect(defuseReplyMetadata("<!-- pi-reviewer:status:v1 {} -->")).not.toContain(
      "<!-- pi-reviewer:",
    );
  });
  it("requires replies for substantive input in the prompt contract", () => {
    const prompt = buildReplyPrompt({
      parent: "finding",
      userReply: "Please explain this technical issue",
      thread: "",
    });
    expect(prompt).toContain(
      "Substantive questions, requests, disagreements, uncertainty, or technical information require action=reply",
    );
    expect(prompt).toContain("submit_reply");
    expect(prompt).toContain("fallback object");
    expect(prompt).toContain("untrusted context");
    expect(prompt).toContain(
      "Never include a commit SHA unless the human explicitly asks for it; never add one as boilerplate",
    );
  });
});

const resolveDiffMock = vi.mocked(resolveDiff);
const loadContextMock = vi.mocked(loadContext);
const loadDocContextMock = vi.mocked(loadDocContext);
const sendOutputMock = vi.mocked(sendOutput);
const AgentMock = vi.mocked(Agent);
const createReadOnlyToolsMock = vi.mocked(createReadOnlyTools);
const createAgentSessionMock = vi.mocked(createAgentSession);
const createMcpAdapterMock = vi.mocked(createMcpAdapter);
const createReviewToolMock = vi.mocked(createReviewTool);
const createReplyToolMock = vi.mocked(createReplyTool);

let fakeAgentEvents: unknown[] = [];
let fakeMcpSession: ReturnType<typeof makeFakeMcpSession>;

function makeFakeAgent(text = "LGTM") {
  return {
    subscribe: vi.fn((cb: (event: unknown) => void) => {
      for (const event of fakeAgentEvents) cb(event);
      cb({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      });
      return vi.fn();
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFakeMcpSession() {
  const mcpTool = { name: "mcp", label: "mcp", execute: vi.fn() };
  const agent = Object.assign(makeFakeAgent(), {
    state: {
      systemPrompt: "",
      model: undefined,
      thinkingLevel: "off",
      tools: [mcpTool],
    },
    streamFunction: vi.fn(),
    getApiKey: vi.fn(),
  });
  const registered = [{ definition: { name: "mcp" } }];
  return {
    agent,
    extensionRunner: {
      getAllRegisteredTools: vi.fn(() => registered),
      emit: vi.fn().mockResolvedValue(undefined),
    },
    setActiveToolsByName: vi.fn((names: string[]) => {
      agent.state.tools = names.includes("mcp") ? [mcpTool] : [];
    }),
    dispose: vi.fn(),
  };
}

describe("review", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fakeAgentEvents = [];
    fakeMcpSession = makeFakeMcpSession();

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
    createAgentSessionMock.mockResolvedValue({ session: fakeMcpSession } as never);
    createMcpAdapterMock.mockReturnValue((() => {}) as never);
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
    delete process.env.PI_REVIEWER_MCP_CONFIG_FILE;
    delete process.env.PI_REVIEWER_WEB_SEARCH;
    delete process.env.PI_REVIEWER_SEARCH_PROVIDER;
    delete process.env.PI_REVIEWER_SEARCH_REQUIRED;
    delete process.env.PI_REVIEWER_AI_SEARCH;
    delete process.env.PI_REVIEWER_AI_SEARCH_PROVIDER;
    delete process.env.PI_REVIEWER_AI_SEARCH_REQUIRED;
    delete process.env.PI_REVIEWER_GITHUB_RESEARCH;
    delete process.env.PI_REVIEWER_GITHUB_SCOPE;
    delete process.env.EXA_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    // model is mandatory — provide a default for tests that don't exercise it
    process.env.PI_REVIEWER_MODEL = "anthropic/claude-opus-4-6";
  });

  it("dry-run logs source and prompt, without calling agent or output", async () => {
    const { sink, records } = createMemorySink();

    await review({ cwd: "/repo", dryRun: true, logger: createLogger({ sink }) });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.dry_run.diff_source",
          fields: { source: "git diff origin/main...HEAD" },
        }),
        expect.objectContaining({
          event: "review.dry_run.system_prompt",
          fields: expect.objectContaining({
            prompt: expect.stringContaining("You are a code reviewer"),
          }),
        }),
        expect.objectContaining({
          event: "review.dry_run.user_prompt",
          fields: expect.objectContaining({ prompt: expect.stringContaining("diff --git a/a.ts") }),
        }),
      ]),
    );
    expect(AgentMock).not.toHaveBeenCalled();
    expect(sendOutputMock).not.toHaveBeenCalled();
  });

  it("does not create an MCP session by default", async () => {
    await review({ cwd: "/repo", repo: "owner/repo" });
    expect(createAgentSessionMock).not.toHaveBeenCalled();
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
    expect(AgentMock.mock.calls[0][0].initialState.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "web_search" })]),
    );
    expect(AgentMock.mock.calls[0][0].initialState.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "package_lookup" })]),
    );
    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "terminal",
        content: "LGTM",
        cwd: "/repo",
      }),
    );
  });

  it("does not create an MCP session for non-comment output", async () => {
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };
    await review({ cwd: "/repo", mcpConfig, output: "terminal", logger: createLogger({ sink }) });

    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(AgentMock).toHaveBeenCalled();
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.mcp.disabled",
          level: "warn",
          message: "MCP disabled; only available for CI comment-output reviews",
        }),
      ]),
    );
  });

  it("registers configured MCP tools only for comment output and shuts the extension down", async () => {
    const mcpConfig: CiMcpConfig = {
      mcpServers: { docs: { url: "https://mcp.example/mcp", auth: "bearer" } },
    };
    const previousOutputGuard = process.env.MCP_OUTPUT_GUARD;
    const previousUiDebug = process.env.MCP_UI_DEBUG;
    process.env.MCP_OUTPUT_GUARD = "0";
    process.env.MCP_UI_DEBUG = "1";
    try {
      await review({ cwd: "/repo", repo: "owner/repo", mcpConfig, output: "comment" });
      expect(process.env.MCP_OUTPUT_GUARD).toBe("0");
      expect(process.env.MCP_UI_DEBUG).toBe("1");
    } finally {
      if (previousOutputGuard === undefined) delete process.env.MCP_OUTPUT_GUARD;
      else process.env.MCP_OUTPUT_GUARD = previousOutputGuard;
      if (previousUiDebug === undefined) delete process.env.MCP_UI_DEBUG;
      else process.env.MCP_UI_DEBUG = previousUiDebug;
    }

    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        tools: ["read", "grep", "find", "mcp"],
        sessionManager: expect.anything(),
        resourceLoader: expect.anything(),
      }),
    );
    expect(createMcpAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          settings: expect.objectContaining({ allowInstall: false }),
          mcpServers: {
            docs: { url: "https://mcp.example/mcp", auth: "bearer", debug: false },
          },
        }),
      }),
    );
    expect(fakeMcpSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["mcp", "read", "grep", "find", "submit_review"]),
    );
    expect(fakeMcpSession.agent.prompt).toHaveBeenCalled();
    expect(fakeMcpSession.agent.state.systemPrompt).toContain("<mcp_tool_policy>");
    expect(fakeMcpSession.agent.state.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "submit_review" })]),
    );
    expect(fakeMcpSession.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(fakeMcpSession.dispose).toHaveBeenCalled();
  });

  it("passes the configured thinking level to the agent", async () => {
    await review({ cwd: "/repo", thinking: "high" });

    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({ thinkingLevel: "high" }),
      }),
    );
  });

  it("logs agent tool calls only when debug is enabled", async () => {
    const circularArgs: Record<string, unknown> = {};
    circularArgs.self = circularArgs;
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "web_search",
        toolCallId: "call-1",
        args: { query: "AWS SDK ErrorMetadata export" },
      },
      { type: "tool_execution_end", toolName: "web_search", toolCallId: "call-1", isError: true },
      { type: "tool_execution_start", toolName: "read_file", toolCallId: "call-2" },
      { type: "tool_execution_start", toolName: "inspect", args: circularArgs },
      { type: "tool_execution_start", toolName: "submit_review", args: { body: "x".repeat(5000) } },
    ];
    const { sink, records } = createMemorySink();

    await review({ cwd: "/repo", debug: true, logger: createLogger({ sink }) });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.tool.call",
          fields: expect.objectContaining({ tool: "web_search", callId: "call-1" }),
        }),
        expect.objectContaining({
          event: "review.tool.result",
          fields: expect.objectContaining({ tool: "web_search", status: "error" }),
        }),
        expect.objectContaining({
          event: "review.tool.call",
          fields: expect.objectContaining({ tool: "inspect", args: "[unserializable args]" }),
        }),
        expect.objectContaining({
          event: "review.tool.call",
          fields: expect.objectContaining({
            tool: "submit_review",
            args: expect.stringMatching(/^.{3000}… \[truncated \d+ chars\]$/),
          }),
        }),
      ]),
    );

    const disabled = createMemorySink();
    await review({ cwd: "/repo", debug: false, logger: createLogger({ sink: disabled.sink }) });
    expect(disabled.records).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "review.tool.call" }),
        expect.objectContaining({ event: "review.tool.result" }),
      ]),
    );
  });

  it("writes agent thinking to the configured artifact only when debug is enabled", async () => {
    fakeAgentEvents = [
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "Before tool.",
        },
      },
      {
        type: "tool_execution_start",
        toolName: "read_file",
        toolCallId: "call-1",
        args: { path: "private/path.ts" },
      },
      {
        type: "tool_execution_end",
        toolName: "read_file",
        toolCallId: "call-1",
        result: "private file contents",
        isError: false,
      },
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text: "LGTM" }] }],
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "After tool.",
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const directory = await mkdtemp(path.join(tmpdir(), "pi-reviewer-thinking-test-"));
    const artifactPath = path.join(directory, "thinking.txt");
    const previousArtifactPath = process.env.PI_REVIEWER_THINKING_ARTIFACT;
    const writeFileSpy = vi.mocked(writeFile);
    writeFileSpy.mockClear();
    process.env.PI_REVIEWER_THINKING_ARTIFACT = artifactPath;
    try {
      await review({ cwd: "/repo", debug: true, logger: createLogger({ sink }) });
      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const trace = (await readFile(artifactPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(trace.map((entry) => entry.type)).toEqual([
        "thinking",
        "tool_start",
        "tool_end",
        "thinking",
      ]);
      expect(trace[0]).toMatchObject({ type: "thinking", text: "Before tool." });
      expect(trace[1]).toMatchObject({ type: "tool_start", tool: "read_file", callId: "call-1" });
      expect(trace[2]).toMatchObject({
        type: "tool_end",
        tool: "read_file",
        callId: "call-1",
        status: "success",
      });
      expect(trace[3]).toMatchObject({ type: "thinking", text: "After tool." });
      for (const entry of trace) {
        expect(entry.timestamp).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
      }
      expect(JSON.stringify(trace)).not.toContain("private/path.ts");
      expect(JSON.stringify(trace)).not.toContain("private file contents");
      expect(records).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "review.agent.thinking" })]),
      );

      await rm(artifactPath);
      await review({ cwd: "/repo", debug: false, logger: createLogger({ sink }) });
      await expect(access(artifactPath)).rejects.toThrow();
    } finally {
      if (previousArtifactPath === undefined) delete process.env.PI_REVIEWER_THINKING_ARTIFACT;
      else process.env.PI_REVIEWER_THINKING_ARTIFACT = previousArtifactPath;
      writeFileSpy.mockClear();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("logs MCP proxy tool names and status without writing args or returned payloads", async () => {
    const secretArgument = "credential-that-must-not-appear";
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-call-1",
        args: {
          server: "docs",
          tool: "search_docs",
          args: { query: "private query", token: secretArgument },
        },
      },
      { type: "tool_execution_end", toolName: "mcp", toolCallId: "mcp-call-1", isError: false },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await review({
      cwd: "/repo",
      output: "comment",
      mcpConfig,
      debug: true,
      logger: createLogger({ sink }),
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.mcp.tool_call",
          fields: { tool: "docs/search_docs", callId: "mcp-call-1" },
        }),
        expect.objectContaining({
          event: "review.mcp.tool_result",
          fields: { tool: "docs/search_docs", callId: "mcp-call-1", status: "success" },
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain(secretArgument);
    expect(JSON.stringify(records)).not.toContain("private query");
  });

  it("does not pass ambient process environment to configured stdio servers", async () => {
    const mcpConfig: CiMcpConfig = {
      mcpServers: {
        local: { command: "node", args: ["server.js"], env: { API_TOKEN: "${TOKEN}" } },
      },
    };
    await review({ cwd: "/repo", output: "comment", mcpConfig, mcpServerCwd: "/trusted/base" });

    expect(createMcpAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          mcpServers: {
            local: {
              command: "node",
              args: ["server.js"],
              env: { API_TOKEN: "${TOKEN}" },
              cwd: "/trusted/base",
              auth: false,
              debug: false,
              inheritEnv: false,
            },
          },
        }),
      }),
    );
  });

  it("refuses to post a review when a configured MCP tool call fails", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-failed-call",
        args: { server: "docs", tool: "search_docs", args: { query: "x" } },
      },
      { type: "tool_execution_end", toolName: "mcp", toolCallId: "mcp-failed-call", isError: true },
    ];
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(review({ cwd: "/repo", output: "comment", mcpConfig })).rejects.toThrow(
      "A configured MCP tool call failed; refusing to post the review",
    );
    expect(sendOutputMock).not.toHaveBeenCalled();
    expect(fakeMcpSession.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
  });

  it("allows a failed MCP call when a retry of that tool succeeds", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-failed-attempt",
        args: { server: "docs", tool: "search_docs", args: { query: "x" } },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-failed-attempt",
        isError: true,
      },
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-successful-retry",
        args: { server: "docs", tool: "search_docs", args: { query: "x" } },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-successful-retry",
        isError: false,
      },
    ];
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(review({ cwd: "/repo", output: "comment", mcpConfig })).resolves.toBeUndefined();
    expect(sendOutputMock).toHaveBeenCalled();
  });

  it("does not let success from a different MCP tool hide a failed call", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-failed-search",
        args: { server: "docs", tool: "search_docs", args: { query: "x" } },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-failed-search",
        isError: true,
      },
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-successful-fetch",
        args: { server: "docs", tool: "fetch_doc", args: { id: "1" } },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-successful-fetch",
        isError: false,
      },
    ];
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(review({ cwd: "/repo", output: "comment", mcpConfig })).rejects.toThrow(
      "A configured MCP tool call failed; refusing to post the review",
    );
    expect(sendOutputMock).not.toHaveBeenCalled();
  });

  it("removes adapter spill files after the review session shuts down", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "pi-mcp-output-test-"));
    const outputFile = path.join(outputDir, "output-1234abcd.txt");
    await writeFile(outputFile, "sensitive MCP output");
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-output-call",
        args: { server: "docs", tool: "large_result", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-output-call",
        isError: false,
        result: { details: { outputGuard: { fullOutputPath: outputFile } } },
      },
    ];
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    try {
      await review({ cwd: "/repo", output: "comment", mcpConfig });
      await expect(access(outputFile)).rejects.toThrow();
      await expect(access(outputDir)).rejects.toThrow();
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("uses comment output target in CI mode", async () => {
    process.env.GITHUB_ACTIONS = "true";

    await review({ cwd: "/repo", pr: 42, githubToken: "token", repo: "owner/repo" });

    const state = AgentMock.mock.calls[0][0].initialState;
    expect(state.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "package_lookup" })]),
    );
    expect(state.systemPrompt).toContain("<package_registry_policy>");
    expect(state.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "github_search" })]),
    );
    expect(state.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "web_search" })]),
    );

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "comment",
        prNumber: 42,
        githubToken: "token",
        repo: "owner/repo",
      }),
    );
  });

  it("registers GitHub research tools only for enabled CI comment reviews", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.PI_REVIEWER_GITHUB_RESEARCH = "true";
    process.env.PI_REVIEWER_GITHUB_SCOPE = "public";

    await review({ cwd: "/repo", pr: 42, githubToken: "token", repo: "owner/repo" });

    const state = AgentMock.mock.calls[0][0].initialState;
    expect(state.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "github_search" }),
        expect.objectContaining({ name: "github_read" }),
      ]),
    );
    expect(state.systemPrompt).toContain("<github_research_policy>");
    expect(state.systemPrompt).toContain("public scope excludes private repositories");
  });

  it("does not register GitHub research for local output even when configured", async () => {
    process.env.PI_REVIEWER_GITHUB_RESEARCH = "true";

    await review({ cwd: "/repo", githubToken: "token" });

    const state = AgentMock.mock.calls[0][0].initialState;
    expect(state.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "github_search" })]),
    );
    expect(state.systemPrompt).not.toContain("<github_research_policy>");
  });

  it("fails before agent/output when required search is unavailable", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.PI_REVIEWER_WEB_SEARCH = "true";
    process.env.PI_REVIEWER_SEARCH_PROVIDER = "brave";
    process.env.PI_REVIEWER_SEARCH_REQUIRED = "true";

    await expect(
      review({ cwd: "/repo", pr: 42, githubToken: "token", repo: "owner/repo" }),
    ).rejects.toThrow("Required regular web search is unavailable");
    expect(AgentMock).not.toHaveBeenCalled();
    expect(sendOutputMock).not.toHaveBeenCalled();
  });

  it("fails before output when a required search tool operation fails", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.PI_REVIEWER_WEB_SEARCH = "true";
    process.env.PI_REVIEWER_SEARCH_PROVIDER = "duckduckgo";
    process.env.PI_REVIEWER_SEARCH_REQUIRED = "true";
    let end: ((event: unknown) => void) | undefined;
    AgentMock.mockImplementation(function (options: any) {
      return {
        subscribe: vi.fn((callback: (event: unknown) => void) => {
          end = callback;
          return vi.fn();
        }),
        prompt: vi.fn(async () => {
          const tool = options.initialState.tools.find(
            (candidate: { name?: string }) => candidate.name === "web_search",
          );
          await tool.execute("call", { query: "\u0000" }).catch(() => undefined);
          end?.({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "LGTM" }] }],
          });
        }),
      } as any;
    });

    await expect(
      review({ cwd: "/repo", pr: 42, githubToken: "token", repo: "owner/repo" }),
    ).rejects.toThrow("Required web search failed");
    expect(sendOutputMock).not.toHaveBeenCalled();
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
    await review({
      cwd: "/repo",
      fromSha: "base-sha",
      commitId: "head-sha",
      output: "comment",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
    });
    expect(resolveDiffMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromSha: "base-sha", toSha: "head-sha" }),
    );
    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseCommitId: "base-sha" }),
    );
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
    const { sink, records } = createMemorySink();
    loadDocContextMock.mockResolvedValueOnce([
      { path: ".pi/notes/auth.md", content: "auth doc body" },
    ]);

    await review({
      cwd: "/repo",
      dryRun: true,
      docDirs: [".pi/notes"],
      logger: createLogger({ sink }),
    });

    expect(loadDocContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", docDirs: [".pi/notes"] }),
    );
    expect(
      records.find(({ event }) => event === "review.dry_run.system_prompt")?.fields.prompt,
    ).toContain("auth doc body");
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
          cb({
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "401 Invalid API key",
              },
            ],
          });
          return vi.fn();
        }),
        prompt: vi.fn().mockResolvedValue(undefined),
      } as any;
    });

    await expect(
      generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" }),
    ).rejects.toThrow(/Agent failed: 401 Invalid API key/);
  });

  it("aborts and cleans up a reply agent that exceeds its timeout", async () => {
    const unsubscribe = vi.fn();
    const abort = vi.fn();
    AgentMock.mockImplementation(function () {
      return {
        subscribe: vi.fn(() => unsubscribe),
        prompt: vi.fn(() => new Promise<void>(() => {})),
        abort,
      } as any;
    });

    await expect(
      generateReplyResponse({
        parent: "finding",
        userReply: "question",
        thread: "thread",
        replyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/Reply agent timed out after 1ms/);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("uses the submit_reply tool result before assistant text", async () => {
    const toolAction = {
      action: "reply" as const,
      body: "First\\n\\n<!-- pi-reviewer:finding:v1 -->",
    };
    createReplyToolMock.mockReturnValue({
      tool: {
        name: "submit_reply",
        label: "submit_reply",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => toolAction,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent('{"action":"react","content":"heart"}') as any;
    });

    await expect(
      generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" }),
    ).resolves.toEqual({
      action: "reply",
      body: "First\n\n<!-- pi-reviewer : reserved metadata -->",
    });
    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          tools: [expect.objectContaining({ name: "submit_reply" })],
        }),
      }),
    );
  });

  it("rejects a malformed captured submit_reply result", async () => {
    createReplyToolMock.mockReturnValue({
      tool: {
        name: "submit_reply",
        label: "submit_reply",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => ({ action: "invalid" }) as any,
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent('{"action":"react","content":"heart"}') as any;
    });

    await expect(
      generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" }),
    ).rejects.toThrow(/malformed reply action/);
  });

  it("falls back to the legacy JSON reply protocol when no tool result exists", async () => {
    AgentMock.mockImplementation(function () {
      return makeFakeAgent('{"action":"react","content":"heart"}') as any;
    });

    await expect(
      generateReplyResponse({ parent: "finding", userReply: "thanks", thread: "thread" }),
    ).resolves.toEqual({
      action: "react",
      content: "heart",
    });
  });

  it("rejects arbitrary assistant prose when the reply tool was not called", async () => {
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("plain text") as any;
    });

    await expect(
      generateReplyResponse({ parent: "finding", userReply: "question", thread: "thread" }),
    ).rejects.toThrow(/malformed reply action/);
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
      finding_updates: [
        { comment_id: activeFinding.commentId, status: "RESOLVED" as const, explanation: "fixed" },
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

    await review({
      cwd: "/repo",
      output: "comment",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
      commitId: "head",
      activeFindings: [activeFinding],
    });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        existingFindings: [
          {
            commentId: 12345,
            threadId: undefined,
            reviewId: 42,
            bodyFinding: true,
            reviewBody: "visible review body",
          },
        ],
        allowedFindingIds: new Set([12345]),
      }),
    );
  });

  it("passes resolved-finding history through to sendOutput for suppression", async () => {
    const resolvedFindings = [
      {
        historicalFindingId: "inline:42",
        commentId: 42,
        kind: "inline" as const,
        file: "src/a.ts",
        line: 7,
        side: "RIGHT" as const,
        body: "old finding",
        originalBody: "old finding",
      },
    ];
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => ({ summary: "Tool-based review", comments: [] }),
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("") as any;
    });

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

  it("records text fallback semantically and keeps rendered group lines inert", async () => {
    const { sink, records } = createMemorySink();
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

    await review({ cwd: "/repo", logger: createLogger({ sink }) });

    expect(
      records
        .filter(
          ({ event }) =>
            event.startsWith("review.text_fallback") || event === "review.agent.completed_fallback",
        )
        .map(({ event, level, kind, fields }) => ({ event, level, kind, fields })),
    ).toEqual([
      { event: "review.text_fallback", level: "warn", kind: undefined, fields: {} },
      {
        event: "review.text_fallback.content",
        level: "info",
        kind: "group",
        fields: { content: "first line\n::warning::not-a-command" },
      },
      {
        event: "review.agent.completed_fallback",
        level: "info",
        kind: undefined,
        fields: { responseLength: 35 },
      },
    ]);
    expect(formatGroup("response", "first line\n::warning::not-a-command")).toEqual([
      "::group::response",
      "| first line",
      "| ::warning::not-a-command",
      "::endgroup::",
    ]);
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
