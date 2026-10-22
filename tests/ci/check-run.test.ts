import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CHECK_IN_PROGRESS_SUMMARY,
  CHECK_OUTPUT_TITLE,
  CHECK_RUN_NAME,
  MAX_ANNOTATION_MESSAGE_BYTES,
  MAX_CHECK_SUMMARY_BYTES,
  annotationLevel,
  concludeDependencyCheckRun,
  conclusionFor,
  createDependencyCheckRun,
  toAnnotations,
} from "../../src/ci/check-run.js";
import { GitHubClient } from "../../src/ci/github.js";
import type { PublishedFinding } from "../../src/core/output.js";

afterEach(() => vi.unstubAllGlobals());

/**
 * A manifest whose second line changed. The head file's lines are 1 to 3,
 * and the old file's lines are 1 to 3 as well, so line 2 exists on both
 * sides and line 4 exists on neither.
 */
const DIFF = `diff --git a/package.json b/package.json
index 1234567..89abcde 100644
--- a/package.json
+++ b/package.json
@@ -1,3 +1,3 @@
 {
-  "foo": "^1.0.0"
+  "foo": "^2.0.0"
 }
`;

function response(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Forbidden",
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function finding(overrides: Partial<PublishedFinding> = {}): PublishedFinding {
  return {
    file: "package.json",
    line: 2,
    side: "RIGHT",
    severity: "WARN",
    body: "foo 2.0.0 removed `create`.",
    ...overrides,
  };
}

/** The requests the stubbed transport received, parsed back from their bodies. */
function requests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit).method,
    body: JSON.parse(String((init as RequestInit).body)),
  }));
}

describe("annotationLevel", () => {
  it("maps every severity to the level the API takes", () => {
    expect(annotationLevel("CRITICAL")).toBe("failure");
    expect(annotationLevel("WARN")).toBe("warning");
    expect(annotationLevel("INFO")).toBe("notice");
  });
});

describe("conclusionFor", () => {
  it("fails the check when a critical finding is published", () => {
    expect(conclusionFor([finding({ severity: "CRITICAL" })])).toBe("failure");
  });

  it("passes the check when only warnings and notes are published", () => {
    expect(conclusionFor([])).toBe("success");
    expect(conclusionFor([finding({ severity: "WARN" })])).toBe("success");
    expect(conclusionFor([finding({ severity: "INFO" })])).toBe("success");
  });

  it("computes the gate over every published finding, not only the annotated ones", () => {
    // A critical finding the harness could not place on the diff is still
    // published in the review body, and it still fails the check.
    expect(
      conclusionFor([
        finding({ severity: "INFO" }),
        finding({ severity: "CRITICAL", file: undefined }),
      ]),
    ).toBe("failure");
  });
});

