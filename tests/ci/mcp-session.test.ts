import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createReadOnlyTools,
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

describe("MCP session host integration", () => {
  it("exposes MCP and reviewer tools to the underlying agent's model context", async () => {
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
      systemPrompt: "MCP session integration test",
      extensionFactories: [adapterFactory as never],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
      tools: ["read", "grep", "find", "mcp"],
    });

    try {
      const mcpToolNames = new Set(
        session.extensionRunner.getAllRegisteredTools().map(({ definition }) => definition.name),
      );
      expect(mcpToolNames).toContain("mcp");
      session.setActiveToolsByName([
        ...new Set(["read", "grep", "find", ...mcpToolNames, createReviewTool().tool.name]),
      ]);
      const reviewTool = createReviewTool().tool;
      session.agent.state.tools = [
        ...createReadOnlyTools(cwd),
        ...session.agent.state.tools.filter((tool) => mcpToolNames.has(tool.name)),
        reviewTool,
      ];
      const model = getBuiltinModel("anthropic" as never, "claude-opus-4-6" as never)!;
      session.agent.state.model = model as never;
      session.agent.state.systemPrompt = "MCP session integration test";
      let modelToolNames: string[] = [];
      session.agent.streamFunction = ((_model, context) => {
        modelToolNames = (context.tools ?? []).map((tool) => tool.name);
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

      expect(modelToolNames).toContain("mcp");
      expect(modelToolNames).toContain("submit_review");
      expect(session.agent.state.tools.map((tool) => tool.name)).toContain("submit_review");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  });
});
