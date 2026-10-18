#!/usr/bin/env node
// Test-only stub LSP server: answers definition with a fixed location and
// publishes one fake diagnostic (naming the file) on didOpen. Exits on the
// shutdown request, the `exit` notification, or stdio close — whichever
// comes first — but ignores SIGTERM on purpose and keeps the event loop
// alive past stdio teardown (ref'd interval), so the test proves teardown
// through the protocol path rather than the signal path. Speaks LSP over stdio with Content-Length framing.
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
  // Cooperative shutdown: receipt of the shutdown request or the exit
  // notification ends the process synchronously — no further scheduling,
  // so no post-receipt race with stdio teardown or signals can strand it.
  // (The stock client sends shutdown, then exit, then SIGTERM; the stub
  // ignores SIGTERM, so the protocol path is what the lifecycle test
  // exercises.) Responding is pointless: stock never reads the reply.
  if (message.method === "shutdown" || message.method === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
process.stdin.resume();
// Belt and braces: if the client tears down stdio without the protocol
// goodbye (best-effort writes), the closed pipe ends the stub instead of
// stranding it on its keep-alive interval.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
