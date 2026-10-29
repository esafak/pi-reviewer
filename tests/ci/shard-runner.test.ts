import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearTimeout as clearNodeTimeout, setTimeout as scheduleNodeTimeout } from "node:timers";

// Same single-signature pinning as src/ci/shard-fanout.ts: the stub must
// satisfy the NodeJS.Timeout contract under any @types/node version.
const scheduleRealForTest: (callback: () => void, ms: number) => NodeJS.Timeout =
  scheduleNodeTimeout;
const cancelRealForTest: (handle: NodeJS.Timeout) => void = clearNodeTimeout;
import { describe, expect, it } from "vite-plus/test";
import { runShardChildren, shardEntryPoint } from "../../src/ci/shard-fanout.js";
import { toShardEnvelope } from "../../src/ci/shard-runner.js";
import type { ShardRequest } from "../../src/ci/shard-protocol.js";

const request: ShardRequest = {
  index: 1,
  total: 1,
  cwd: process.cwd(),
  shard: { diff: "diff", files: ["a.ts"] },
  systemPrompt: "system",
  userPrompt: "user",
  model: "test/model",
  thinkingLevel: "off",
  minSeverity: "INFO",
  debug: false,
  tools: { lspEntries: [], lspEnabled: false, citationOffset: 1 },
  tracing: null,
};

describe("shardEntryPoint", () => {
  it("resolves the tsx-loaded entrypoint without URL escaping", () => {
    // The child is spawned by path: any %-escaping (URL.pathname) breaks
    // spawn with ENOENT on runners whose paths contain spaces or unicode.
    // (shard-run.js exists only under tsx loader resolution; the .ts source
    // is what sits on disk.)
    const entry = shardEntryPoint();
    expect(entry.endsWith("shard-run.js")).toBe(true);
    expect(entry).not.toContain("%");
  });
});

