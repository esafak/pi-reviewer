import { readFile } from "node:fs/promises";
import { log } from "./log.js";
import { resolveProviderApiKey } from "./review.js";
import { isShardRequest } from "./shard-protocol.js";
import { runShardReview, toShardEnvelope } from "./shard-runner.js";
import { writeShardEnvelope } from "./shard-fanout.js";

async function main(): Promise<void> {
  const [inputPath, outputPath] = process.argv.slice(-2);
  if (!inputPath || !outputPath) throw new Error("Expected input and output paths");
  const parsed: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  if (!isShardRequest(parsed)) throw new Error("Invalid shard request");
  // Single channel for the thinking trace: the request owns the path. Assign
  // (or clear) the env var before session setup so the child's write goes to
  // the shard file and can never clobber the parent's artifact.
  if (parsed.tracing) process.env.PI_REVIEWER_THINKING_ARTIFACT = parsed.tracing.artifactPath;
  else delete process.env.PI_REVIEWER_THINKING_ARTIFACT;
  const slash = parsed.model.indexOf("/");
  const provider = slash > 0 ? parsed.model.slice(0, slash) : "";
  const envelope = await (async () => {
    try {
      const result = await runShardReview(
        parsed,
        {
          logger: log,
          getApiKey: async () => {
            const key = resolveProviderApiKey(provider, process.env.PI_API_KEY);
            if (!key) throw new Error(`No API key is set for provider "${provider}".`);
            return key;
          },
          githubToken: process.env.GITHUB_TOKEN,
        },
        { target: "comment", suppressCodeExec: true },
      );
      return toShardEnvelope(parsed.index, result);
    } catch (error) {
      return {
        index: parsed.index,
        status: "error" as const,
        decision: "none" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  await writeShardEnvelope(outputPath, envelope);
  if (envelope.status !== "ok") {
    console.error("Shard review failed", envelope.error ?? "unknown error");
    process.exitCode = 1;
  }
}

main().then(
  () => {},
  (error: unknown) => {
    console.error("Shard review failed", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
