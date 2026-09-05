import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReviewResult } from "../../../src/core/output.js";
import { buildHTML } from "../../../src/core/ui/template.js";
import { startUIServer, type UIAction } from "../../../src/core/ui/server/index.js";
import { compileRoute, matchPath } from "../../../src/core/ui/server/routes.js";
import { applyConfigPatch } from "../../../src/core/config.js";

vi.mock("node:child_process", () => ({ exec: vi.fn() }));

vi.mock("../../../src/core/config.js", () => ({
  readTheme: vi.fn().mockReturnValue("dark"),
  readViewMode: vi.fn().mockReturnValue("split"),
  readAutoCollapseViewed: vi.fn().mockReturnValue(false),
  applyConfigPatch: vi.fn(),
  readVerbose: vi.fn().mockReturnValue(false),
  readMinSeverity: vi.fn().mockReturnValue("INFO"),
  readModel: vi.fn().mockReturnValue(undefined),
  readThinking: vi.fn().mockReturnValue(undefined),
  readDefaultBranch: vi.fn().mockReturnValue(undefined),
}));

const applyConfigPatchMock = vi.mocked(applyConfigPatch);

const RESULT: ReviewResult = {
  summary: "Looks good overall.",
  comments: [
    { file: "src/foo.ts", line: 10, side: "RIGHT", severity: "WARN", body: "🟡 use const" },
    { file: "src/foo.ts", line: 4, side: "LEFT", severity: "INFO", body: "🔵 removed import" },
  ],
};

const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -3,6 +3,6 @@
 const a = 1;
-import { old } from "./old.js";
 const b = 2;
+let c = 3;
`;

// ── buildHTML ────────────────────────────────────────────────────────────────

describe("buildHTML", () => {
  it("returns a complete HTML document", () => {
    const html = buildHTML(RESULT, DIFF);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("embeds the summary in the page", () => {
    const html = buildHTML(RESULT, DIFF);
    expect(html).toContain("Looks good overall.");
  });

  it("embeds comment body text", () => {
    const html = buildHTML(RESULT, DIFF);
    expect(html).toContain("use const");
  });

  it("escapes HTML-unsafe chars in JSON payload", () => {
    const xss: ReviewResult = { summary: "<script>alert(1)</script>", comments: [] };
    const html = buildHTML(xss, "");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("\\u003cscript");
  });

  it("embeds the diff string", () => {
    const html = buildHTML(RESULT, DIFF);
    expect(html).toContain("src/foo.ts");
  });

  it("embeds modelConfig fields in the page", () => {
    const html = buildHTML(RESULT, DIFF, undefined, undefined, undefined, undefined, {
      currentModel: "openai/gpt-4o",
      defaultModel: "anthropic/claude-sonnet-4",
      availableModels: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
    });
    expect(html).toContain("gpt-4o");
    expect(html).toContain("GPT-4o");
    expect(html).toContain("claude-sonnet-4");
  });
});

describe("route matching", () => {
  it("matches nested named segments without decoding structure", () => {
    const route = compileRoute({
      id: "action",
      methods: ["GET"],
      path: "/reviews/:reviewId/comments/:commentId",
    });
    expect(matchPath(route, "/reviews/abc/comments/42")).toEqual({
      params: { reviewId: "abc", commentId: "42" },
    });
    expect(matchPath(route, "/reviews/a%2Fb/comments/42")).toEqual({
      params: { reviewId: "a/b", commentId: "42" },
    });
    expect(matchPath(route, "/reviews/%zz/comments/42")).toEqual({ decodeError: true });
  });

  it("rejects duplicate route parameters", () => {
    expect(() => compileRoute({ id: "action", methods: ["GET"], path: "/:id/:id" })).toThrow();
  });
});

// ── startUIServer ────────────────────────────────────────────────────────────

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function getPath(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: base.hostname, port: base.port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function post(url: string, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("startUIServer", () => {
  afterEach(() => {
    applyConfigPatchMock.mockClear();
  });

  it("starts a server and returns a localhost URL", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    expect(handle.url).toMatch(/^http:\/\/localhost:\d+$/);
    await handle.close();
  });

  it("serves the HTML page on GET /", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status, body } = await get(handle.url);
    expect(status).toBe(200);
    expect(body).toContain("Pi Review");
    expect(body).toContain("Looks good overall.");
    await handle.close();
  });

  it("responds on a port different from the previous instance", async () => {
    const a = await startUIServer(RESULT, DIFF);
    const b = await startUIServer(RESULT, DIFF);
    expect(a.url).not.toBe(b.url);
    await Promise.all([a.close(), b.close()]);
  });

  it("close() shuts the server down so subsequent requests fail", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    await handle.close();
    await expect(get(handle.url)).rejects.toThrow();
  });

  it("GET /ping returns 204", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await get(handle.url + "/ping");
    expect(status).toBe(204);
    await handle.close();
  });

  it("ignores query strings when matching routes", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await get(handle.url + "/ping?source=test");
    expect(status).toBe(204);
    await handle.close();
  });

  it("returns 405 and Allow for an unsupported method on a known route", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status, allow } = await new Promise<{ status: number; allow: string | undefined }>((resolve, reject) => {
      const req = http.request(handle.url + "/ping", { method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, allow: res.headers.allow }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(405);
    expect(allow).toBe("GET");
    await handle.close();
  });

  it("returns 404 for unknown routes", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await get(handle.url + "/toString");
    expect(status).toBe(404);
    await handle.close();
  });

  it("does not normalize trailing or empty path segments", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    expect((await get(handle.url + "/ping/")).status).toBe(404);
    expect((await getPath(handle.url, "/ping//")).status).toBe(404);
    await handle.close();
  });

  it("POST /action resolves waitForAction with the payload", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const payload: UIAction = {
      type: "save",
      decisions: [
        { index: 0, decision: "accept" },
        { index: 1, decision: "reject" },
      ],
    };
    await post(handle.url + "/action", payload);
    const action = await handle.waitForAction();
    expect(action.type).toBe("save");
    expect(action.decisions).toHaveLength(2);
    await handle.close();
  });

  it("POST /action with invalid JSON returns 400", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(handle.url + "/action", { method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("error", reject);
      req.end("not-json");
    });
    expect(status).toBe(400);
    await handle.close();
  });

  it("POST /action with an invalid action shape returns 400", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await post(handle.url + "/action", { type: "send", decisions: [{ index: "0" }] });
    expect(status).toBe(400);
    await handle.close();
  });

  it("POST /config calls applyConfigPatch with the patch and returns 204", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await post(handle.url + "/config", {
      model: "openai/gpt-4o",
      theme: "light",
    });
    expect(status).toBe(204);
    expect(applyConfigPatchMock).toHaveBeenCalledWith({ model: "openai/gpt-4o", theme: "light" });
    await handle.close();
  });

  it("POST /config with invalid JSON body returns 400", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(handle.url + "/config", { method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("error", reject);
      req.end("not-json");
    });
    expect(status).toBe(400);
    expect(applyConfigPatchMock).not.toHaveBeenCalled();
    await handle.close();
  });

  it("POST /config with empty body returns 400", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(handle.url + "/config", { method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("error", reject);
      req.end("");
    });
    expect(status).toBe(400);
    expect(applyConfigPatchMock).not.toHaveBeenCalled();
    await handle.close();
  });

  it("rejects request bodies larger than 1 MiB", async () => {
    const handle = await startUIServer(RESULT, DIFF);
    const { status } = await post(handle.url + "/config", "x".repeat(1024 * 1024));
    expect(status).toBe(413);
    await handle.close();
  });
});
