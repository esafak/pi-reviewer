import { describe, expect, it, vi } from "vite-plus/test";

// The 256 KiB guard in `loadMcpConfigFromBase` sits behind a real `git show`.
// Mocking the subprocess keeps the guard covered without spawning git or
// pushing a blob through a `maxBuffer` that is sensitive to machine
// contention — the flake that retired the integration version of this test.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { loadMcpConfigFromBase } from "../../src/ci/mcp-config.js";

const execFileSyncMock = vi.mocked(execFileSync);

const SHA = "a".repeat(40);
const LIMIT_ERROR = "mcp-config-file exceeds the 256 KiB limit";
const LOAD_ERROR = "Could not load mcp-config-file from the trusted default branch revision";

/** Runs the loader and returns the message it threw, failing if it did not throw. */
function loadError(): string {
  try {
    loadMcpConfigFromBase("/repo", SHA, "mcp.json");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected loadMcpConfigFromBase to throw");
}

describe("loadMcpConfigFromBase — size guard", () => {
  // Each case installs its own implementation before acting and none asserts
  // call counts, so there is no per-test history reset to do here.
  it("maps a maxBuffer overflow to the size-limit error", () => {
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync git ENOBUFS"), { code: "ENOBUFS" });
    });
    expect(loadError()).toBe(LIMIT_ERROR);
  });

  it("rejects a blob larger than the limit that never overflows the buffer", () => {
    execFileSyncMock.mockReturnValue("x".repeat(256 * 1024 + 1) as never);
    expect(loadError()).toBe(LIMIT_ERROR);
  });

  it("reports a non-overflow subprocess failure as a load failure", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not a git repository");
    });
    expect(loadError()).toBe(LOAD_ERROR);
  });

  it("parses a config that is within the limit", () => {
    execFileSyncMock.mockReturnValue(
      JSON.stringify({ mcpServers: { docs: { url: "https://mcp.example.com/mcp" } } }) as never,
    );
    expect(loadMcpConfigFromBase("/repo", SHA, "mcp.json")?.mcpServers.docs.url).toBe(
      "https://mcp.example.com/mcp",
    );
  });
});
