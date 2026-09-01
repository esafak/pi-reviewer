import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  parseAgentResponse,
  parseAgentResponseWithStatus,
  normalizeFinding,
  reconcileFindingUpdates,
  sendOutput,
} from "../../src/core/output.js";
import { bodyFindingId, encodeBodyFindingMarker } from "../../src/ci/batch.js";

const createdDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-output-"));
  createdDirs.push(dir);
  return dir;
}

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    text: vi.fn().mockResolvedValue(""),
  });
}

describe("parseAgentResponse", () => {
  it("returns parsed ReviewResult for valid JSON", () => {
    const result = parseAgentResponse(
      JSON.stringify({
        summary: "Overall review",
        comments: [
          { file: "src/a.ts", line: 10, side: "RIGHT", severity: "WARN", body: "Nice improvement" },
        ],
      }),
    );

    expect(result).toEqual({
      summary: "Overall review",
      comments: [
        {
          file: "src/a.ts",
          line: 10,
          side: "RIGHT",
          severity: "WARN",
          body: "🟡 Nice improvement",
        },
      ],
    });
  });

  it("falls back for invalid JSON", () => {
    const result = parseAgentResponse("not-json");

    expect(result).toEqual({ summary: "not-json", comments: [] });
  });

  it("marks invalid JSON as unparsed", () => {
    expect(parseAgentResponseWithStatus("not-json")).toEqual({
      result: { summary: "not-json", comments: [] },
      parsed: false,
      rejectionReason: "malformed JSON",
    });
    expect(parseAgentResponseWithStatus(JSON.stringify({ summary: "LGTM", comments: [] }))).toEqual(
      {
        result: { summary: "LGTM", comments: [] },
        parsed: true,
      },
    );
  });

  it("parses JSON wrapped in markdown code fences", () => {
    const json = JSON.stringify({ summary: "looks good", comments: [] });
    const result = parseAgentResponse("```json\n" + json + "\n```");
    expect(result).toEqual({ summary: "looks good", comments: [] });
  });

  it("parses JSON wrapped in plain code fences", () => {
    const json = JSON.stringify({ summary: "looks good", comments: [] });
    const result = parseAgentResponse("```\n" + json + "\n```");
    expect(result).toEqual({ summary: "looks good", comments: [] });
  });

  it("parses JSON fence when a comment body contains an inner fenced code block", () => {
    const body = "Fix the null check:\n```ts\nif (!client) throw new Error('no client');\n```";
    const json = JSON.stringify({
      summary: "review",
      comments: [{ file: "src/a.ts", line: 10, side: "RIGHT", severity: "WARN", body }],
    });
    const result = parseAgentResponse("```json\n" + json + "\n```");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toContain("if (!client)");
  });

  it("parses JSON when agent adds preamble text before the fence", () => {
    const json = JSON.stringify({ summary: "looks good", comments: [] });
    const result = parseAgentResponse("Here is my review:\n\n```json\n" + json + "\n```");
    expect(result).toEqual({ summary: "looks good", comments: [] });
  });

  it("parses JSON when LLM includes unescaped newlines in a string field (e.g. raw diff)", () => {
    // LLM manually pastes the diff into the JSON without escaping newlines → invalid JSON
    const malformed = `{"summary":"looks good","comments":[],"diff":"diff --git a/f b/f\nindex 0..1\n+line"}`;
    const result = parseAgentResponse(malformed);
    expect(result.summary).toBe("looks good");
    expect(result.comments).toHaveLength(0);
  });

  it("preserves formatting whitespace when a formatted JSON string contains a raw newline", () => {
    const malformed = `{
  "summary": "looks good
with details",
  "comments": []
}`;
    const result = parseAgentResponseWithStatus(malformed);
    expect(result.parsed).toBe(true);
    expect(result.result.summary).toBe("looks good\nwith details");
  });

  it("parses JSON when trailing prose after closing fence contains braces", () => {
    const json = JSON.stringify({ summary: "looks good", comments: [] });
    const result = parseAgentResponse(
      "```json\n" + json + "\n```\nThe catch block should look like `} catch(e) {}`",
    );
    expect(result).toEqual({ summary: "looks good", comments: [] });
  });

  it("parses JSON when agent adds preamble and no fence", () => {
    const json = JSON.stringify({ summary: "looks good", comments: [] });
    const result = parseAgentResponse("Here is my review:\n\n" + json);
    expect(result).toEqual({ summary: "looks good", comments: [] });
  });

  it("falls back when JSON is missing required fields", () => {
    const result = parseAgentResponse(JSON.stringify({ summary: "Only summary" }));

    expect(result).toEqual({
      summary: JSON.stringify({ summary: "Only summary" }),
      comments: [],
    });
  });

  it("normalizes missing severity to INFO", () => {
    const result = parseAgentResponse(
      JSON.stringify({
        summary: "review",
        comments: [{ file: "src/a.ts", line: 1, side: "RIGHT", body: "comment" }],
      }),
    );
    expect(result.comments[0].severity).toBe("INFO");
  });

  it("filters out comments below minSeverity", () => {
    const result = parseAgentResponse(
      JSON.stringify({
        summary: "review",
        comments: [
          { file: "src/a.ts", line: 1, side: "RIGHT", severity: "INFO", body: "style" },
          { file: "src/b.ts", line: 2, side: "RIGHT", severity: "WARN", body: "logic issue" },
          { file: "src/c.ts", line: 3, side: "RIGHT", severity: "CRITICAL", body: "crash" },
        ],
      }),
      "WARN",
    );
    expect(result.comments).toHaveLength(2);
    expect(result.comments.map((c) => c.severity)).toEqual(["WARN", "CRITICAL"]);
  });

  it("keeps the latest review when its comments are all filtered by minSeverity", () => {
    const draft = JSON.stringify({
      summary: "Earlier draft",
      comments: [
        { file: "src/draft.ts", line: 1, side: "RIGHT", severity: "WARN", body: "draft issue" },
      ],
    });
    const final = JSON.stringify({
      summary: "Final review",
      comments: [
        { file: "src/final.ts", line: 2, side: "RIGHT", severity: "INFO", body: "style issue" },
      ],
    });

    const result = parseAgentResponse(`${draft}\n${final}`, "WARN");

    expect(result.summary).toBe("Final review");
    expect(result.comments).toEqual([]);
  });

  it("extracts diff field when present in JSON", () => {
    const result = parseAgentResponse(
      JSON.stringify({ summary: "looks good", comments: [], diff: "diff --git a/src/a.ts..." }),
    );

    expect(result.diff).toBe("diff --git a/src/a.ts...");
  });

  it("leaves diff undefined when not present in JSON", () => {
    const result = parseAgentResponse(JSON.stringify({ summary: "looks good", comments: [] }));

    expect(result.diff).toBeUndefined();
  });

  it("leaves diff undefined when diff field is not a string", () => {
    const result = parseAgentResponse(
      JSON.stringify({ summary: "looks good", comments: [], diff: 42 }),
    );

    expect(result.diff).toBeUndefined();
  });

  it("keeps only CRITICAL when minSeverity is CRITICAL", () => {
    const result = parseAgentResponse(
      JSON.stringify({
        summary: "review",
        comments: [
          { file: "src/a.ts", line: 1, side: "RIGHT", severity: "INFO", body: "style" },
          { file: "src/b.ts", line: 2, side: "RIGHT", severity: "WARN", body: "logic" },
          { file: "src/c.ts", line: 3, side: "RIGHT", severity: "CRITICAL", body: "crash" },
        ],
      }),
      "CRITICAL",
    );
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].severity).toBe("CRITICAL");
  });

  // The model emits chain-of-thought reasoning with inline braces (unquoted
  // keys → not valid JSON), inner ```ts / ```json fences, then the final
  // valid ```json review fence with 6 comments. The old greedy-fence regex
  // spanned first-open → last-close, mashing everything into one invalid blob;
  // the old first-brace extractor grabbed the unquoted `{ success: true, ... }`
  // from reasoning prose. Last-valid-wins must pick the final review.

  it("parses the production incident comment body (reasoning + inner fences + final valid review)", () => {
    const body = [
      "## Pi Reviewer",
      "",
      "Everything looks consistent. Summary of findings:",
      "",
      "1. Data nesting mismatch. The form action returns `{ success: true, data: result.data }`,",
      '   which SvelteKit wraps as `{ type: "success", data: { success: true, data: MediaUploadResponse } }`.',
      "",
      "The test expects:",
      "```ts",
      'await expect(promise).resolves.toEqual({ resourceId: "123" });',
      "```",
      "",
      "And the mock response is:",
      "```json",
      '{"type":"success","data":{"resourceId":"123"}}',
      "```",
      "",
      "So the bug is real. Let me write the review.",
      "",
      "```json",
      JSON.stringify({
        summary: "Critical data-nesting bug in the upload flow. Attachments silently fail.",
        comments: [
          {
            file: "upload.ts",
            line: 30,
            side: "RIGHT",
            severity: "CRITICAL",
            body: "`resolve(body?.data as T)` extracts the wrong layer.",
          },
          {
            file: "upload.test.ts",
            line: 79,
            side: "RIGHT",
            severity: "CRITICAL",
            body: "Test mock doesn't match real protocol.",
          },
          {
            file: "attachments.test.ts",
            line: 72,
            side: "RIGHT",
            severity: "CRITICAL",
            body: "Mock skips the SvelteKit wrapper.",
          },
          {
            file: "+server.ts",
            line: 14,
            side: "RIGHT",
            severity: "WARN",
            body: "Only GET is exported.",
          },
          {
            file: "attachments.ts",
            line: 45,
            side: "RIGHT",
            severity: "INFO",
            body: "`INLINE_MAX_BYTES` mirrors backend.",
          },
          {
            file: "upload.ts",
            line: 798,
            side: "RIGHT",
            severity: "CRITICAL",
            body: "Root cause: form action nests return value.",
          },
        ],
      }),
      "```",
      "",
      "---",
      "*Review by [pi-reviewer](https://github.com/zeflq/pi-reviewer)*",
    ].join("\n");

    const result = parseAgentResponse(body);

    expect(result.summary).toBe(
      "Critical data-nesting bug in the upload flow. Attachments silently fail.",
    );
    expect(result.comments).toHaveLength(6);
    expect(result.comments.map((c) => c.severity)).toEqual([
      "CRITICAL",
      "CRITICAL",
      "CRITICAL",
      "WARN",
      "INFO",
      "CRITICAL",
    ]);
    // Severity emoji prefix is applied
    expect(result.comments[0].body).toMatch(/^🔴 /);
    expect(result.comments[3].body).toMatch(/^🟡 /);
    expect(result.comments[4].body).toMatch(/^🔵 /);
  });

  it("nested ```json fence inside a comment body is not treated as a block boundary", () => {
    // The comment body itself contains a ```json snippet. The non-greedy fence
    // extractor may truncate early, but the brace-aware extractor must still
    // find and validate the complete object.
    const innerFence = 'Example:\n```json\n{"resourceId": "123"}\n```';
    const json = JSON.stringify({
      summary: "review",
      comments: [{ file: "a.ts", line: 1, side: "RIGHT", severity: "WARN", body: innerFence }],
    });
    const result = parseAgentResponse("```json\n" + json + "\n```");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toContain('"resourceId"');
  });

  it("chooses the last valid {summary, comments} when multiple exist (last-wins)", () => {
    const first = JSON.stringify({ summary: "first draft", comments: [] });
    const second = JSON.stringify({
      summary: "final review",
      comments: [{ file: "b.ts", line: 2, side: "LEFT", severity: "CRITICAL", body: "crash" }],
    });
    const result = parseAgentResponse(`Draft:\n${first}\n\nFinal:\n${second}`);
    expect(result.summary).toBe("final review");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe("b.ts");
  });

  it("prefers a review with comments over an empty-comments example in trailing prose", () => {
    // Real review in a fence, followed by a prose example with empty comments.
    // Without the non-empty-preference guard, the trailing example would win
    // (last-wins + comments.every() is vacuously true for []).
    const real = JSON.stringify({
      summary: "Real review",
      comments: [{ file: "a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "issue" }],
    });
    const example = JSON.stringify({ summary: "example shape", comments: [] });
    const result = parseAgentResponse(
      `\`\`\`json\n${real}\n\`\`\`\nFor reference, the shape is: ${example}`,
    );
    expect(result.summary).toBe("Real review");
    expect(result.comments).toHaveLength(1);
  });

  it("still returns summary-only review when it is the only valid candidate", () => {
    // A genuine summary-only review (no comments) should still parse when
    // there's no competing candidate with comments.
    const result = parseAgentResponse(JSON.stringify({ summary: "LGTM", comments: [] }));
    expect(result.summary).toBe("LGTM");
    expect(result.comments).toEqual([]);
  });

  it("handles braces and quotes inside JSON string values (brace scanner edge case)", () => {
    // The brace scanner must track inString state so braces/quotes inside
    // string values don't confuse depth tracking.
    const result = parseAgentResponse(
      JSON.stringify({
        summary: 'The config uses { "nested": true } and }{ patterns',
        comments: [
          {
            file: "a.ts",
            line: 1,
            side: "RIGHT",
            severity: "WARN",
            body: "Check the `} catch(e) {}` block",
          },
        ],
      }),
    );
    expect(result.summary).toBe('The config uses { "nested": true } and }{ patterns');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].body).toContain("} catch(e) {}");
  });

  it("recovers via fenced block when reasoning has a stray unclosed brace", () => {
    // If reasoning prose contains an unclosed `{`, the brace scanner gets
    // stuck at depth 1 and can't find subsequent objects — but the fence
    // extractor runs independently, so the review is still recoverable.
    const real = JSON.stringify({
      summary: "found it",
      comments: [{ file: "a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "fix" }],
    });
    const result = parseAgentResponse(
      `Consider this object { incomplete\n\n\`\`\`json\n${real}\n\`\`\``,
    );
    expect(result.summary).toBe("found it");
    expect(result.comments).toHaveLength(1);
  });
});