describe("toAnnotations", () => {
  it("maps a finding onto the annotation the API takes", () => {
    const { annotations, unannotated } = toAnnotations(
      [finding({ severity: "CRITICAL", body: "foo 2.0.0 removed `create`." })],
      DIFF,
    );

    expect(unannotated).toEqual([]);
    expect(annotations).toEqual([
      {
        path: "package.json",
        start_line: 2,
        end_line: 2,
        annotation_level: "failure",
        message: "foo 2.0.0 removed `create`.",
        title: "CRITICAL",
      },
    ]);
  });

  it("anchors a finding that carries no side on the head file", () => {
    const { annotations, unannotated } = toAnnotations([finding({ side: undefined })], DIFF);

    expect(unannotated).toEqual([]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].start_line).toBe(2);
  });

  it("drops the findings that cannot be annotated and names them instead", () => {
    const cases: [string, PublishedFinding][] = [
      ["a removed line", finding({ side: "LEFT" })],
      ["a line the head file does not have", finding({ line: 4 })],
      ["no position", finding({ file: undefined, line: undefined, side: undefined })],
    ];
    for (const [what, dropped] of cases) {
      const { annotations, unannotated } = toAnnotations([dropped], DIFF);
      expect(annotations, what).toEqual([]);
      expect(unannotated, what).toHaveLength(1);
    }
  });

  it("publishes a repeated finding once and does not name it twice", () => {
    const { annotations, unannotated } = toAnnotations(
      [finding({ body: "same" }), finding({ body: "same" })],
      DIFF,
    );

    expect(annotations).toHaveLength(1);
    expect(unannotated).toEqual([]);
  });

  it("keeps the higher severity when a finding is repeated", () => {
    // What a reader sees must not depend on the order the findings arrived
    // in — whether the finding is an annotation or a line in the summary.
    const orders = [
      ["CRITICAL", "WARN"],
      ["WARN", "CRITICAL"],
    ] as const;
    for (const [first, second] of orders) {
      const annotated = toAnnotations(
        [finding({ severity: first, body: "same" }), finding({ severity: second, body: "same" })],
        DIFF,
      );
      expect(annotated.annotations).toHaveLength(1);
      expect(annotated.annotations[0].annotation_level).toBe("failure");
      expect(annotated.annotations[0].title).toBe("CRITICAL");

      const named = toAnnotations(
        [
          finding({ severity: first, side: "LEFT", body: "same" }),
          finding({ severity: second, side: "LEFT", body: "same" }),
        ],
        DIFF,
      );
      expect(named.annotations).toEqual([]);
      expect(named.unannotated).toHaveLength(1);
      expect(named.unannotated[0].severity).toBe("CRITICAL");
    }
  });

  it("names two findings that share a body when they are not the same finding", () => {
    // A finding on a removed line names a line the head file does not have,
    // so it is named in the summary. Two such findings are two findings,
    // even when their text is the same.
    const { annotations, unannotated } = toAnnotations(
      [
        finding({ file: "a.json", line: 2, side: "LEFT", body: "same" }),
        finding({ file: "b.json", line: 9, side: "LEFT", body: "same" }),
      ],
      DIFF,
    );

    expect(annotations).toEqual([]);
    expect(unannotated.map((entry) => entry.file)).toEqual(["a.json", "b.json"]);
  });
});

describe("createDependencyCheckRun", () => {
  it("creates an in-progress run on the head commit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(response({ id: 5, name: CHECK_RUN_NAME, status: "in_progress" }));
    vi.stubGlobal("fetch", fetchMock);

    const run = await createDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      headSha: "abc123",
    });

    expect(run).toMatchObject({ id: 5 });
    const [request] = requests(fetchMock);
    expect(request.url).toBe("https://api.github.com/repos/owner/repo/check-runs");
    expect(request.method).toBe("POST");
    expect(request.body).toMatchObject({
      head_sha: "abc123",
      name: CHECK_RUN_NAME,
      status: "in_progress",
    });
    expect(request.body.output).toMatchObject({ title: CHECK_OUTPUT_TITLE });
    expect(request.body.output.summary).toBe(CHECK_IN_PROGRESS_SUMMARY);
  });

  it("degrades to a warning when the repository grants no checks permission", async () => {
    // A repository with `contents: read` and `pull-requests: write` but no
    // `checks: write` still gets its review, so the failure is reported and
    // swallowed rather than raised.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ message: "Resource not accessible by integration" }, false, 403),
        ),
    );

    await expect(
      createDependencyCheckRun(new GitHubClient("token"), {
        repo: "owner/repo",
        headSha: "abc123",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not create the check run"));
  });
});

