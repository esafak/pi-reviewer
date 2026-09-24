import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  loadMcpConfigFromBase,
  parseMcpConfigJson,
  resolveDefaultBranchSha,
  validateMcpConfig,
} from "../../src/ci/mcp-config.js";

const tempDirs: string[] = [];

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "pi-reviewer-mcp-config-test-"));
  tempDirs.push(repo);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  return repo;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP CI config", () => {
  it("accepts server definitions and env references without resolving credentials", () => {
    const config = parseMcpConfigJson(
      JSON.stringify({
        mcpServers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            auth: "bearer",
            bearerTokenEnv: "DOCS_TOKEN",
          },
        },
      }),
    );
    expect(config.mcpServers.docs.bearerTokenEnv).toBe("DOCS_TOKEN");
    expect(
      validateMcpConfig({
        mcpServers: { docs: { url: "https://mcp.example.com/mcp", bearerToken: "${DOCS_TOKEN}" } },
      }).mcpServers.docs.bearerToken,
    ).toBe("${DOCS_TOKEN}");
    expect(
      validateMcpConfig({
        mcpServers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer ${DOCS_TOKEN}", "X-API-Key": "$env:DOCS_KEY" },
          },
        },
      }).mcpServers.docs.headers,
    ).toEqual({ Authorization: "Bearer ${DOCS_TOKEN}", "X-API-Key": "$env:DOCS_KEY" });
  });

  it.each([
    ["not JSON", "mcp-config-file must be valid JSON"],
    ["{}", "mcp-config-file must contain an mcpServers object"],
    ['{"mcpServers":{}}', "mcp-config-file must configure at least one MCP server"],
  ])("rejects invalid config without echoing contents", (text, expected) => {
    expect(() => parseMcpConfigJson(text, "mcp-config-file")).toThrow(expected);
  });

  it.each(["/absolute.json", "../outside.json", "nested/../../outside.json", "a\\b.json"])(
    "rejects unsafe repository paths: %s",
    (filePath) => {
      expect(() => loadMcpConfigFromBase("/repo", "a".repeat(40), filePath)).toThrow(
        "mcp-config-file must be a normalized repository-relative path",
      );
    },
  );

  it("loads the config from the trusted base SHA rather than the working tree", async () => {
    const repo = await makeGitRepo();
    await mkdir(path.join(repo, ".github"), { recursive: true });
    const configPath = path.join(repo, ".github", "mcp.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { trusted: { url: "https://trusted.example/mcp" } } }),
    );
    execFileSync("git", ["-C", repo, "add", ".github/mcp.json"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "base config",
    ]);
    const baseSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { attacker: { command: "not-run" } } }),
    );
    const config = loadMcpConfigFromBase(repo, baseSha, ".github/mcp.json");

    expect(config?.mcpServers).toEqual({ trusted: { url: "https://trusted.example/mcp" } });
  });

  it("resolves the selected config revision from the remote default branch", async () => {
    const repo = await makeGitRepo();
    await writeFile(path.join(repo, "README.md"), "trusted default branch\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "default branch",
    ]);
    const trustedSha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const bare = path.join(path.dirname(repo), `${path.basename(repo)}-origin.git`);
    execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
    tempDirs.push(bare);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", bare]);

    expect(resolveDefaultBranchSha(repo, "main")).toBe(trustedSha);
  });

  it("rejects config files that do not exist at the trusted base revision", async () => {
    const repo = await makeGitRepo();
    await writeFile(path.join(repo, "README.md"), "test\n");
    execFileSync("git", ["-C", repo, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "initial",
    ]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(() => loadMcpConfigFromBase(repo, sha, "missing.json")).toThrow(
      "Could not load mcp-config-file from the trusted default branch revision",
    );
  });

  it("rejects oversized trusted config blobs without reading unbounded data", async () => {
    const repo = await makeGitRepo();
    await writeFile(
      path.join(repo, "mcp.json"),
      JSON.stringify({ mcpServers: { docs: { note: "x".repeat(270 * 1024) } } }),
    );
    execFileSync("git", ["-C", repo, "add", "mcp.json"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "large config",
    ]);
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    expect(() => loadMcpConfigFromBase(repo, sha, "mcp.json")).toThrow(
      "mcp-config-file exceeds the 256 KiB limit",
    );
  });

  it("rejects invalid server/settings shapes", () => {
    expect(() => validateMcpConfig({ mcpServers: { docs: "invalid" } })).toThrow(
      "MCP config contains an invalid MCP server definition",
    );
    expect(() => validateMcpConfig({ mcpServers: { docs: {} }, settings: [] })).toThrow(
      "MCP config settings must be an object",
    );
    expect(() =>
      validateMcpConfig({ mcpServers: { docs: {} }, claudePlugins: [{ path: "./plugin" }] }),
    ).toThrow('MCP config contains unsupported config key "claudePlugins"');
    expect(() =>
      validateMcpConfig({
        mcpServers: { docs: {} },
        settings: { agentPluginPaths: ["./plugins"] },
      }),
    ).toThrow("MCP config does not support settings.agentPluginPaths in CI");
    expect(() =>
      validateMcpConfig({
        mcpServers: { auth: { url: "https://mcp.example/mcp", auth: "oauth" } },
      }),
    ).toThrow("MCP config does not support OAuth servers in unattended CI");
    expect(() =>
      validateMcpConfig({
        mcpServers: { docs: { url: "https://mcp.example/mcp", bearerToken: "literal-secret" } },
      }),
    ).toThrow("MCP config bearerToken must reference an environment variable");
    expect(() =>
      validateMcpConfig({
        mcpServers: {
          docs: { url: "https://mcp.example/mcp", headers: { Authorization: "Bearer literal" } },
        },
      }),
    ).toThrow(
      'MCP config credential header "Authorization" must reference an environment variable',
    );
    expect(() =>
      validateMcpConfig({
        mcpServers: { docs: { url: "https://mcp.example/mcp", bearerTokenEnv: "DOCS-TOKEN" } },
      }),
    ).toThrow("MCP config bearerTokenEnv must be an environment variable name");
    expect(() =>
      validateMcpConfig({
        mcpServers: {
          local: { command: "node", env: { API_TOKEN: "literal-secret" } },
        },
      }),
    ).toThrow('MCP config credential env value "API_TOKEN" must reference an environment variable');
    expect(() =>
      validateMcpConfig({
        mcpServers: { docs: { url: "https://user:secret@mcp.example/mcp" } },
      }),
    ).toThrow("MCP config server URL must not contain embedded credentials");
  });
});