describe("runShardChildren", () => {
  it("classifies invalid JSON envelopes as shard_failed", async () => {
    const spawn = (async (...args: unknown[]) => {
      const argv = args[1];
      if (!Array.isArray(argv)) throw new Error("missing child args");
      const output = argv.at(-1);
      if (typeof output !== "string") throw new Error("missing output path");
      await writeFile(output, "not-json");
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 123;
      setTimeout(() => child.emit("close", 0));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runShardChildren([request], { spawn, entryPoint: "stub.js" });
    expect(outcome.skipped).toEqual([{ path: "a.ts", reason: "shard_failed", cap: 4 }]);
    expect(outcome.envelopes).toEqual([]);
  });

  it("classifies a non-zero child exit as shard_failed even if output exists", async () => {
    const spawn = (async (...args: unknown[]) => {
      const argv = args[1];
      if (!Array.isArray(argv)) throw new Error("missing child args");
      const output = argv.at(-1);
      if (typeof output !== "string") throw new Error("missing output path");
      await writeFile(output, JSON.stringify({ index: 1, status: "ok", decision: "none" }));
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 124;
      setTimeout(() => child.emit("close", 1));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runShardChildren([request], { spawn, entryPoint: "stub.js" });
    expect(outcome.skipped).toEqual([{ path: "a.ts", reason: "shard_failed", cap: 4 }]);
  });

  it("collects envelopes in index order and counts runs", async () => {
    const makeRequest = (index: number): ShardRequest => ({ ...request, index, total: 2 });
    const spawn = (async (...args: unknown[]) => {
      const argv = args[1];
      if (!Array.isArray(argv)) throw new Error("missing child args");
      const output = argv.at(-1);
      if (typeof output !== "string") throw new Error("missing output path");
      const input = argv.at(-2);
      if (typeof input !== "string") throw new Error("missing input path");
      const parsed: unknown = JSON.parse(await readFile(input, "utf8"));
      if (!parsed || typeof parsed !== "object" || !("index" in parsed))
        throw new Error("bad input");
      await writeFile(
        output,
        JSON.stringify({ index: parsed.index, status: "ok", decision: "none" }),
      );
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 200 + Number(parsed.index);
      setTimeout(() => child.emit("close", 0));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runShardChildren([makeRequest(2), makeRequest(1)], {
      spawn,
      entryPoint: "stub.js",
    });
    expect(outcome.envelopes.map((envelope) => envelope.index)).toEqual([1, 2]);
    expect(outcome.runs).toBe(2);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.abandoned).toBe(0);
  });

  it("maps a missing envelope file to shard_failed", async () => {
    const spawn = (async (..._args: unknown[]) => {
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 125;
      setTimeout(() => child.emit("close", 0));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runShardChildren([request], { spawn, entryPoint: "stub.js" });
    expect(outcome.skipped).toEqual([{ path: "a.ts", reason: "shard_failed", cap: 4 }]);
    expect(outcome.envelopes).toEqual([]);
  });

  it("passes the provided environment through to children", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const spawn = (async (...args: unknown[]) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      seenEnv = options?.env;
      const argv = args[1];
      if (!Array.isArray(argv)) throw new Error("missing child args");
      const output = argv.at(-1);
      if (typeof output !== "string") throw new Error("missing output path");
      await writeFile(output, JSON.stringify({ index: 1, status: "ok", decision: "none" }));
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 126;
      setTimeout(() => child.emit("close", 0));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runShardChildren([request], {
      spawn,
      entryPoint: "stub.js",
      env: { ...process.env, PI_API_KEY: "test-key" },
    });
    expect(seenEnv?.PI_API_KEY).toBe("test-key");
    expect(outcome.envelopes).toHaveLength(1);
  });

  it("cuts the barrier and kills the detached shard process group", async () => {
    const pidFile = path.join(tmpdir(), `shard-grandchild-${process.pid}.pid`);
    let cut: (() => void) | undefined;
    let firstTimer = true;
    const clock = {
      now: () => 10,
      setTimeout: (callback: () => void, _ms: number): NodeJS.Timeout => {
        if (firstTimer) {
          firstTimer = false;
          cut = callback;
          return scheduleRealForTest(() => {}, 60_000);
        }
        return scheduleRealForTest(callback, 20);
      },
      clearTimeout: (handle: NodeJS.Timeout) => cancelRealForTest(handle),
    };
    const spawn = ((
      _command: string,
      _args: readonly string[],
      options: Parameters<typeof realSpawn>[2],
    ) => {
      const script = `const fs=require('node:fs');const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
      const child = realSpawn(process.execPath, ["-e", script], options);
      // Cut only after the grandchild exists: a fixed delay races the real
      // node startup under load (ENOENT on the pid file).
      const waitForPidFile = async () => {
        const deadline = Date.now() + 10_000;
        for (;;) {
          try {
            await readFile(pidFile, "utf8");
            return;
          } catch {
            if (Date.now() > deadline) throw new Error("grandchild never wrote its pid file");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      };
      void waitForPidFile().then(() => cut?.());
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runShardChildren([request], {
      spawn,
      clock,
      startedAt: 10,
      entryPoint: "unused",
    });
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    expect(outcome.skipped[0]?.reason).toBe("shard_limit");
    expect(outcome.abandoned).toBe(1);
    // Poll for the group kill: SIGTERM lands at the barrier, SIGKILL after
    // the grace timer, both ahead of the test's read.
    const killDeadline = Date.now() + 10_000;
    for (;;) {
      try {
        process.kill(grandchildPid, 0);
      } catch {
        break;
      }
      if (Date.now() > killDeadline) throw new Error("grandchild survived the group kill");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await rm(pidFile, { force: true });
  });
});

describe("toShardEnvelope", () => {
  it("maps decisions, evidence, and verdicts; required failure becomes an error", () => {
    const base = {
      evidence: undefined,
      mcpFailures: new Map(),
      requiredSearchFailed: false,
    } as const;
    expect(
      toShardEnvelope(2, {
        ...base,
        decision: {
          action: "none",
          result: {
            findings: [],
            finding_updates: [],
            digest: [{ file: "b.ts", what: "clean", risks: [] }],
          },
        },
      }),
    ).toEqual({
      index: 2,
      status: "ok",
      decision: "none",
      result: {
        findings: [],
        finding_updates: [],
        digest: [{ file: "b.ts", what: "clean", risks: [] }],
      },
    });
    expect(
      toShardEnvelope(1, {
        ...base,
        decision: {
          action: "review",
          result: {
            findings: [
              {
                file: "a.ts",
                line: 1,
                side: "RIGHT" as const,
                severity: "WARN" as const,
                body: "A meaningful finding",
              },
            ],
            finding_updates: [],
            digest: [{ file: "a.ts", what: "covers a", risks: [] }],
          },
        },
        evidence: [
          {
            id: "web:1",
            kind: "search-result",
            provider: "duckduckgo",
            title: "t",
            url: "https://example.com",
            queryHash: "h",
            rank: 1,
            retrievedAt: "now",
          },
        ],
      }),
    ).toEqual({
      index: 1,
      status: "ok",
      decision: "review",
      result: {
        findings: [
          { file: "a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "A meaningful finding" },
        ],
        finding_updates: [],
        digest: [{ file: "a.ts", what: "covers a", risks: [] }],
      },
      evidence: [
        {
          id: "web:1",
          kind: "search-result",
          provider: "duckduckgo",
          title: "t",
          url: "https://example.com",
          queryHash: "h",
          rank: 1,
          retrievedAt: "now",
        },
      ],
    });
    expect(
      toShardEnvelope(3, { ...base, decision: { action: "none" }, requiredSearchFailed: true }),
    ).toMatchObject({
      index: 3,
      status: "error",
      decision: "none",
    });
  });
});