describe("concludeDependencyCheckRun", () => {
  it("concludes the run with the conclusion the findings decide", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5, status: "completed" }));
    vi.stubGlobal("fetch", fetchMock);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [finding({ severity: "CRITICAL" })],
      diff: DIFF,
      summary: "1 breaking change.",
    });

    const [request] = requests(fetchMock);
    expect(request.url).toBe("https://api.github.com/repos/owner/repo/check-runs/5");
    expect(request.method).toBe("PATCH");
    expect(request.body.status).toBe("completed");
    expect(request.body.conclusion).toBe("failure");
    expect(request.body.output.summary).toBe("1 breaking change.");
    expect(request.body.output.annotations).toHaveLength(1);
  });

  it("concludes a run with no findings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [],
      diff: DIFF,
      summary: "No qualifying upgrade.",
    });

    const [request] = requests(fetchMock);
    expect(request.body.conclusion).toBe("success");
    expect(request.body.output.annotations).toBeUndefined();
  });

  it("concludes a failed analysis as a failure whatever the findings say", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [],
      diff: DIFF,
      summary: "The analysis failed.",
      failed: true,
    });

    expect(requests(fetchMock)[0].body.conclusion).toBe("failure");
  });

  it("sends the annotations in chunks of at most fifty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const findings = Array.from({ length: 60 }, (_, index) =>
      finding({ body: `finding ${index}` }),
    );

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings,
      diff: DIFF,
      summary: "60 findings.",
    });

    const sent = requests(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[0].body.output.annotations).toHaveLength(50);
    expect(sent[1].body.output.annotations).toHaveLength(10);
    // Every chunk concludes the run it appends to: a completed update
    // carries a conclusion, and the run is concluded by the first one.
    expect(sent.every((request) => request.body.status === "completed")).toBe(true);
    expect(sent.every((request) => request.body.conclusion === "success")).toBe(true);
  });

  it("names the findings that could not be annotated in the summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [
        finding({ side: "LEFT", body: "foo 2.0.0 removed `create`." }),
        finding({ file: undefined, line: undefined, side: undefined, body: "no position here" }),
      ],
      diff: DIFF,
      summary: "1 breaking change.",
    });

    const summary = String(requests(fetchMock)[0].body.output.summary);
    expect(summary).toContain("1 breaking change.");
    expect(summary).toContain("package.json:2");
    expect(summary).toContain("removed line");
    expect(summary).toContain("WARN");
    expect(summary).toContain("foo 2.0.0 removed `create`.");
    expect(summary).toContain("no position — WARN — no position here");
  });

  it("cuts a message the API would reject", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [finding({ body: "x".repeat(MAX_ANNOTATION_MESSAGE_BYTES + 100) })],
      diff: DIFF,
      summary: "1 finding.",
    });

    const message = String(requests(fetchMock)[0].body.output.annotations[0].message);
    expect(message).toContain("… (truncated)");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(MAX_ANNOTATION_MESSAGE_BYTES);
  });

  it("cuts a message measured in bytes rather than characters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    // Four bytes per character: a message of 20000 characters is 80000
    // bytes, which the API rejects even though its character count fits.
    const body = "😀".repeat(20000);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [finding({ body })],
      diff: DIFF,
      summary: "1 finding.",
    });

    const message = String(requests(fetchMock)[0].body.output.annotations[0].message);
    expect(message).toContain("… (truncated)");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(MAX_ANNOTATION_MESSAGE_BYTES);
    // A cut that fell inside a surrogate pair would leave a broken
    // character behind, which does not survive a round trip through UTF-8.
    expect(Buffer.from(message, "utf8").toString("utf8")).toBe(message);
  });

  it("keeps the unannotated findings when the caller's summary is too long", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 5 }));
    vi.stubGlobal("fetch", fetchMock);

    await concludeDependencyCheckRun(new GitHubClient("token"), {
      repo: "owner/repo",
      id: 5,
      findings: [finding({ side: "LEFT", body: "foo 2.0.0 removed `create`." })],
      diff: DIFF,
      summary: "x".repeat(MAX_CHECK_SUMMARY_BYTES + 100),
    });

    const summary = String(requests(fetchMock)[0].body.output.summary);
    expect(summary).toContain("Findings that could not be annotated");
    expect(summary).toContain("foo 2.0.0 removed `create`.");
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(MAX_CHECK_SUMMARY_BYTES);
  });

  it("degrades to a warning when the repository grants no checks permission", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ message: "Resource not accessible by integration" }, false, 403),
        ),
    );

    await expect(
      concludeDependencyCheckRun(new GitHubClient("token"), {
        repo: "owner/repo",
        id: 5,
        findings: [finding()],
        diff: DIFF,
        summary: "1 breaking change.",
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not conclude the check run"));
  });

  it("reports a chunk that failed after the run was concluded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 5 }))
      .mockResolvedValueOnce(
        response({ message: "Resource not accessible by integration" }, false, 403),
      );
    vi.stubGlobal("fetch", fetchMock);
    const findings = Array.from({ length: 60 }, (_, index) =>
      finding({ body: `finding ${index}` }),
    );

    await expect(
      concludeDependencyCheckRun(new GitHubClient("token"), {
        repo: "owner/repo",
        id: 5,
        findings,
        diff: DIFF,
        summary: "60 findings.",
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not conclude the check run"));
    // The first chunk was published before the second one failed.
    expect(requests(fetchMock)).toHaveLength(2);
  });
});
