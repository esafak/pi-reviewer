import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, createMemorySink } from "../../src/logging/index.js";

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

vi.mock("../../src/core/skill-context.js", () => ({
  loadSkillContext: vi
    .fn()
    .mockResolvedValue({ formatted: "", untrusted: [], skills: [], warnings: [] }),
  parseSkillDirs: vi.fn(() => []),
  resolveSkillDirs: vi.fn(() => []),
  DEFAULT_SKILL_DIRS: [],
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
import {
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createMcpAdapter } from "pi-mcp-adapter";
import { loadContext } from "../../src/core/context.js";
import { extractDiffFiles, resolveDiff } from "../../src/core/diff-resolver.js";
import { loadDocContext } from "../../src/core/doc-context.js";
import { loadSkillContext, resolveSkillDirs } from "../../src/core/skill-context.js";
import { sendOutput } from "../../src/core/output.js";
import { createReviewTool } from "../../src/core/review-tool.js";
import { createReplyTool } from "../../src/core/reply-tool.js";
import type { CiMcpConfig } from "../../src/ci/mcp-config.js";
import { LSP_TOOL_NAMES } from "../../src/ci/tool-names.js";
import {
  ALLOWED_REACTIONS,
  buildReplyPrompt,
  defuseReplyMetadata,
  extractMcpErrorSignal,
  extractMcpToolIdentity,
  FORCED_SUBMIT_TOOL,
  generateReplyResponse,
  parseReplyAction,
  resolveProviderApiKey,
  review,
  parseDocDirs,
  parseSummaryFlag,
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
const extractDiffFilesMock = vi.mocked(extractDiffFiles);
const loadContextMock = vi.mocked(loadContext);
const loadDocContextMock = vi.mocked(loadDocContext);
const sendOutputMock = vi.mocked(sendOutput);
const AgentMock = vi.mocked(Agent);
const createReadOnlyToolsMock = vi.mocked(createReadOnlyTools);
const createAgentSessionMock = vi.mocked(createAgentSession);
const DefaultResourceLoaderMock = vi.mocked(DefaultResourceLoader);
const createMcpAdapterMock = vi.mocked(createMcpAdapter);
const createReviewToolMock = vi.mocked(createReviewTool);
const createReplyToolMock = vi.mocked(createReplyTool);

let fakeAgentEvents: unknown[] = [];
let fakeMcpSession: ReturnType<typeof makeFakeMcpSession>;

interface FakeAgent {
  subscribe: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  state: { tools: unknown[] };
  streamFunction: ReturnType<typeof vi.fn>;
}

function makeFakeAgent(text = "LGTM"): FakeAgent {
  let listener: ((event: unknown) => void) | undefined;
  const agent: FakeAgent = {
    subscribe: vi.fn((cb: (event: unknown) => void) => {
      listener = cb;
      return vi.fn();
    }),
    // Events are delivered per run, not at subscribe time: the review loop can
    // start a second run (the retry turn), and each run has to end on its own
    // agent_end. The prompt also calls the *installed* stream function — the
    // review wrapper once review() has run — so a test can observe the request
    // the run would have sent.
    prompt: vi.fn(async () => {
      agent.streamFunction({} as never, {} as never, {} as never);
      for (const event of fakeAgentEvents) listener?.(event);
      listener?.({
        type: "agent_end",
        messages: [{ role: "assistant", content: [{ type: "text", text }] }],
      });
    }),
    state: { tools: [] },
    streamFunction: vi.fn(),
  };
  return agent;
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
  const registered = [
    { definition: { name: "mcp" } },
    { definition: { name: "lsp_diagnostics" } },
    { definition: { name: "lsp_hover" } },
    { definition: { name: "lsp_definition" } },
    { definition: { name: "lsp_references" } },
    { definition: { name: "lsp_symbols" } },
  ];
  // setActiveToolsByName assigns state.tools synchronously from the
  // registry (verified against the installed SDK), mirroring production.
  // The allowlist itself is not modeled here - see lsp-activation.test.ts
  // for the real-session proof that the tools list gates activation.
  return {
    agent,
    extensionRunner: {
      getAllRegisteredTools: vi.fn(() => registered),
      emit: vi.fn().mockResolvedValue(undefined),
    },
    setActiveToolsByName: vi.fn((names: string[]) => {
      // Fake registry: every activated name resolves to a tool definition.
      agent.state.tools = names.map((name) =>
        name === "mcp" ? mcpTool : { name, label: name, execute: vi.fn() },
      );
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
      getResult: () => ({ action: "review", result: { summary: "LGTM", comments: [] } }),
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
    delete process.env.PI_REVIEWER_LSP_SERVERS;
    delete process.env.PI_REVIEWER_LSP_CONFIG_FILE;
    delete process.env.PI_AGENT_DIR;
    delete process.env.PI_REVIEWER_WEB_SEARCH;
    delete process.env.PI_REVIEWER_SEARCH_PROVIDER;
    delete process.env.PI_REVIEWER_SEARCH_REQUIRED;
    delete process.env.PI_REVIEWER_AI_SEARCH;
    delete process.env.PI_REVIEWER_AI_SEARCH_PROVIDER;
    delete process.env.PI_REVIEWER_AI_SEARCH_REQUIRED;
    delete process.env.PI_REVIEWER_GH;
    delete process.env.PI_REVIEWER_GITHUB_SCOPE;
    delete process.env.EXA_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.PI_REVIEWER_CODE_EXEC;
    delete process.env.PI_REVIEWER_CODE_EXEC_IMAGE;
    delete process.env.PI_REVIEWER_CODE_EXEC_TIMEOUT_MS;
    delete process.env.PI_REVIEWER_CODE_EXEC_MAX_CALLS;
    delete process.env.PI_REVIEWER_CODE_EXEC_WALL_BUDGET_MS;
    delete process.env.PI_REVIEWER_CODE_EXEC_MAX_STREAM_BYTES;
    delete process.env.PI_REVIEWER_EXTRA_INSTRUCTIONS;
    // model is mandatory — provide a default for tests that don't exercise it
    process.env.PI_REVIEWER_MODEL = "anthropic/claude-opus-4-6";
  });

  it("prefers explicit extra instructions over env in the dry-run prompt", async () => {
    process.env.PI_REVIEWER_EXTRA_INSTRUCTIONS = "from env";
    const { sink, records } = createMemorySink();

    await review({
      cwd: "/repo",
      dryRun: true,
      extraInstructions: "from option",
      logger: createLogger({ sink }),
    });

    const prompt = records.find(({ event }) => event === "review.dry_run.system_prompt")?.fields
      .prompt as string;
    expect(prompt).toContain("<custom_instructions>\nfrom option\n</custom_instructions>");
    expect(prompt).not.toContain("from env");
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

  it("loads default skills into the dry-run system prompt", async () => {
    const { sink, records } = createMemorySink();
    resolveDiffMock.mockResolvedValue({
      diff: "diff --git a/a.ts b/a.ts",
      source: "git diff origin/main...HEAD",
      changedFiles: ["a.ts", "skills/deploy/SKILL.md"],
    });
    vi.mocked(resolveSkillDirs).mockReturnValueOnce(["skills"]);
    vi.mocked(loadSkillContext).mockResolvedValueOnce({
      formatted: "SKILL-MARKER",
      untrusted: [],
      skills: [{ name: "deploy" } as never],
      warnings: [],
    });

    await review({ cwd: "/repo", dryRun: true, logger: createLogger({ sink }) });

    expect(loadSkillContext).toHaveBeenCalledWith(
      expect.objectContaining({ trustFiles: ["a.ts", "skills/deploy/SKILL.md"] }),
    );
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.dry_run.system_prompt",
          fields: expect.objectContaining({ prompt: expect.stringContaining("SKILL-MARKER") }),
        }),
      ]),
    );
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
        structuredResult: { summary: "LGTM", comments: [] },
        cwd: "/repo",
      }),
    );
  });

  it("registers code_exec only for enabled CI comment reviews", async () => {
    process.env.PI_REVIEWER_CODE_EXEC = "true";
    await review({ cwd: "/repo", output: "comment", lspServers: "none" });
    expect(AgentMock.mock.calls[0][0].initialState.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "code_exec" })]),
    );
  });

  it("withholds code_exec for non-comment output even when enabled", async () => {
    process.env.PI_REVIEWER_CODE_EXEC = "true";
    await review({ cwd: "/repo", output: "terminal" });
    expect(AgentMock.mock.calls[0][0].initialState.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "code_exec" })]),
    );
  });

  it("withholds code_exec for comment output when not enabled", async () => {
    await review({ cwd: "/repo", output: "comment", lspServers: "none" });
    expect(AgentMock.mock.calls[0][0].initialState.tools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "code_exec" })]),
    );
  });

  it("injects the code_exec policy into dry-run prompts when enabled", async () => {
    process.env.PI_REVIEWER_CODE_EXEC = "true";
    const { sink, records } = createMemorySink();
    await review({ cwd: "/repo", output: "comment", dryRun: true, logger: createLogger({ sink }) });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.dry_run.system_prompt",
          fields: expect.objectContaining({
            prompt: expect.stringContaining("code_exec_policy"),
          }),
        }),
      ]),
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
        tools: expect.arrayContaining(["read", "grep", "find", "mcp", "submit_review"]),
        customTools: expect.arrayContaining([expect.objectContaining({ name: "submit_review" })]),
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
    // The prompt is seeded via the resource loader's leading system message;
    // state.systemPrompt replays the transcript and is read-only.
    expect(DefaultResourceLoaderMock).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: expect.stringContaining("<mcp_tool_policy>") }),
    );
    expect(fakeMcpSession.agent.state.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "submit_review" })]),
    );
    expect(fakeMcpSession.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(fakeMcpSession.dispose).toHaveBeenCalled();
  });

  it("keeps code_exec in the final MCP agent tools when enabled", async () => {
    process.env.PI_REVIEWER_CODE_EXEC = "true";
    const mcpConfig: CiMcpConfig = {
      mcpServers: { docs: { url: "https://mcp.example/mcp" } },
    };
    await review({ cwd: "/repo", repo: "owner/repo", mcpConfig, output: "comment" });
    // Assert the definition reaches the registry, not just the active-names list.
    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customTools: expect.arrayContaining([expect.objectContaining({ name: "code_exec" })]),
      }),
    );
    expect(fakeMcpSession.agent.state.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "code_exec" })]),
    );
  });

  it("creates an extension session with LSP tools for comment reviews by default", async () => {
    const { sink, records } = createMemorySink();
    await review({
      cwd: "/repo",
      repo: "owner/repo",
      output: "comment",
      logger: createLogger({ sink }),
    });

    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        tools: expect.arrayContaining(["read", "grep", "find", "submit_review"]),
        customTools: expect.arrayContaining([expect.objectContaining({ name: "submit_review" })]),
      }),
    );
    expect(fakeMcpSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["lsp_diagnostics", "lsp_hover", "lsp_definition"]),
    );
    expect(AgentMock).not.toHaveBeenCalled();
    // The session tools allowlist is also the registration gate: lsp_*
    // names must be present or the registry filters them out.
    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ tools: expect.arrayContaining([...LSP_TOOL_NAMES]) }),
    );
    expect(records).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: "review.lsp.enabled" })]),
    );
    const status = records.find(({ event }) => event === "review.tools.status");
    expect(status?.fields.available).toEqual(
      expect.arrayContaining(["lsp_diagnostics", "lsp_hover"]),
    );
  });

  it("restores the plain agent path when lsp-servers is none", async () => {
    await review({ cwd: "/repo", repo: "owner/repo", output: "comment", lspServers: "none" });

    expect(createAgentSessionMock).not.toHaveBeenCalled();
    expect(AgentMock).toHaveBeenCalled();
  });

  it("logs one line for all missing LSP servers", async () => {
    const { sink, records } = createMemorySink();
    await review({
      cwd: "/repo",
      repo: "owner/repo",
      output: "comment",
      lspServers: "ty,gopls",
      lspOverrides: {
        ty: { bin: "definitely-not-a-real-binary" },
        gopls: { bin: "definitely-not-a-real-binary" },
      },
      logger: createLogger({ sink }),
    });

    const missing = records.filter(({ event }) => event === "review.lsp.server.missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.fields.servers).toEqual(
      expect.arrayContaining([expect.stringContaining("ty"), expect.stringContaining("gopls")]),
    );
  });

  it("fails fast on unknown lsp-servers ids", async () => {
    await expect(
      review({ cwd: "/repo", repo: "owner/repo", output: "comment", lspServers: "pyright" }),
    ).rejects.toThrow('Unknown LSP server "pyright"');
    expect(createAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps MCP and LSP tools namespaced in a combined session", async () => {
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };
    await review({
      cwd: "/repo",
      repo: "owner/repo",
      mcpConfig,
      output: "comment",
      lspServers: "ty",
    });

    expect(fakeMcpSession.setActiveToolsByName).toHaveBeenCalledWith(
      expect.arrayContaining(["mcp", "lsp_diagnostics"]),
    );
  });

  it("withholds LSP tools from MCP-only sessions", async () => {
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };
    await review({
      cwd: "/repo",
      repo: "owner/repo",
      mcpConfig,
      output: "comment",
      lspServers: "none",
    });

    const names = fakeMcpSession.setActiveToolsByName.mock.calls[0][0] as string[];
    expect(names).toEqual(expect.arrayContaining(["mcp"]));
    expect(names).not.toEqual(expect.arrayContaining(["lsp_diagnostics"]));
    expect(createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ tools: expect.not.arrayContaining(["lsp_diagnostics"]) }),
    );
  });

  it("cleans up the extension session and restores env when the run fails", async () => {
    process.env.PI_AGENT_DIR = "sentinel-before";
    // The session path uses the session's agent, not the Agent constructor.
    fakeMcpSession.agent.prompt = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      review({ cwd: "/repo", repo: "owner/repo", output: "comment", lspServers: "ty" }),
    ).rejects.toThrow("boom");
    expect(fakeMcpSession.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    expect(fakeMcpSession.dispose).toHaveBeenCalled();
    expect(process.env.PI_AGENT_DIR).toBe("sentinel-before");
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
          delta: "Before",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: " tool.",
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
          delta: "After",
        },
      },
      {
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: " tool.",
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
        "run_end",
        "thinking",
        "run_end",
      ]);
      expect(trace[0]).toMatchObject({ type: "thinking", text: "Before tool." });
      expect(trace[1]).toMatchObject({ type: "tool_start", tool: "read_file", callId: "call-1" });
      expect(trace[2]).toMatchObject({
        type: "tool_end",
        tool: "read_file",
        callId: "call-1",
        status: "success",
        resultBytes: Buffer.byteLength("private file contents", "utf8"),
        resultEmpty: false,
      });
      expect(trace[3]).toMatchObject({
        type: "run_end",
        hasDecision: true,
      });
      expect(trace[4]).toMatchObject({ type: "thinking", text: "After tool." });
      expect(trace[5]).toMatchObject({ type: "run_end", hasDecision: true });
      for (const entry of trace) {
        expect(entry.timestamp).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
      }
      expect(trace[0].endTimestamp).toEqual(expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
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

  it("captures thinking content parts when the provider sends no thinking deltas", async () => {
    fakeAgentEvents = [
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "The model's completed reasoning." },
              { type: "text", text: "LGTM" },
            ],
          },
        ],
      },
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "pi-reviewer-thinking-final-test-"));
    const artifactPath = path.join(directory, "thinking.jsonl");
    const previousArtifactPath = process.env.PI_REVIEWER_THINKING_ARTIFACT;
    process.env.PI_REVIEWER_THINKING_ARTIFACT = artifactPath;
    try {
      await review({ cwd: "/repo", debug: true });
      const trace = (await readFile(artifactPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(trace).toEqual([
        expect.objectContaining({
          type: "thinking",
          text: "The model's completed reasoning.",
          timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
          endTimestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        }),
        expect.objectContaining({ type: "run_end", hasDecision: true }),
        expect.objectContaining({ type: "run_end", hasDecision: true }),
      ]);
    } finally {
      if (previousArtifactPath === undefined) delete process.env.PI_REVIEWER_THINKING_ARTIFACT;
      else process.env.PI_REVIEWER_THINKING_ARTIFACT = previousArtifactPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fingerprints tool results by size without persisting payloads", async () => {
    const unicodeText = "héllo 🌍";
    fakeAgentEvents = [
      { type: "tool_execution_start", toolName: "read_file", toolCallId: "empty" },
      {
        type: "tool_execution_end",
        toolName: "read_file",
        toolCallId: "empty",
        result: "",
        isError: false,
      },
      { type: "tool_execution_start", toolName: "read_file", toolCallId: "blank" },
      {
        type: "tool_execution_end",
        toolName: "read_file",
        toolCallId: "blank",
        result: "   ",
        isError: false,
      },
      { type: "tool_execution_start", toolName: "read_file", toolCallId: "unicode" },
      {
        type: "tool_execution_end",
        toolName: "read_file",
        toolCallId: "unicode",
        result: unicodeText,
        isError: false,
      },
      { type: "tool_execution_start", toolName: "read_file", toolCallId: "image" },
      {
        type: "tool_execution_end",
        toolName: "read_file",
        toolCallId: "image",
        result: { content: [{ type: "image", source: "private-bytes" }] },
        isError: false,
      },
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "pi-reviewer-fingerprint-test-"));
    const artifactPath = path.join(directory, "thinking.jsonl");
    const previousArtifactPath = process.env.PI_REVIEWER_THINKING_ARTIFACT;
    process.env.PI_REVIEWER_THINKING_ARTIFACT = artifactPath;
    try {
      await review({ cwd: "/repo", debug: true });
      const trace = (await readFile(artifactPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const ends = trace.filter((entry) => entry.type === "tool_end") as Array<
        Record<string, unknown>
      >;
      expect(ends.map((entry) => entry.callId)).toEqual(["empty", "blank", "unicode", "image"]);
      expect(ends[0]).toMatchObject({ status: "success", resultBytes: 0, resultEmpty: true });
      expect(ends[1]).toMatchObject({
        status: "success",
        resultBytes: Buffer.byteLength("   ", "utf8"),
        resultEmpty: true,
      });
      expect(ends[2]).toMatchObject({
        status: "success",
        resultBytes: Buffer.byteLength(unicodeText, "utf8"),
        resultEmpty: false,
      });
      // Non-text payloads are content even with no text. Objects measure
      // serialized JSON bytes consistently with empty envelopes.
      const imageResult = { content: [{ type: "image", source: "private-bytes" }] };
      expect(ends[3]).toMatchObject({
        status: "success",
        resultBytes: Buffer.byteLength(JSON.stringify(imageResult), "utf8"),
        resultEmpty: false,
      });
      expect(JSON.stringify(trace)).not.toContain("private-bytes");
      expect(JSON.stringify(trace)).not.toContain(unicodeText);
    } finally {
      if (previousArtifactPath === undefined) delete process.env.PI_REVIEWER_THINKING_ARTIFACT;
      else process.env.PI_REVIEWER_THINKING_ARTIFACT = previousArtifactPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports per-run thinking counters across the retry", async () => {
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
    fakeAgentEvents = [
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "abc" },
      },
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "pi-reviewer-per-run-test-"));
    const artifactPath = path.join(directory, "thinking.jsonl");
    const previousArtifactPath = process.env.PI_REVIEWER_THINKING_ARTIFACT;
    process.env.PI_REVIEWER_THINKING_ARTIFACT = artifactPath;
    try {
      await expect(review({ cwd: "/repo", debug: true })).rejects.toThrow(
        "Agent finished without calling submit_review",
      );
      const trace = (await readFile(artifactPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const ends = trace.filter((entry) => entry.type === "run_end");
      // Initial run plus the nudge retry: each reports only its own prompt.
      expect(ends.length).toBeGreaterThanOrEqual(2);
      for (const entry of ends) {
        expect(entry).toMatchObject({ hasDecision: false, thinkingDeltas: 1, thinkingChars: 3 });
      }
    } finally {
      if (previousArtifactPath === undefined) delete process.env.PI_REVIEWER_THINKING_ARTIFACT;
      else process.env.PI_REVIEWER_THINKING_ARTIFACT = previousArtifactPath;
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
          fields: { server: "docs", tool: "search_docs", callId: "mcp-call-1" },
        }),
        expect.objectContaining({
          event: "review.mcp.tool_result",
          fields: { server: "docs", tool: "search_docs", callId: "mcp-call-1", status: "success" },
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain(secretArgument);
    expect(JSON.stringify(records)).not.toContain("private query");
  });

  describe("extractMcpErrorSignal", () => {
    it("maps adapter codes to classes without reading content", () => {
      expect(
        extractMcpErrorSignal({
          details: { mode: "call", error: "tool_error", server: "docs" },
          content: [{ type: "text", text: "server said no" }],
        }),
      ).toEqual({ errorClass: "tool" });
      expect(
        extractMcpErrorSignal({
          details: { mode: "call", error: "call_failed", server: "docs", message: "fetch failed" },
        }),
      ).toEqual({ errorClass: "call_failed", detail: "fetch failed" });
      expect(
        extractMcpErrorSignal({
          details: {
            error: "input_required_needs_ui",
            server: "docs",
            message: "approval in browser UI",
          },
        }),
      ).toEqual({ errorClass: "input_required", detail: "approval in browser UI" });
      expect(extractMcpErrorSignal({ details: { error: "bogus" } })).toEqual({
        errorClass: "unknown",
      });
      expect(extractMcpErrorSignal({})).toBeUndefined();
      expect(extractMcpErrorSignal(undefined)).toBeUndefined();
    });

    it("sanitizes, truncates, and never leaks bearer-like values", () => {
      const secret = "bearer abcdefghij1234567890";
      const signal = extractMcpErrorSignal({
        details: { error: "call_failed", message: `  ok\x00${"x".repeat(600)}` },
      });
      expect(signal?.detail).not.toContain(secret);
      expect(signal?.detail?.length).toBeLessThanOrEqual(500);
      // eslint-disable-next-line no-control-regex -- asserts sanitized output has no control chars
      expect(signal?.detail).not.toMatch(/[\x00-\x1f]/);
      expect(
        extractMcpErrorSignal({ details: { error: "call_failed", message: secret } })?.detail,
      ).toContain("bearer");
    });
  });

  describe("extractMcpToolIdentity", () => {
    const known = new Set(["docs"]);
    it("splits proxy server/tool without duplication", () => {
      expect(
        extractMcpToolIdentity(
          "mcp",
          { server: "docs", tool: "search_docs" },
          new Set(["mcp"]),
          known,
        ),
      ).toEqual({ server: "docs", tool: "search_docs" });
    });
    it("handles search/connect/action pseudos with no server", () => {
      const registered = new Set(["mcp"]);
      expect(extractMcpToolIdentity("mcp", { search: "x" }, registered, known)).toEqual({
        tool: "search",
      });
      expect(
        extractMcpToolIdentity("mcp", { connect: "docs" }, registered, known)?.server,
      ).toBeUndefined();
      expect(extractMcpToolIdentity("mcp", { action: "list" }, registered, known)).toEqual({
        tool: "list",
      });
    });
    it("splits namespace-proxy and direct prefixed names", () => {
      expect(
        extractMcpToolIdentity("mcp__docs", { tool: "search_docs" }, new Set(["mcp__docs"]), known),
      ).toEqual({ server: "docs", tool: "search_docs" });
      expect(
        extractMcpToolIdentity("docs_search_docs", {}, new Set(["docs_search_docs"]), known),
      ).toEqual({ server: "docs", tool: "search_docs" });
    });
    it("falls back and rejects unknown tools", () => {
      expect(extractMcpToolIdentity("mcp__other", {}, new Set(["mcp__other"]), known)).toEqual({
        server: undefined,
        tool: "mcp__other",
      });
      expect(extractMcpToolIdentity("nope", {}, new Set(["mcp"]), known)).toBeUndefined();
    });
  });

  it("emits split server/tool plus error class on MCP failure", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-failed-call",
        args: { server: "docs", tool: "search_docs", args: { query: "x" } },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-failed-call",
        isError: true,
        result: { details: { mode: "call", error: "call_failed", message: "fetch failed" } },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(
      review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) }),
    ).rejects.toThrow("A configured MCP tool call failed; refusing to post the review");
    const failed = records.find(({ event }) => event === "review.mcp.failed");
    expect(failed?.fields).toEqual({
      servers: ["docs"],
      tools: ["search_docs"],
      errorClasses: ["call_failed"],
      additionalTools: "",
    });
    expect(JSON.stringify(failed?.fields)).not.toContain("fetch failed");
  });

  it("keeps server/tool pairing with unknown for server-less failures", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-search-call",
        args: { search: "query" },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-search-call",
        isError: true,
        result: { details: { mode: "call", error: "tool_error" } },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(
      review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) }),
    ).rejects.toThrow("A configured MCP tool call failed; refusing to post the review");
    const failed = records.find(({ event }) => event === "review.mcp.failed");
    expect(failed?.fields).toEqual({
      servers: ["unknown"],
      tools: ["search"],
      errorClasses: ["tool"],
      additionalTools: "",
    });
  });

  it("omits errorClass on successful results that carry details", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-ok-call",
        args: { server: "docs", tool: "search_docs", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-ok-call",
        isError: false,
        result: { details: { mode: "call", server: "docs", tool: "search_docs" } },
      },
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
    const result = records.find(({ event }) => event === "review.mcp.tool_result");
    expect(result?.fields).toEqual({
      server: "docs",
      tool: "search_docs",
      callId: "mcp-ok-call",
      status: "success",
    });
  });

  it("records the trace tool_end signal for failed MCP calls", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-trace-call",
        args: { server: "docs", tool: "search_docs", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-trace-call",
        isError: true,
        result: { details: { mode: "call", error: "call_failed", message: "fetch failed" } },
      },
    ];
    const directory = await mkdtemp(path.join(tmpdir(), "pi-reviewer-mcp-trace-test-"));
    const artifactPath = path.join(directory, "thinking.jsonl");
    const previousArtifactPath = process.env.PI_REVIEWER_THINKING_ARTIFACT;
    process.env.PI_REVIEWER_THINKING_ARTIFACT = artifactPath;
    try {
      const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };
      await expect(
        review({ cwd: "/repo", output: "comment", mcpConfig, debug: true }),
      ).rejects.toThrow("A configured MCP tool call failed");
      const trace = (await readFile(artifactPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_end",
            server: "docs",
            tool: "search_docs",
            status: "error",
            errorClass: "call_failed",
            detail: "fetch failed",
          }),
        ]),
      );
    } finally {
      if (previousArtifactPath === undefined) delete process.env.PI_REVIEWER_THINKING_ARTIFACT;
      else process.env.PI_REVIEWER_THINKING_ARTIFACT = previousArtifactPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits sanitized detail only in debug tool_result", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-failed-call",
        args: { server: "docs", tool: "search_docs", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-failed-call",
        isError: true,
        result: { details: { mode: "call", error: "call_failed", message: "fetch failed" } },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(
      review({
        cwd: "/repo",
        output: "comment",
        mcpConfig,
        debug: true,
        logger: createLogger({ sink }),
      }),
    ).rejects.toThrow("A configured MCP tool call failed");
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review.mcp.tool_result",
          fields: expect.objectContaining({
            server: "docs",
            tool: "search_docs",
            status: "error",
            errorClass: "call_failed",
            detail: "fetch failed",
          }),
        }),
      ]),
    );
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

  it("posts the review with a warning when DeepWiki rejects an unindexed repo", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-call",
        args: { tool: "deepwiki_ask_wiki_question" },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-call",
        isError: true,
        result: {
          details: { mode: "call", error: "tool_error", server: "deepwiki" },
          content: [
            {
              type: "text",
              text: "Error processing question: Repository not found. Visit https://deepwiki.com to index it.",
            },
          ],
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { deepwiki: { url: "https://mcp.example/mcp" } } };

    await review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) });

    expect(sendOutputMock).toHaveBeenCalled();
    const failed = records.find(({ event }) => event === "review.mcp.failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.fields).toEqual({
      servers: ["unknown"],
      tools: ["deepwiki_ask_wiki_question"],
      errorClasses: ["tool"],
      additionalTools: "",
    });
    expect(JSON.stringify(records)).not.toContain("Repository not found");
  });

  it("warns on the read tools' unindexed wording too", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-read-call",
        args: { tool: "deepwiki_read_wiki_contents" },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-read-call",
        isError: true,
        result: {
          details: { mode: "call", error: "tool_error", server: "deepwiki" },
          content: [
            {
              type: "text",
              text: "Error fetching wiki for owner/repo: Repository not found. Visit https://deepwiki.com/owner/repo to index it.",
            },
          ],
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { deepwiki: { url: "https://mcp.example/mcp" } } };

    await review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) });

    expect(sendOutputMock).toHaveBeenCalled();
    expect(records.find(({ event }) => event === "review.mcp.failed")?.level).toBe("warn");
  });

  it("warns on bare DeepWiki tool names without a server label", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-bare-call",
        args: { tool: "read_wiki_structure" },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-bare-call",
        isError: true,
        result: {
          details: { mode: "call", error: "tool_error" },
          content: [
            {
              type: "text",
              text: "Error fetching wiki for owner/repo: Repository not found.",
            },
          ],
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { deepwiki: { url: "https://mcp.example/mcp" } } };

    await review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) });

    expect(sendOutputMock).toHaveBeenCalled();
    const failed = records.find(({ event }) => event === "review.mcp.failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.fields).toEqual({
      servers: ["unknown"],
      tools: ["read_wiki_structure"],
      errorClasses: ["tool"],
      additionalTools: "",
    });
  });

  it("still refuses to post on other DeepWiki errors", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-call",
        args: { server: "deepwiki", tool: "ask_wiki_question", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-deepwiki-call",
        isError: true,
        result: {
          details: { mode: "call", error: "tool_error", server: "deepwiki" },
          content: [{ type: "text", text: "Error processing question: upstream unavailable." }],
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { deepwiki: { url: "https://mcp.example/mcp" } } };

    await expect(
      review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) }),
    ).rejects.toThrow("A configured MCP tool call failed; refusing to post the review");
    expect(sendOutputMock).not.toHaveBeenCalled();
    expect(records.find(({ event }) => event === "review.mcp.failed")?.level).toBe("error");
  });

  it("warns on repository-not-found from any server", async () => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-docs-bare-call",
        args: { server: "docs", tool: "ask_question", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-docs-bare-call",
        isError: true,
        result: {
          details: { mode: "call", error: "tool_error", server: "docs" },
          content: [{ type: "text", text: "Repository not found." }],
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = {
      mcpServers: {
        deepwiki: { url: "https://mcp.example/mcp" },
        docs: { url: "https://mcp.example/mcp" },
      },
    };

    await review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) });

    expect(sendOutputMock).toHaveBeenCalled();
    expect(records.find(({ event }) => event === "review.mcp.failed")?.level).toBe("warn");
  });

  it.each([
    ["call_failed", { mode: "call", error: "call_failed", message: "fetch failed" }],
    [
      "input_required",
      { mode: "call", error: "input_required_needs_ui", message: "approval needed" },
    ],
    ["unknown", { mode: "call", error: "bogus" }],
  ])("still vetoes %s even with repository-not-found text", async (_label, details) => {
    fakeAgentEvents = [
      {
        type: "tool_execution_start",
        toolName: "mcp",
        toolCallId: "mcp-non-tool-call",
        args: { server: "docs", tool: "search_docs", args: {} },
      },
      {
        type: "tool_execution_end",
        toolName: "mcp",
        toolCallId: "mcp-non-tool-call",
        isError: true,
        result: {
          details,
          content: [{ type: "text", text: "Repository not found." }],
        },
      },
    ];
    const { sink, records } = createMemorySink();
    const mcpConfig: CiMcpConfig = { mcpServers: { docs: { url: "https://mcp.example/mcp" } } };

    await expect(
      review({ cwd: "/repo", output: "comment", mcpConfig, logger: createLogger({ sink }) }),
    ).rejects.toThrow("A configured MCP tool call failed; refusing to post the review");
    expect(sendOutputMock).not.toHaveBeenCalled();
    expect(records.find(({ event }) => event === "review.mcp.failed")?.level).toBe("error");
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

    await review({
      cwd: "/repo",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
      lspServers: "none",
    });

    const state = AgentMock.mock.calls[0][0].initialState;
    expect(state.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "package_lookup" })]),
    );
    expect(state.systemPrompt).toContain("<package_registry_policy>");
    expect(state.tools).toEqual(
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

  it("logs available and unavailable tools on CI comment startup", async () => {
    process.env.GITHUB_ACTIONS = "true";
    const { sink, records } = createMemorySink();

    await review({
      cwd: "/repo",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
      logger: createLogger({ sink }),
    });

    const status = records.find(({ event }) => event === "review.tools.status");
    expect(status?.level).toBe("info");
    expect(status?.fields.available).toEqual(
      expect.arrayContaining(["package_lookup", "github_search", "github_read"]),
    );
    expect(status?.fields.available).not.toEqual(
      expect.arrayContaining(["web_search", "web_ai_search", "code_exec", "mcp"]),
    );
    expect(status?.fields.unavailable).toEqual(
      expect.arrayContaining(["web_search", "web_ai_search", "code_exec", "mcp"]),
    );
  });

  it("includes optional search, code-exec, and mcp tools when configured", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.PI_REVIEWER_WEB_SEARCH = "true";
    process.env.PI_REVIEWER_SEARCH_PROVIDER = "duckduckgo";
    process.env.PI_REVIEWER_AI_SEARCH = "true";
    process.env.PI_REVIEWER_AI_SEARCH_PROVIDER = "exa";
    process.env.EXA_API_KEY = "test-key";
    process.env.PI_REVIEWER_CODE_EXEC = "true";
    const { sink, records } = createMemorySink();

    await review({
      cwd: "/repo",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
      mcpConfig: { mcpServers: { docs: { url: "https://mcp.example/mcp" } } },
      output: "comment",
      logger: createLogger({ sink }),
    });

    const status = records.find(({ event }) => event === "review.tools.status");
    expect(status?.fields.available).toEqual(
      expect.arrayContaining([
        "web_search",
        "web_ai_search",
        "package_lookup",
        "github_search",
        "github_read",
        "code_exec",
        "mcp",
      ]),
    );
    expect(status?.fields.unavailable).toEqual([]);
  });

  it("does not log tool availability for local output", async () => {
    const { sink, records } = createMemorySink();

    await review({ cwd: "/repo", logger: createLogger({ sink }) });

    expect(records.find(({ event }) => event === "review.tools.status")).toBeUndefined();
  });

  it("registers GitHub research tools only for enabled CI comment reviews", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.PI_REVIEWER_GH = "true";
    process.env.PI_REVIEWER_GITHUB_SCOPE = "public";

    await review({
      cwd: "/repo",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
      lspServers: "none",
    });

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
    process.env.PI_REVIEWER_GH = "true";

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
      review({
        cwd: "/repo",
        pr: 42,
        githubToken: "token",
        repo: "owner/repo",
        lspServers: "none",
      }),
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

  it("injects PR title and body into the system prompt", async () => {
    const { sink, records } = createMemorySink();

    await review({
      cwd: "/repo",
      dryRun: true,
      title: "Add retry",
      body: "Fixes the timeout",
      logger: createLogger({ sink }),
    });

    const prompt = records.find(({ event }) => event === "review.dry_run.system_prompt")?.fields
      .prompt as string;
    expect(prompt).toContain("<pull_request>");
    expect(prompt).toContain("<title>\nAdd retry\n</title>");
    expect(prompt).toContain("<body>\nFixes the timeout\n</body>");
  });

  it("omits the PR section when title and body are null or blank", async () => {
    const { sink, records } = createMemorySink();

    await review({
      cwd: "/repo",
      dryRun: true,
      title: null,
      body: "   ",
      logger: createLogger({ sink }),
    });

    const prompt = records.find(({ event }) => event === "review.dry_run.system_prompt")?.fields
      .prompt as string;
    expect(prompt).not.toContain("<pull_request>");
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
      let listener: ((event: unknown) => void) | undefined;
      return {
        subscribe: vi.fn((cb: (event: unknown) => void) => {
          listener = cb;
          return vi.fn();
        }),
        prompt: vi.fn(async () => {
          listener?.({
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
        }),
        state: { tools: [] as unknown[] },
        streamFunction: vi.fn(),
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

  it("posts the typed decision's result to sendOutput", async () => {
    await review({ cwd: "/repo" });

    expect(sendOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredResult: { summary: "LGTM", comments: [] },
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
      getResult: () => ({ action: "review", result: toolReview }),
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

  it("returns only the overview without posting in summary-only mode", async () => {
    const toolReview = {
      summary: "One line",
      pr_summary: "What: x. Why: y. Risks: z.",
      pr_diagram: "flowchart TD\nA-->B",
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
      getResult: () => ({ action: "review", result: toolReview }),
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("") as any;
    });

    const overview = await review({ cwd: "/repo", output: "comment", summaryOnly: true });

    expect(overview).toEqual({
      pr_summary: "What: x. Why: y. Risks: z.",
      pr_diagram: "flowchart TD\nA-->B",
    });
    expect(sendOutputMock).not.toHaveBeenCalled();
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
      getResult: () => ({ action: "review", result: toolReview }),
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
      getResult: () => ({
        action: "review",
        result: { summary: "Tool-based review", comments: [] },
      }),
    });
    AgentMock.mockImplementation(function () {
      return makeFakeAgent("") as any;
    });

    await review({ cwd: "/repo", resolvedFindings });

    expect(sendOutputMock).toHaveBeenCalledWith(expect.objectContaining({ resolvedFindings }));
  });

  it("fails without posting when the model did not call submit_review", async () => {
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

    await expect(review({ cwd: "/repo" })).rejects.toThrow(
      "Agent finished without calling submit_review",
    );
    expect(sendOutputMock).not.toHaveBeenCalled();
  });

  it("logs a command-inert excerpt when submit_review was not called", async () => {
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

    await expect(review({ cwd: "/repo", logger: createLogger({ sink }) })).rejects.toThrow(
      "Agent finished without calling submit_review",
    );

    expect(records.find(({ event }) => event === "review.agent.no_decision")).toEqual(
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          textLength: 35,
          textExcerpt: "first line\n ::warning::not-a-command",
        }),
      }),
    );
  });

  it("re-prompts once, without narrowing the declared tools, when submit_review was not called", async () => {
    process.env.GITHUB_ACTIONS = "true";
    process.env.PI_REVIEWER_WEB_SEARCH = "true";
    process.env.PI_REVIEWER_SEARCH_PROVIDER = "duckduckgo";
    process.env.PI_REVIEWER_CODE_EXEC = "true";

    const agent = makeFakeAgent("prose only");
    AgentMock.mockImplementation(function (options: { initialState?: { tools?: unknown[] } }) {
      // Mirror the real constructor: the declared set comes from initialState.
      agent.state.tools = [...(options?.initialState?.tools ?? [])];
      return agent as never;
    });
    let decisionReads = 0;
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      // The first run produces nothing; the retry produces the decision.
      getResult: () => (decisionReads++ === 0 ? undefined : { action: "none" }),
    });

    // Record what each request declares. The retry must not narrow the tool
    // set: the request has to keep matching the transcript it carries.
    const toolsDeclaredPerPrompt: number[] = [];
    const prompt = agent.prompt;
    agent.prompt = vi.fn(async (message: string) => {
      toolsDeclaredPerPrompt.push((agent.state.tools as unknown[]).length);
      return prompt(message);
    });

    await review({
      cwd: "/repo",
      pr: 42,
      githubToken: "token",
      repo: "owner/repo",
      output: "comment",
      lspServers: "none",
    });

    expect(agent.prompt).toHaveBeenCalledTimes(2);
    expect(String(agent.prompt.mock.calls[1][0])).toContain("submit_review");
    expect(toolsDeclaredPerPrompt[0]).toBeGreaterThan(1);
    expect(toolsDeclaredPerPrompt[1]).toBe(toolsDeclaredPerPrompt[0]);
  });

  it("degrades to the bare nudge when the pinned call is rejected", async () => {
    const { sink, records } = createMemorySink();
    const agent = makeFakeAgent("prose only");
    AgentMock.mockImplementation(function () {
      return agent as never;
    });
    let decisionReads = 0;
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => (decisionReads++ === 0 ? undefined : { action: "none" }),
    });

    // The pinned retry is rejected at the transport (e.g. a provider that wants
    // a different tool_choice shape); the nudge alone must still be attempted.
    let calls = 0;
    const prompt = agent.prompt;
    agent.prompt = vi.fn(async (message: string) => {
      calls += 1;
      if (calls === 2) throw new Error("400 Invalid API parameter");
      return prompt(message);
    });

    await review({ cwd: "/repo", logger: createLogger({ sink }) });

    expect(agent.prompt).toHaveBeenCalledTimes(3);
    expect(records.find(({ event }) => event === "review.agent.forced_call_failed")).toEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ error: "400 Invalid API parameter" }),
      }),
    );
  });

  it("propagates a bare-retry failure instead of reporting a missing decision", async () => {
    const { sink, records } = createMemorySink();
    const agent = makeFakeAgent("prose only");
    AgentMock.mockImplementation(function () {
      return agent as never;
    });
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

    // The pinned attempt is rejected (degrade), then the bare retry fails for a
    // different, genuine reason: that error must surface rather than being
    // relabelled as "the model finished without calling submit_review".
    let calls = 0;
    const prompt = agent.prompt;
    agent.prompt = vi.fn(async (message: string) => {
      calls += 1;
      if (calls === 2) throw new Error("400 Invalid API parameter");
      if (calls === 3) throw new Error("503 upstream unavailable");
      return prompt(message);
    });

    await expect(review({ cwd: "/repo", logger: createLogger({ sink }) })).rejects.toThrow(
      /503 upstream unavailable/,
    );
    expect(records.some(({ event }) => event === "review.agent.no_decision")).toBe(false);
    expect(records.find(({ event }) => event === "review.agent.forced_call_failed")).toEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ error: "400 Invalid API parameter" }),
      }),
    );
  });

  it("waits for the pinned attempt to settle before the bare retry", async () => {
    const { sink, records } = createMemorySink();
    let promptCalls = 0;
    let activeRun = false;
    let listener: ((event: unknown) => void) | undefined;
    const agent = {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        listener = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        promptCalls += 1;
        if (activeRun)
          throw new Error(
            "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
          );
        activeRun = true;
        try {
          agent.streamFunction({} as never, {} as never, {} as never);
          if (promptCalls === 2) {
            // The pinned toolChoice is rejected at the transport: the run
            // ends in error, and the agent only goes idle after its end
            // listeners settle — later than the failure notification.
            listener?.({
              type: "agent_end",
              stopReason: "error",
              errorMessage: "400 Invalid API parameter",
              messages: [{ role: "assistant", content: [{ type: "text", text: "" }] }],
            });
            await new Promise((resolve) => setTimeout(resolve, 10));
          } else {
            listener?.({
              type: "agent_end",
              messages: [{ role: "assistant", content: [{ type: "text", text: "prose only" }] }],
            });
          }
        } finally {
          activeRun = false;
        }
      }),
      state: { tools: [] as unknown[] },
      streamFunction: vi.fn(),
    };
    AgentMock.mockImplementation(function () {
      return agent as never;
    });
    let decisionReads = 0;
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => (decisionReads++ === 0 ? undefined : { action: "none" }),
    });

    await review({ cwd: "/repo", logger: createLogger({ sink }) });

    expect(agent.prompt).toHaveBeenCalledTimes(3);
    expect(records.find(({ event }) => event === "review.agent.forced_call_failed")).toEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ error: expect.stringContaining("400") }),
      }),
    );
  });

  it("pins the nested chat-completions tool_choice shape", () => {
    // The named form upstream types for this adapter is the nested function
    // object; other shapes are rejected rather than converted (an
    // Anthropic-shaped { type: "tool", name } 400s on zai —
    // earendil-works/pi#5154).
    expect(FORCED_SUBMIT_TOOL).toEqual({
      type: "function",
      function: { name: "submit_review" },
    });
  });

  it("sends the pinned tool_choice on the retry only", async () => {
    const agent = makeFakeAgent("prose only");
    // Captured before review() installs its wrapper, so these are the calls the
    // wrapper makes with the options it would put on the wire.
    const base = agent.streamFunction;
    AgentMock.mockImplementation(function () {
      return agent as never;
    });
    let decisionReads = 0;
    createReviewToolMock.mockReturnValue({
      tool: {
        name: "submit_review",
        label: "submit_review",
        description: "test",
        parameters: {},
        execute: vi.fn(),
      },
      getResult: () => (decisionReads++ === 0 ? undefined : { action: "none" }),
    });

    await review({ cwd: "/repo" });

    // Guard the retry wrapper itself: the second run must pin toolChoice.
    expect(base).toHaveBeenCalledTimes(2);
    expect((base.mock.calls[0][2] as { toolChoice?: unknown }).toolChoice).toBeUndefined();
    expect((base.mock.calls[1][2] as { toolChoice?: unknown }).toolChoice).toEqual(
      FORCED_SUBMIT_TOOL,
    );
  });

  it("does not re-prompt when the first run produced a decision", async () => {
    let agent: ReturnType<typeof makeFakeAgent>;
    AgentMock.mockImplementation(function () {
      agent = makeFakeAgent("");
      return agent as never;
    });

    await review({ cwd: "/repo" });

    expect(agent!.prompt).toHaveBeenCalledTimes(1);
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

describe("parseSummaryFlag", () => {
  it("defaults to true when unset or empty", () => {
    expect(parseSummaryFlag(undefined)).toBe(true);
    expect(parseSummaryFlag("")).toBe(true);
    expect(parseSummaryFlag("   ")).toBe(true);
  });

  it("disables only on explicit false", () => {
    expect(parseSummaryFlag("false")).toBe(false);
    expect(parseSummaryFlag(" FALSE ")).toBe(false);
  });

  it("treats garbage as enabled", () => {
    expect(parseSummaryFlag("true")).toBe(true);
    expect(parseSummaryFlag(" TRUE ")).toBe(true);
    expect(parseSummaryFlag("yes")).toBe(true);
    expect(parseSummaryFlag("0")).toBe(true);
  });
});