describe("sendOutput", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await Promise.all(
      createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("logs formatted content to console for terminal target", async () => {
    await sendOutput({ target: "terminal", content: "hello review" });

    expect(logSpy).toHaveBeenCalledWith("== Review Summary ==\nhello review");
  });

  it("posts to Issues API when no commitId is provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "LGTM", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/42/comments",
      expect.objectContaining({
        body: expect.stringContaining("LGTM"),
      }),
    );
    const body = (fetchMock.mock.calls[0][1] as { body: string }).body;
    expect(body).not.toContain("---");
    expect(body).not.toContain("Review by pi-reviewer");
  });

  it("posts to Reviews API with inline comments when commitId is provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "Needs fixes",
        comments: [
          {
            file: "src/auth.ts",
            line: 42,
            side: "RIGHT",
            severity: "CRITICAL",
            body: "Missing null check",
          },
        ],
      }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/pulls/42/reviews",
      expect.objectContaining({
        body: JSON.stringify({
          commit_id: "abc123",
          body: "Needs fixes",
          event: "COMMENT",
          comments: [
            { path: "src/auth.ts", line: 42, side: "RIGHT", body: "<!-- pi-reviewer:finding:v1 -->\n🔴 Missing null check" },
          ],
        }),
      }),
    );
  });

  it("reacts to the PR instead of posting a comment when enabled and no findings exist", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "review-bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify([])) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ id: 1, content: "+1" })) });
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "LGTM", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      reactOnNoFindings: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/42/reactions",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "+1" }) }),
    );
  });

  it("does not react while an existing finding remains outstanding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify([])) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("") });
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "Still open", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "head",
      reactOnNoFindings: true,
      existingFindings: [{ commentId: 9 }],
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/reactions"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/reviews"))).toBe(true);
  });

  it("falls back to a normal comment when the reaction cannot be posted", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden", text: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("") });
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "LGTM", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      reactOnNoFindings: true,
    });

    expect(fetchMock.mock.calls[1][0]).toContain("/issues/42/comments");
  });

  it("falls back to the normal review when batch marker creation fails", async () => {
    const marker = '<!-- pi-reviewer:batch:v1 {"version":1,"fromSha":"base","toSha":"head","kind":"synchronize","actor":"review-bot","reviewId":0} -->';
    const successfulReview = { ok: true, text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({ id: 2 }), clone() { return this; } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "review-bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify([])) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ id: 1, content: "+1" })) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error", text: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce(successfulReview);
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "LGTM", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "head",
      batchMarker: marker,
      reactOnNoFindings: true,
    });

    expect(fetchMock.mock.calls[5][0]).toContain("/pulls/42/reviews");
  });

  it("refuses to post when the PR head changed during review", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "new-head" } })),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "stale", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "reviewed-head",
      batchMarker: "<!-- marker -->",
    })).rejects.toThrow("PR head changed while the review was running");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/repo/pulls/42");
  });

  it("retries once as body-only review when Reviews API returns 422", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: vi.fn().mockResolvedValue(""),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("") });
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "Needs fixes",
        comments: [
          {
            file: "src/auth.ts",
            line: 42,
            side: "RIGHT",
            severity: "WARN",
            body: "Missing null check",
          },
        ],
      }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
    });

    // First call: inline review (rejected 422). Second call: body-only retry,
    // NOT the Issues API — every comment moved to the body, comments: [].
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/pulls/42/reviews",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api.github.com/repos/owner/repo/pulls/42/reviews",
    );
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(retryBody.comments).toEqual([]);
    expect(retryBody.body).toContain("Missing null check");
    expect(retryBody.body).toContain("Comments Not Attached to the Diff");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("422"));
  });

  it("falls back to Issues API when the body-only retry also fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: vi.fn().mockResolvedValue(""),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        text: vi.fn().mockResolvedValue(""),
      })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("") });
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "Needs fixes",
        comments: [
          {
            file: "src/auth.ts",
            line: 42,
            side: "RIGHT",
            severity: "WARN",
            body: "Missing null check",
          },
        ],
      }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.github.com/repos/owner/repo/issues/42/comments",
    );
  });

  it("posts only positionable comments inline and moves the rest to the review body", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    // tag-input.svelte diff: hunk @@ -17,6 +17,7 @@ makes new line 20
    // positionable; line 36 is outside every hunk.
    const diff = `diff --git a/client/web/src/lib/components/core/tag-input/tag-input.svelte b/client/web/src/lib/components/core/tag-input/tag-input.svelte
--- a/client/web/src/lib/components/core/tag-input/tag-input.svelte
+++ b/client/web/src/lib/components/core/tag-input/tag-input.svelte
@@ -17,6 +17,7 @@
         handleTagAdded?: (tag: string) => void;
         handleTagRemoved?: (tagRemoved: string, currentTags: string[]) => void;
         errorTags?: string[];
+        customValidation?: (tag: string) => boolean;
     }
 </script>

@@ -27,6 +28,7 @@
         handleTagAdded,
         handleTagRemoved,
         errorTags,
+        customValidation,
     }: TagInputProps = $props();
 
     $effect(() => {
`;

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "Review",
        comments: [
          {
            file: "client/web/src/lib/components/core/tag-input/tag-input.svelte",
            line: 20,
            side: "RIGHT",
            severity: "INFO",
            body: "positionable",
          },
          {
            file: "client/web/src/lib/components/core/tag-input/tag-input.svelte",
            line: 36,
            side: "RIGHT",
            severity: "INFO",
            body: "unpositionable",
          },
        ],
      }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
      diff,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/pulls/42/reviews",
    );
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.comments).toEqual([
      {
        path: "client/web/src/lib/components/core/tag-input/tag-input.svelte",
        line: 20,
        side: "RIGHT",
        body: "<!-- pi-reviewer:finding:v1 -->\n🔵 positionable",
      },
    ]);
    expect(payload.body).toContain("Review");
    expect(payload.body).toContain("Comments Not Attached to the Diff");
    expect(payload.body).toContain("unpositionable");
  });

  it("posts a body-only review when every comment is unpositionable", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,1 +40,1 @@
-foo
+bar
`;

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "Review",
        comments: [
          { file: "src/other.ts", line: 5, side: "RIGHT", severity: "WARN", body: "not in diff" },
        ],
      }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
      diff,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("Comments Not Attached to the Diff");
    expect(payload.body).toContain("not in diff");
  });

  it("posts to Reviews API with all comments inline when no diff is provided", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "Needs fixes",
        comments: [
          {
            file: "src/auth.ts",
            line: 42,
            side: "RIGHT",
            severity: "WARN",
            body: "Missing null check",
          },
        ],
      }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/pulls/42/reviews",
    );
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.comments).toHaveLength(1);
  });

  it("uses the Reviews API with a valid summary-only review", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({ summary: "Looks mostly good", comments: [] }),
      githubToken: "token123",
      prNumber: 42,
      repo: "owner/repo",
      commitId: "abc123",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/pulls/42/reviews", expect.anything());
  });

  it("refuses to post unparseable model output", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendOutput({
        target: "comment",
        content: "Looks mostly good",
        githubToken: "token123",
        prNumber: 42,
        repo: "owner/repo",
        commitId: "abc123",
      }),
    ).rejects.toThrow("refusing to post raw model output");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when githubToken is missing", async () => {
    await expect(
      sendOutput({
        target: "comment",
        content: "text",
        prNumber: 1,
        repo: "owner/repo",
      }),
    ).rejects.toThrow("GITHUB_TOKEN is required to post a comment");
  });

  it("throws when prNumber is missing", async () => {
    await expect(
      sendOutput({
        target: "comment",
        content: "text",
        githubToken: "token",
        repo: "owner/repo",
      }),
    ).rejects.toThrow("PR number is required to post a comment");
  });

  it("throws when repo is missing", async () => {
    await expect(
      sendOutput({
        target: "comment",
        content: "text",
        githubToken: "token",
        prNumber: 1,
      }),
    ).rejects.toThrow("Repository (owner/repo) is required to post a comment");
  });

  it("throws when fetch response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: vi.fn().mockResolvedValue("Forbidden"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendOutput({
        target: "comment",
        content: JSON.stringify({ summary: "text", comments: [] }),
        githubToken: "token",
        prNumber: 1,
        repo: "owner/repo",
      }),
    ).rejects.toThrow("Failed to post GitHub comment: 403 Forbidden");
  });

  it("writes formatted review to pi-review.md for file target", async () => {
    const dir = await createTempDir();

    await sendOutput({
      target: "file",
      content: JSON.stringify({
        summary: "Please address comments",
        comments: [
          { file: "src/a.ts", line: 7, side: "RIGHT", severity: "WARN", body: "Handle undefined" },
        ],
      }),
      cwd: dir,
    });

    const content = await readFile(path.join(dir, "pi-review.md"), "utf-8");
    expect(content).toBe(
      "== Review Summary ==\nPlease address comments\n\n== Inline Comments ==\n🟡 src/a.ts:7 (RIGHT)\n🟡 Handle undefined",
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("pi-review.md"));
  });

  it("filters comments by minSeverity when posting", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: JSON.stringify({
        summary: "review",
        comments: [
          { file: "src/a.ts", line: 1, side: "RIGHT", severity: "INFO", body: "style" },
          { file: "src/b.ts", line: 2, side: "RIGHT", severity: "CRITICAL", body: "crash" },
        ],
      }),
      githubToken: "token123",
      prNumber: 1,
      repo: "owner/repo",
      commitId: "abc123",
      minSeverity: "CRITICAL",
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].path).toBe("src/b.ts");
  });

  it("keeps text fallback strict for finding updates", () => {
    const valid = parseAgentResponseWithStatus(JSON.stringify({ summary: "updated", comments: [], finding_updates: [{ comment_id: 7, status: "RESOLVED", explanation: "fixed" }] }), "INFO", new Set([7]));
    expect(valid.parsed).toBe(true);
    expect(valid.result.finding_updates?.[0].status).toBe("RESOLVED");
    expect(parseAgentResponseWithStatus(JSON.stringify({ summary: "bad", comments: [], finding_updates: [{ comment_id: 8, status: "RESOLVED", explanation: "x" }] }), "INFO", new Set([7])).parsed).toBe(false);
  });

  it("posts valid structured comments inline while dropping only invalid finding updates", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendOutput({
      target: "comment",
      content: "",
      structuredResult: {
        summary: "review",
        comments: [{ file: "src/a.ts", line: 2, side: "RIGHT", severity: "WARN", body: "valid comment" }],
        finding_updates: [
          { comment_id: 999, status: "RESOLVED", explanation: "do not log this model text" },
          { comment_id: {}, status: {}, explanation: "another model detail" } as never,
        ],
      },
      githubToken: "token",
      prNumber: 1,
      repo: "owner/repo",
      commitId: "head",
      allowedFindingIds: new Set([7]),
      diff: `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 export function run() {
+  return true;
 }
`,
    });

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.comments).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        side: "RIGHT",
        body: "<!-- pi-reviewer:finding:v1 -->\n🟡 valid comment",
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("comment_id=999"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reason=unknown active-finding ID"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("do not log this model text");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("[object Object]");
  });

  it.each([
    ["malformed JSON", "{not-json", "malformed JSON"],
    ["invalid comments", JSON.stringify({ summary: "review", comments: [{ file: "a.ts" }] }), "invalid comments"],
    ["invalid finding_updates", JSON.stringify({ summary: "review", comments: [], finding_updates: [{ comment_id: 7, status: "BROKEN", explanation: "secret model text" }] }), "invalid finding_updates"],
  ])("diagnoses text fallback rejection as %s without raw content", async (_label, content, reason) => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendOutput({
      target: "comment",
      content,
      githubToken: "token",
      prNumber: 1,
      repo: "owner/repo",
    })).rejects.toThrow("refusing to post raw model output");

    expect(warn).toHaveBeenCalledWith(`[pi-reviewer] rejected text fallback: ${reason}`);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret model text");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed structured results cleanly instead of throwing a TypeError", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOutput({
      target: "comment",
      content: "",
      structuredResult: { comments: [] } as never,
      githubToken: "token",
      prNumber: 1,
      repo: "owner/repo",
    })).rejects.toThrow("valid structured review: invalid summary");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("moves a structured comment from a previous-batch location into the review body", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await sendOutput({
      target: "comment",
      content: "",
      structuredResult: {
        summary: "review",
        comments: [{ file: "src/a.ts", line: 99, side: "RIGHT", severity: "INFO", body: "stale location" }],
      },
      githubToken: "token",
      prNumber: 1,
      repo: "owner/repo",
      commitId: "head",
      diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    });

    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.comments).toEqual([]);
    expect(payload.body).toContain("stale location");
  });

  it("sanitizes model marker prefixes in visible review text but keeps generated metadata", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await sendOutput({
      target: "comment",
      content: "",
      structuredResult: {
        summary: '<!-- pi-reviewer:batch:v1 {"version":1} --> user summary',
        comments: [{ file: "src/a.ts", line: 99, side: "RIGHT", severity: "WARN", body: '<!-- pi-reviewer:body-finding:v1 {"version":1} --> user finding' }],
      },
      githubToken: "token", prNumber: 1, repo: "owner/repo", commitId: "head",
      diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    });
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.body).toContain("<!-- pi-reviewer :batch:");
    expect(payload.body).toContain("<!-- pi-reviewer :body-finding:");
    expect(payload.body).toMatch(/<!-- pi-reviewer:body-finding:v1 \{"version":1,"status":"ACTIVE"/);
  });

  it("normalizes duplicate finding identities", () => {
    expect(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "🔴 issue\n\n details" })).toBe(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "issue\n details" }));
    expect(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: encodeBodyFindingMarker({ findingId: 7, file: "a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "🟡 issue" }) })).toBe(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "issue" }));
    expect(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "<!-- pi-reviewer:finding:v1 -->\n🔴 issue" })).toBe(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "issue" }));
    expect(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "before <!-- pi-reviewer: body-finding:v1 ignored --> after" })).toBe(normalizeFinding({ file: "a.ts", line: 1, side: "RIGHT", body: "before <!-- pi-reviewer : body-finding:v1 ignored --> after" }));
  });
});

describe("reconcileFindingUpdates", () => {
  it("updates a body finding in its originating review without replying inline", async () => {
    const id = bodyFindingId(["src/a.ts", 1, "RIGHT", "body issue"].join("\0"));
    const reviewBody = `visible summary\n${encodeBodyFindingMarker({ findingId: id, file: "src/a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "body issue" })}\nvisible details`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ body: reviewBody.replace("visible details", "fresh visible details") })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: id, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: id, reviewId: 42, bodyFinding: true, reviewBody }] })).resolves.toEqual(new Set());
    expect(fetchMock.mock.calls[5][0]).toContain("/pulls/1/reviews/42");
    const updated = JSON.parse((fetchMock.mock.calls[5][1] as { body: string }).body).body;
    expect(updated).toContain("visible summary");
    expect(updated).toContain("fresh visible details");
    expect(updated).toContain('"status":"RESOLVED"');
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/comments") && (init as RequestInit)?.method === "POST")).toBe(false);
  });
  it("updates multiple body findings in one review without overwriting siblings", async () => {
    const firstId = bodyFindingId("first body finding");
    const secondId = bodyFindingId("second body finding");
    const reviewBody = [
      "visible summary",
      encodeBodyFindingMarker({ findingId: firstId, file: "src/a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "first" }),
      encodeBodyFindingMarker({ findingId: secondId, file: "src/b.ts", line: 2, side: "RIGHT", severity: "CRITICAL", body: "second" }),
      "visible details",
    ].join("\n");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ body: reviewBody.replace("visible details", "fresh sibling details") })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
       .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileFindingUpdates({
      token: "t", repo: "o/r", prNumber: 1, targetSha: "head",
      updates: [
        { comment_id: firstId, status: "RESOLVED", explanation: "first fixed" },
        { comment_id: secondId, status: "PARTIALLY_RESOLVED", explanation: "second remains" },
      ],
      findings: [
        { commentId: firstId, reviewId: 42, bodyFinding: true, reviewBody },
        { commentId: secondId, reviewId: 42, bodyFinding: true, reviewBody },
      ],
    })).resolves.toEqual(new Set([secondId]));

    expect(fetchMock).toHaveBeenCalledTimes(6);
    const updated = JSON.parse((fetchMock.mock.calls[5][1] as { body: string }).body).body as string;
    expect(updated).toContain("visible summary");
    expect(updated).toContain("fresh sibling details");
    expect(updated).toContain(`"findingId":${firstId}`);
    expect(updated).toContain(`"findingId":${secondId}`);
    expect(updated).toContain('"status":"RESOLVED"');
    expect(updated).toContain('"status":"PARTIALLY_RESOLVED"');
  });
  it("does not mutate still-open findings", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "STILL_OPEN", explanation: "unchanged" }], findings: [{ commentId: 3, threadId: "thread" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ authorization: "Bearer t" }) });
  });
  it("skips the body review PUT when the PR head changes before the body write", async () => {
    const id = bodyFindingId("head changed before body write");
    const reviewBody = encodeBodyFindingMarker({ findingId: id, file: "src/a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "issue" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ body: reviewBody })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "new-head" } })) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileFindingUpdates({
      token: "t", repo: "o/r", prNumber: 1, targetSha: "head",
      updates: [{ comment_id: id, status: "RESOLVED", explanation: "fixed" }],
      findings: [{ commentId: id, reviewId: 42, bodyFinding: true, reviewBody }],
    })).resolves.toEqual(new Set([id]));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes("/reviews/42") && (init as RequestInit)?.method === "PUT")).toBe(false);
  });
  it("treats an already-resolved marker with the same explanation as reconciled", async () => {
    const id = bodyFindingId("already resolved");
    const reviewBody = encodeBodyFindingMarker({ findingId: id, file: "src/a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "issue", status: "RESOLVED", targetSha: "head", explanation: "fixed" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ body: reviewBody })) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: id, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: id, reviewId: 42, bodyFinding: true, reviewBody }] })).resolves.toEqual(new Set());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("replies and resolves a resolved finding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "thread", isResolved: true } } } })) });
    vi.stubGlobal("fetch", fetchMock);
    await reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: 3, threadId: "thread" }] });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
  it("continues after reply or resolve failures", async () => {
    const replyFailure = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "error", text: vi.fn().mockResolvedValue("failed") });
    vi.stubGlobal("fetch", replyFailure);
     await expect(reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: 3, threadId: "thread" }] })).resolves.toEqual(new Set([3]));
    expect(replyFailure).toHaveBeenCalledTimes(5);

    const resolveFailure = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ errors: [{ message: "failed" }] })) });
    vi.stubGlobal("fetch", resolveFailure);
     await expect(reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: 3, threadId: "thread" }] })).resolves.toEqual(new Set([3]));
    expect(resolveFailure).toHaveBeenCalledTimes(7);
  });
  it("does not resolve a finding when the head changes during reconciliation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "old-head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "new-head" } })) });
    vi.stubGlobal("fetch", fetchMock);
    await reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "old-head", updates: [{ comment_id: 3, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: 3, threadId: "thread" }] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][0]).toContain("/pulls/1");
  });
  it("persists the reconciliation status in the status marker", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("[]") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetchMock);
     await expect(reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "PARTIALLY_RESOLVED", explanation: "still needs work" }], findings: [{ commentId: 3, threadId: "thread" }] })).resolves.toEqual(new Set([3]));
    const body = JSON.parse((fetchMock.mock.calls[4][1] as { body: string }).body).body as string;
    expect(body).toContain('"status":"PARTIALLY_RESOLVED"');
    expect(body).toContain("Partially addressed by head: still needs work");
  });
  it("uses exactly the first seven SHA characters in lifecycle wording", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "345879342abcdef" } })) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify([])) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "345879342abcdef" } })) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify({ id: 10 })) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "345879342abcdef" } })) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: vi.fn().mockResolvedValue(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "thread", isResolved: true } } } })) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "345879342abcdef", updates: [{ comment_id: 3, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: 3, threadId: "thread" }] })).resolves.toEqual(new Set());
    expect(JSON.parse((fetchMock.mock.calls[4][1] as { body: string }).body).body).toContain("Resolved by 3458793: fixed");
  });
  it("leaves partial findings open and skips an already-posted reply", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify([{ id: 9, in_reply_to_id: 3, user: { login: "bot" }, body: '"targetSha":"head","status":"PARTIALLY_RESOLVED"' }])) });
    vi.stubGlobal("fetch", fetchMock);
    await reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "PARTIALLY_RESOLVED", explanation: "changed; remains" }, { comment_id: 4, status: "STILL_OPEN", explanation: "same" }], findings: [{ commentId: 3, threadId: "thread" }, { commentId: 4, threadId: "thread2" }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("does not deduplicate a transition from partial to resolved", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify([{ id: 9, in_reply_to_id: 3, user: { login: "bot" }, body: '"targetSha":"head","status":"PARTIALLY_RESOLVED"' }])) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "thread", isResolved: true } } } })) });
    vi.stubGlobal("fetch", fetchMock);
    await reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "RESOLVED", explanation: "fixed" }], findings: [{ commentId: 3, threadId: "thread" }] });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
  it("does not treat a participant's forged status reply as an existing lifecycle reply", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ login: "bot" })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify([{ id: 9, in_reply_to_id: 3, user: { login: "human" }, body: '"targetSha":"head"' }])) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify({ head: { sha: "head" } })) })
      .mockResolvedValueOnce({ ok: true, text: vi.fn().mockResolvedValue("{}") });
    vi.stubGlobal("fetch", fetchMock);
    await reconcileFindingUpdates({ token: "t", repo: "o/r", prNumber: 1, targetSha: "head", updates: [{ comment_id: 3, status: "PARTIALLY_RESOLVED", explanation: "changed" }], findings: [{ commentId: 3 }] });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[4][0]).toContain("/comments");
  });
  it("suppresses an existing finding across batches", async () => {
    const fetchMock = okFetch(); vi.stubGlobal("fetch", fetchMock);
    await sendOutput({ target: "comment", content: JSON.stringify({ summary: "review", comments: [{ file: "src/a.ts", line: 1, side: "RIGHT", severity: "WARN", body: "same issue" }] }), githubToken: "t", prNumber: 1, repo: "o/r", commitId: "head", existingFindingKeys: new Set([normalizeFinding({ file: "src/a.ts", line: 1, side: "RIGHT", body: "same issue" })]) });
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(payload.comments).toEqual([]);
  });
  it("retains a batch marker in the body-only fallback", async () => {
    const marker = '<!-- pi-reviewer:batch:v1 {"version":1,"fromSha":"base","toSha":"head","kind":"synchronize","actor":"bot","reviewId":0} -->';
    const response = (body: unknown, ok = true, status = 200) => ({ ok, status, text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)), json: vi.fn().mockResolvedValue(body), clone() { return this; } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ head: { sha: "head" } }))
      .mockResolvedValueOnce(response("bad", false, 422))
      .mockResolvedValueOnce(response({ id: 12, comments: [] }))
      .mockResolvedValueOnce(response({ id: 12 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendOutput({ target: "comment", content: JSON.stringify({ summary: "review", comments: [] }), githubToken: "t", prNumber: 1, repo: "o/r", commitId: "head", batchMarker: marker });
    const fallback = JSON.parse((fetchMock.mock.calls[2][1] as { body: string }).body);
    expect(fallback.body).toContain(marker);
  });
});
