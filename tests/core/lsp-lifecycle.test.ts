import { execFileSync, execSync } from "node:child_process";
import { chmodSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { withIsolatedAgentDir, writeTrustedLspConfig } from "../../src/core/lsp/config.js";
import { loadPiLspExtension } from "../../src/core/lsp/extension.js";

const STUB_SOURCE = path.resolve("tests/fixtures/lsp-stub-server.mjs");

function stubRunning(stubPath: string): boolean {
  try {
    execSync(`pgrep -f ${stubPath}`, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function waitForExit(stubPath: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!stubRunning(stubPath)) return true;
    if (Date.now() > deadline) return false;
    execFileSync("sleep", ["0.2"]);
  }
}

/**
 * Handler resolution does not imply the child has processed the messages:
 * poll the ordered marker file with a bounded deadline instead of reading
 * it once. Returns whatever was recorded (possibly empty) so failures show
 * the actual trigger sequence.
 */
async function waitForMarker(markerPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = "";
    try {
      text = readFileSync(markerPath, "utf8");
    } catch {
      // Not written yet.
    }
    if (text.includes("shutdown\nexit") || Date.now() > deadline) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("pi-lsp stock lifecycle", () => {
  it("resolves definitions and reads navigation-warmed diagnostics, and tears down the server on session shutdown", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-lifecycle-"));
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-agent-"));
    // Hoisted for the cleanup boundary below: the outer finally must reach
    // the stub and the session handlers no matter which assertion failed.
    // Unique stub copy per run so pgrep cannot match another run.
    const stubPath = path.join(dir, "stub-server.mjs");
    const handlers = new Map<string, ((...args: never[]) => Promise<unknown>)[]>();
    let shutdownAttempted = false;
    try {
      await writeFile(stubPath, await readFile(STUB_SOURCE, "utf8"), { mode: 0o755 });
      chmodSync(stubPath, 0o755);
      await writeFile(path.join(dir, "lsp-stub-root"), "");
      const mainFile = path.join(dir, "main.stub");
      await writeFile(mainFile, "hello\n");

      const tools = new Map<string, { execute: (...args: never[]) => Promise<unknown> }>();
      await withIsolatedAgentDir(agentDir, async () => {
        await writeTrustedLspConfig(agentDir, [
          {
            id: "stub",
            bin: process.execPath,
            args: [stubPath],
            include: ["**/*.stub"],
            rootMarkers: ["lsp-stub-root"],
            languageIdByExtension: { ".stub": "stub" },
            startupTimeoutMs: 15_000,
            diagnosticsWaitMs: 500,
            // Spawn-time env (not process.env mutation: the server inherits
            // the environment at spawn, so the marker path must travel in
            // the server entry itself).
            env: { STUB_SHUTDOWN_MARKER_FILE: path.join(dir, "shutdown-sequence") },
          },
        ]);
        const extension = await loadPiLspExtension();
        extension({
          registerMessageRenderer: () => {},
          registerTool: (def: { name: string }) => {
            tools.set(def.name, def as never);
          },
          on: (event: string, fn: (...args: never[]) => Promise<unknown>) => {
            const list = handlers.get(event) ?? [];
            list.push(fn);
            handlers.set(event, list);
          },
          sendMessage: () => {},
        } as never);
        const ctx = { cwd: dir, hasUI: false, signal: undefined } as unknown as ExtensionContext;
        const hover = tools.get("lsp_hover");
        const diagnostics = tools.get("lsp_diagnostics");

        // Hover opens the document read-only (absolute path as before).
        // The stub publishes diagnostics on didOpen, warming pi-lsp's
        // cache — a later lsp_diagnostics read then returns them with
        // stock pi-lsp, no collect patch needed (agent follow-up path).
        expect(hover).toBeDefined();
        await hover?.execute(
          "t1",
          { path: mainFile, line: 0, character: 0 },
          undefined,
          undefined,
          ctx,
        );

        // Definition resolves through the real tool against the stub's
        // fixed target: the requested document URI at line 3.
        const definition = tools.get("lsp_definition");
        expect(definition).toBeDefined();
        const defResult = (await definition?.execute(
          "t3",
          { path: mainFile, line: 0, character: 1 },
          undefined,
          undefined,
          ctx,
        )) as { content: { text: string }[] };
        const defText = defResult.content[0]?.text ?? "";
        expect(defText).toContain("main.stub");
        expect(defText).toContain('"line": 3');

        // Absolute path after an open document: the cached read path.
        const result = (await diagnostics?.execute(
          "t2",
          { path: mainFile },
          undefined,
          undefined,
          ctx,
        )) as { content: { text: string }[] };
        expect(result.content[0]?.text).toContain("stub diagnostic");
        expect(stubRunning(stubPath)).toBe(true);

        // Shutdown must deliver the protocol goodbye in order: the stub
        // appends each trigger to the marker file, and the test polls for
        // the shutdown-then-exit prefix (handler resolution does not imply
        // the child has processed the messages). A bounded reaping check
        // follows, so the no-orphans property is still asserted — the marker
        // only upgrades the failure from silent to diagnosable.
        for (const fn of handlers.get("session_shutdown") ?? []) await fn();
        shutdownAttempted = true;
        const sequence = await waitForMarker(path.join(dir, "shutdown-sequence"), 10_000);
        expect(sequence).toMatch(/^shutdown\nexit/);
        expect(waitForExit(stubPath, 12_000)).toBe(true);
      });
    } finally {
      // Guarantee: a graceful shutdown is always attempted, even when an
      // earlier assertion failed — but it must never mask that failure. The
      // hard-kill backstop then ensures the exact per-run stub copy cannot
      // leak past this test whatever happened above.
      if (!shutdownAttempted) {
        try {
          for (const fn of handlers.get("session_shutdown") ?? []) await fn();
        } catch {
          // Original failure (if any) takes precedence.
        }
      }
      if (stubRunning(stubPath)) {
        try {
          execSync(`pkill -9 -f ${stubPath}`, { stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
      await rm(dir, { recursive: true, force: true });
      await rm(agentDir, { recursive: true, force: true });
    }
  }, 45_000);
});
