import { describe, expect, it, vi } from "vite-plus/test";

import { escapeWorkflowCommand, formatLog } from "../../src/logging/formatter.js";
import { createLogger, createMemorySink } from "../../src/logging/logger.js";

describe("structured logger", () => {
  it("captures named fields as data without imposing their key order", () => {
    const { sink, records } = createMemorySink();
    const logger = createLogger({ sink });
    logger.info("review.diff.resolved", "Diff resolved", { source: "merge-base", size: 42 });

    expect(records).toEqual([
      {
        level: "info",
        event: "review.diff.resolved",
        message: "Diff resolved",
        fields: { size: 42, source: "merge-base" },
      },
    ]);
  });

  it("formats action-failing errors as annotations and escapes dynamic command content", () => {
    const result = formatLog(
      {
        level: "error",
        event: "action.failed",
        message: "Action failed",
        fields: { error: "a%\nb" },
      },
      {
        target: "github",
        color: true,
        prefix: "pi-reviewer",
        annotations: { "action.failed": "error" },
      },
    );

    expect(result.stream).toBe("stderr");
    expect(result.text).toBe("::error::[pi-reviewer] ERROR Action failed error=a%25%0Ab");
  });

  it("renders local text without ANSI or workflow syntax", () => {
    expect(
      formatLog(
        { level: "warn", event: "test.warning", message: "Careful", fields: {} },
        { target: "local", prefix: "app" },
      ),
    ).toEqual({ stream: "stderr", text: "[app] Careful" });
  });

  it("does not turn every GitHub warning into an annotation", () => {
    expect(
      formatLog(
        { level: "warn", event: "search.web.failed", message: "Search failed", fields: {} },
        {
          target: "github",
          color: true,
          prefix: "pi-reviewer",
          annotations: { "action.failed": "error" },
        },
      ).text,
    ).toContain("\u001b[33m[pi-reviewer] WARN Search failed\u001b[0m");
  });

  it("colors equals-delimited fields and JSON keys/values with distinct palettes", () => {
    const output = formatLog(
      {
        level: "debug",
        event: "review.tool.call",
        message: "Tool call",
        fields: { tool: "github_read", args: '{"kind":"pull_request","number":1}' },
      },
      { target: "github", color: true },
    ).text;

    expect(output).toContain("\u001b[94margs\u001b[0m=");
    expect(output).toContain('"\u001b[95mkind\u001b[0m":"\u001b[32mpull_request\u001b[0m"');
    expect(output).toContain('"\u001b[95mnumber\u001b[0m":\u001b[33m1\u001b[0m');
    expect(output).toContain("\u001b[94mtool\u001b[0m=\u001b[32mgithub_read\u001b[0m");
  });

  it("escapes GitHub line breaks in ordinary log records without rewriting percents", () => {
    const output = formatLog(
      {
        level: "warn",
        event: "reply.failed",
        message: "Reply failed\n::warning::injected",
        fields: { error: "first\r\n::error::forged%" },
      },
      { target: "github", color: true },
    ).text;

    expect(output).not.toContain("\n");
    expect(output).toContain("WARN Reply failed%0A::warning::injected");
    expect(output).toContain("first%0D%0A::error::forged%");
  });

  it("keeps multiline GitHub groups line-prefixed instead of flattening them", () => {
    expect(
      formatLog(
        {
          level: "info",
          event: "review.fallback.content",
          message: "Assistant response",
          fields: { content: "first\n::warning::not-a-command" },
          kind: "group",
        },
        { target: "github", color: true },
      ).text,
    ).toBe("::group::Assistant response\n| first\n| ::warning::not-a-command\n::endgroup::");
  });

  it("escapes workflow command delimiters", () => {
    expect(escapeWorkflowCommand("x%\r\ny")).toBe("x%25%0D%0Ay");
  });

  it("routes levels to their established console streams", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createLogger();
      logger.debug("test.debug", "debug");
      logger.info("test.info", "info");
      logger.warn("test.warn", "warn");
      logger.error("test.error", "error");
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
