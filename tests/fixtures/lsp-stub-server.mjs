#!/usr/bin/env node
// Test-only stub LSP server: answers definition with a fixed location and
// publishes one fake diagnostic (naming the file) on didOpen. Records every
// shutdown trigger in receipt order to a marker file (shutdown request,
// exit notification, stdio close) and terminates on the exit notification;
// SIGTERM stays ignored and the event loop stays pinned, so the test can
// prove the full protocol shutdown sequence rather than mere death. Speaks LSP over stdio with Content-Length framing.
// Usage: node lsp-stub-server.mjs [--hang]
// --hang consumes input without ever responding (startup-timeout testing).
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
const HANG = process.argv.includes("--hang");
const NO_PUSH = process.argv.includes("--no-push");
const MESSAGE = process.env.STUB_DIAG_MESSAGE;
if (process.env.STUB_MARKER_FILE) {
  writeFileSync(process.env.STUB_MARKER_FILE, "spawned\n");
}

let buffer = Buffer.alloc(0);

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function pump() {
  for (;;) {
    const text = buffer.toString("utf8");
    const header = text.match(/Content-Length: (\d+)\r\n\r\n/);
    if (!header) return;
    const length = Number(header[1]);
    const start = header[0].length;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    handle(message);
  }
}

function recordTrigger(name) {
  // Ordered receipt log (append-only): the test asserts shutdown-before-exit
  // ordering, so triggers must never overwrite each other. Sync fs write —
  // the marker is the delivery proof; process lifetime is asserted
  // separately by the test's reaping check.
  if (process.env.STUB_SHUTDOWN_MARKER_FILE) {
    writeFileSync(process.env.STUB_SHUTDOWN_MARKER_FILE, `${name}\n`, { flag: "a" });
  }
}

function handle(message) {
  if (HANG) return;
  if (message.id !== undefined) {
    if (message.method === "textDocument/definition") {
      // Deterministic navigation target: echo the requested document with
      // a fixed range so tests can assert the full definition round trip.
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [
          {
            uri: message.params.textDocument.uri,
            range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } },
          },
        ],
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "initialize" ? { capabilities: {} } : null,
      });
    }
  }
  if (message.method === "textDocument/didOpen" && !NO_PUSH) {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: message.params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: MESSAGE ?? `stub diagnostic for ${message.params.textDocument.uri}`,
          },
        ],
      },
    });
  }
  // Cooperative shutdown: record each trigger in receipt order (append-only;
  // the test asserts shutdown-before-exit). Answer the shutdown request but
  // do NOT terminate on it; terminate on the exit notification, deferred a
  // macrotask so buffered pipe writes get a chance to flush. Stock never
  // reads the shutdown reply (best-effort write, no response handling), so
  // no write-drain is needed for correctness — the sync marker file is the
  // delivery proof and process lifetime is asserted separately.
  if (message.method === "shutdown") {
    recordTrigger("shutdown");
    return;
  }
  if (message.method === "exit") {
    recordTrigger("exit");
    setImmediate(() => process.exit(0));
    return;
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
process.stdin.resume();
// Fallback: if the client tears down stdio without the protocol goodbye
// (best-effort writes), the closed pipe ends the stub instead of stranding
// it on its keep-alive interval. Recorded like any other trigger, so a run
// that only ever sees this still produces a diagnosable marker.
process.stdin.on("end", () => {
  recordTrigger("stdin-close");
  setImmediate(() => process.exit(0));
});
process.stdin.on("close", () => {
  recordTrigger("stdin-close");
  setImmediate(() => process.exit(0));
});
