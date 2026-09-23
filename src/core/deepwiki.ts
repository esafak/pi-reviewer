import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);
const DEEPWIKI_ENDPOINT = "https://mcp.deepwiki.com/mcp";
const MAX_CONTEXT_LENGTH = 32_000;

export function extractPublicGitHubRepo(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match = normalized.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i);
  return match?.[1];
}

export async function resolvePublicGitHubRepo(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 3_000,
    });
    return extractPublicGitHubRepo(stdout);
  } catch {
    return undefined;
  }
}

export function parseDeepWikiResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const shaped = result as { isError?: unknown; structuredContent?: unknown; content?: unknown };
  if (shaped.isError === true) throw new Error("DeepWiki question tool returned an error");
  if (
    shaped.structuredContent &&
    typeof shaped.structuredContent === "object" &&
    "result" in shaped.structuredContent &&
    typeof shaped.structuredContent.result === "string"
  ) {
    return shaped.structuredContent.result.slice(0, MAX_CONTEXT_LENGTH);
  }
  const content = shaped.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        !!item &&
        typeof item === "object" &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n\n")
    .slice(0, MAX_CONTEXT_LENGTH);
}

export async function fetchDeepWikiContext(repo: string): Promise<string> {
  const client = new Client({ name: "pi-reviewer", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(DEEPWIKI_ENDPOINT), {
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const askTool = tools.tools.find((tool) =>
      ["ask_wiki_question", "ask_question"].includes(tool.name),
    );
    if (!askTool) throw new Error("DeepWiki MCP server does not expose a question tool");
    const result = await client.callTool({
      name: askTool.name,
      arguments: {
        repoName: repo,
        question:
          "Summarize the repository architecture, key modules, and documented conventions relevant to reviewing a code change. Cite the documentation topics or files used.",
      },
    });
    const text = parseDeepWikiResult(result);
    if (!text.trim()) throw new Error("DeepWiki returned no documentation context");
    return `Repository: https://github.com/${repo}\nSource: https://deepwiki.com/${repo}\n\n${text}`.slice(
      0,
      MAX_CONTEXT_LENGTH,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function loadDeepWikiContext(cwd: string): Promise<string> {
  const repo = await resolvePublicGitHubRepo(cwd);
  if (!repo) throw new Error("Could not resolve a public GitHub repository from origin remote");
  return fetchDeepWikiContext(repo);
}
