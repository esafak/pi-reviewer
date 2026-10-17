import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EventStream, getCurrentTools, Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { createReviewTool } from "../../src/core/review-tool.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeSession(systemPrompt: string, customTools: never[]) {
  const packageName = "pi-mcp-adapter";
  const { createMcpAdapter } = (await import(packageName)) as {
    createMcpAdapter(options: {
      config: { mcpServers: Record<string, Record<string, unknown>> };
    }): (pi: unknown) => void;
  };
  const cwd = process.cwd();
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-mcp-session-test-"));
  tempDirs.push(agentDir);
  const adapterFactory = createMcpAdapter({
    config: {
      mcpServers: { docs: { url: "https://mcp.example.test/mcp", auth: false } },
    },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    extensionFactories: [adapterFactory as never],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
    tools: [
      ...new Set([
        "read",
        "grep",
        "find",
        "mcp",
        ...customTools.map((tool) => (tool as { name: string }).name),
      ]),
    ],
    customTools,
  });
  return session;
}

describe("MCP session host integration", () => {
  it("exposes MCP and reviewer tools to the underlying agent's model context", async () => {
    const { tool: reviewTool } = createReviewTool();
    const session = await makeSession("MCP session integration test", [reviewTool as never]);

    try {
      const mcpToolNames = new Set(
        session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
      );
      expect(mcpToolNames).toContain("mcp");
      session.setActiveToolsByName([
        ...new Set(["read", "grep", "find", ...mcpToolNames, reviewTool.name]),
      ]);
      const model = getBuiltinModel("anthropic" as never, "claude-opus-4-6" as never)!;
      session.agent.state.model = model as never;
      // The system prompt is seeded via the resource loader above;
      // state.systemPrompt replays the transcript and is read-only.
      const requests: string[][] = [];
      session.agent.streamFunction = ((_model, context) => {
        requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
        const message = {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop" as const,
          timestamp: Date.now(),
        };
        const stream = new EventStream(
          (event) => event.type === "done" || event.type === "error",
          (event) => (event.type === "done" ? event.message : event.error),
        );
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      }) as never;
      session.agent.getApiKey = () => "test-key";

      await session.agent.prompt("Run a CI review tool contract proof.");

      expect(requests[0]).toContain("mcp");
      expect(requests[0]).toContain("submit_review");
      expect(session.agent.state.tools.map((tool) => tool.name)).toContain("submit_review");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });

  it("keeps reviewer tools registered across tool-calling turns", async () => {
    const { tool: reviewTool } = createReviewTool();
    const dummyTool = {
      name: "dummy_ping",
      label: "dummy_ping",
      description: "test ping",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: "pong" }] };
      },
    };
    const session = await makeSession("MCP multi-turn persistence test", [
      reviewTool as never,
      dummyTool as never,
    ]);

    try {
      const mcpToolNames = new Set(
        session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
      );
      session.setActiveToolsByName([
        ...new Set(["read", "grep", "find", ...mcpToolNames, reviewTool.name, dummyTool.name]),
      ]);
      const model = getBuiltinModel("anthropic" as never, "claude-opus-4-6" as never)!;
      session.agent.state.model = model as never;
      const requests: string[][] = [];
      let calls = 0;
      session.agent.streamFunction = ((_model, context) => {
        requests.push(getCurrentTools(context.messages).map((tool) => tool.name));
        calls += 1;
        const content =
          calls === 1
            ? [{ type: "toolCall" as const, id: "call-1", name: "dummy_ping", arguments: {} }]
            : [{ type: "text" as const, text: "done" }];
        const message = {
          role: "assistant" as const,
          content: content as never,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: (calls === 1 ? "toolUse" : "stop") as never,
          timestamp: Date.now(),
        };
        const stream = new EventStream(
          (event) => event.type === "done" || event.type === "error",
          (event) => (event.type === "done" ? event.message : event.error),
        );
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: calls === 1 ? "tool_calls" : "stop",
          message,
        });
        return stream;
      }) as never;
      session.agent.getApiKey = () => "test-key";

      await session.agent.prompt("Run a multi-turn persistence proof.");

      expect(requests.length).toBeGreaterThanOrEqual(2);
      for (const names of requests) {
        expect(names).toContain("submit_review");
        expect(names).toContain("dummy_ping");
      }
      expect(session.agent.state.tools.map((tool) => tool.name)).toContain("submit_review");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
});
