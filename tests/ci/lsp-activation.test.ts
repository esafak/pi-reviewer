import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { LSP_TOOL_NAMES } from "../../src/ci/tool-names.js";

/**
 * Proves against a real SDK session (no mocks, no model calls) that the
 * explicit `tools` allowlist gates extension-tool activation: `lsp_*`
 * tools register and activate only when named in the session tools list.
 * This is the regression test for the CI failure where the allowlist
 * omitted them and the review died with "LSP tools were not enabled".
 */
const lspExtensionFactory: ExtensionFactory = (pi) => {
  for (const name of LSP_TOOL_NAMES) {
    pi.registerTool({
      name,
      label: name,
      description: `test ${name}`,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    });
  }
};

async function realSession(cwd: string, agentDir: string, tools: string[]) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "test",
    extensionFactories: [lspExtensionFactory],
  });
  await loader.reload();
  return createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    tools,
    customTools: [],
  });
}

describe("lsp tool allowlist activation (real session)", () => {
  it("activates registered lsp tools named in the session tools list", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-reviewer-allowlist-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-allowlist-agent-"));
    try {
      const { session } = await realSession(cwd, agentDir, ["read", ...LSP_TOOL_NAMES]);
      try {
        const registered = session.extensionRunner
          .getAllRegisteredTools()
          .map((tool) => tool.definition.name);
        expect(registered).toEqual(expect.arrayContaining([...LSP_TOOL_NAMES]));
        session.setActiveToolsByName([...LSP_TOOL_NAMES]);
        const active = session.agent.state.tools.map((tool) => tool.name);
        expect(active).toEqual(expect.arrayContaining([...LSP_TOOL_NAMES]));
      } finally {
        session.dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves lsp tools out when the session tools list omits them", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-reviewer-allowlist-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-allowlist-agent-"));
    try {
      const { session } = await realSession(cwd, agentDir, ["read"]);
      try {
        session.setActiveToolsByName([...LSP_TOOL_NAMES]);
        const active = session.agent.state.tools.map((tool) => tool.name);
        for (const name of LSP_TOOL_NAMES) {
          expect(active).not.toContain(name);
        }
      } finally {
        session.dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
