import { consoleSink, createLogger } from "../logging/index.js";

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
