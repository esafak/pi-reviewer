import { consoleSink, createLogger } from "../logging/index.js";
import type { Logger } from "../logging/index.js";

const githubActions = process.env.GITHUB_ACTIONS === "true";

export const log = createLogger({
  sink: consoleSink({
    target: githubActions ? "github" : "local",
    color:
      process.env.NO_COLOR === undefined &&
      (githubActions || process.env.FORCE_COLOR !== undefined),
    prefix: githubActions ? undefined : "pi-reviewer",
    annotations: {
      "action.configuration.missing": "error",
      "action.failed": "error",
    },
  }),
});

export function logAssistantFallback(content: string, logger: Logger = log): void {
  logger.group(
    "review.text_fallback.content",
    "Pi Reviewer raw assistant response (text fallback)",
    content,
  );
}
