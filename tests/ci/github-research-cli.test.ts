import { describe, expect, it } from "vite-plus/test";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
  ghCommandProfiles,
  MAX_RELEASE_BODY_CHARS,
  MAX_RELEASE_NAME_CHARS,
  RELEASE_JQ_EXPRESSION,
} from "../../src/ci/github-research/gh-allowlist.js";

/**
 * The transport's contract with the `gh` binary, checked against the binary's
 * own answers.
 *
 * `gh <command> --json` prints the fields the command supports, and
 * `gh <command> --help --<flag>` tells us whether the command still accepts a
 * flag: a flag that is gone answers `unknown flag: --<flag>`, and one that is
 * not is either printed with the help or reported as unusable. Both are
 * answered locally, before any request, so the check needs no token and no
 * network.
 *
 * The contract itself is the allowlist's command profiles: the flags the
 * transport accepts and the `--json` field lists it sends. There is no second
 * list to keep in step.
 *
 * The binary checked is whatever `gh` is on the runner — the same one the
 * action uses at runtime, which prefers the installed CLI over fetching one.
 * A runner without `gh` skips the file rather than failing it.
 */
const GH_TIMEOUT_MS = 10_000;
const UNKNOWN_FLAG = "--zzz-not-a-real-flag";

const execFileAsync = promisify(execFile);

const ghAvailable = (() => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: GH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
})();

interface Outcome {
  output: string;
  exitCode: number | null;
  /** The command did not answer: it timed out, or could not be run. */
  unresponsive: boolean;
  /** The failure itself, for the cases that carry no output. */
  failure?: string;
}
const runGh = async (args: string[]): Promise<Outcome> => {
  try {
    const { stdout, stderr } = await execFileAsync("gh", args, { timeout: GH_TIMEOUT_MS });
    return { output: `${stdout}${stderr}`, exitCode: 0, unresponsive: false };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string | null;
      message?: string;
    };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    // A timeout kills the process and a missing binary fails to spawn;
    // neither is an answer about the flag.
    const unresponsive =
      failure.killed === true ||
      (typeof failure.signal === "string" && failure.signal.length > 0) ||
      typeof failure.code === "string";
    return {
      output,
      exitCode: typeof failure.code === "number" ? failure.code : null,
      unresponsive,
      ...(failure.message ? { failure: failure.message } : {}),
    };
  }
};

/** What a probe of one flag found. */
type FlagVerdict = "accepted" | "rejected" | "unknown";

/**
 * A diagnostic that shows the flag was parsed but could not be used: the
 * parser names the flag it had no value for, or rejected the value it was
 * given.
 */
const ARGS_DIAGNOSTIC =
  /flag needs an argument|argument required when using|invalid argument|without specifying/i;
/** The diagnostic the `--json` flag answers with when it has no field list. */
const JSON_DIAGNOSTIC = /comma-separated fields|Unknown JSON field/i;

/**
 * Whether a line names the flag as a token of its own.
 *
 * A token, not a substring: `--limit` is not named by `--limit-per-page`.
 */
const namesFlag = (line: string, flag: string): boolean =>
  line.split(/[\s"'`:,()]+/).some((token) => token === flag);
/** Whether a line carries a diagnostic that names the flag. */
const diagnosesFlag = (output: string, flag: string): boolean =>
  output.split("\n").some((line) => ARGS_DIAGNOSTIC.test(line) && namesFlag(line, flag));
/** Whether the output carries the field-list diagnostic for `--json`. */
const diagnosesJson = (output: string): boolean =>
  output.split("\n").some((line) => JSON_DIAGNOSTIC.test(line));

/**
 * What a probe says about a flag.
 *
 * Only explicit evidence counts. A command that printed its help for the
 * command under test accepted the flag; a parser that named the flag it
 * could not use accepted it too. A command that rejected the flag by name
 * did not. Anything else — a timeout, a spawn failure, an error that merely
 * mentions the flag, wording the parser no longer uses — is no answer, and
 * is reported as such rather than passed over.
 */
const classifyFlag = (outcome: Outcome, command: string, flag: string): FlagVerdict => {
  if (outcome.unresponsive) return "unknown";
  const rejected = outcome.output.match(/unknown flag:?\s*(--[\w-]+)/i)?.[1];
  if (rejected) return rejected === flag ? "rejected" : "unknown";
  if (outcome.exitCode === 0)
    return outcome.output.includes(`gh ${command}`) ? "accepted" : "unknown";
  if (flag === "--json" && diagnosesJson(outcome.output)) return "accepted";
  if (diagnosesFlag(outcome.output, flag)) return "accepted";
  return "unknown";
};

/**
 * Whether the command still accepts the flag.
 *
 * The flag is asked about on its own and last: a value flag consumes the
 * next argument, so a chained invocation would let one flag hide the next,
 * and a typed flag rejects its value before the rest of the line is parsed.
 * Asked last, the flag either parses, or the parser names it — both prove
 * the flag is known — and neither reaches the network.
 */
const probeFlag = async (command: string, flag: string): Promise<FlagVerdict> => {
  const outcome = await runGh([...command.split(" "), "--help", flag]);
  return classifyFlag(outcome, command, flag);
};

/**
 * The fields the command supports, from the usage error it answers with.
 *
 * The list is one field per line, after a header line. A format the parser
 * does not recognise yields no fields, which fails the check rather than
 * quietly passing it.
 */
const supportedFields = async (command: string): Promise<Set<string>> => {
  const outcome = await runGh([...command.split(" "), "--json"]);
  if (outcome.unresponsive)
    throw new Error(
      `gh ${command} --json did not answer: ${outcome.failure ?? outcome.output.slice(0, 200)}`,
    );
  const fields = new Set<string>();
  for (const line of outcome.output.split("\n").slice(1)) {
    const field = line.trim();
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(field)) fields.add(field);
  }
  if (fields.size === 0)
    throw new Error(
      `gh ${command} --json did not list the fields it supports: ${outcome.output.slice(0, 200)}`,
    );
  return fields;
};

describe("gh CLI contract", () => {
  describe("flag verdict", () => {
    const answer = (output: string, exitCode = 1): Outcome => ({
      output,
      exitCode,
      unresponsive: false,
    });
    it("rejects only a diagnostic that names the flag", () => {
      expect(classifyFlag(answer("unknown flag: --limit"), "pr view", "--limit")).toBe("rejected");
      // A rejection that names a different flag says nothing about this one.
      expect(classifyFlag(answer("unknown flag: --other"), "pr view", "--limit")).toBe("unknown");
      // Wording the parser no longer uses is no answer, not a rejection.
      expect(classifyFlag(answer("unrecognized option: --limit"), "pr view", "--limit")).toBe(
        "unknown",
      );
    });
    it("accepts a help response that identifies the command", () => {
      expect(classifyFlag(answer("gh pr view\nUSAGE\n", 0), "pr view", "--repo")).toBe("accepted");
      // A successful command that printed nothing is no answer.
      expect(classifyFlag(answer("", 0), "pr view", "--repo")).toBe("unknown");
    });
    it("accepts a diagnostic that names the flag it could not use", () => {
      expect(classifyFlag(answer("flag needs an argument: --limit"), "pr view", "--limit")).toBe(
        "accepted",
      );
      expect(
        classifyFlag(answer("argument required when using the --repo flag"), "pr view", "--repo"),
      ).toBe("accepted");
      expect(
        classifyFlag(
          answer('invalid argument "--help" for "-L, --limit" flag'),
          "pr view",
          "--limit",
        ),
      ).toBe("accepted");
      // An error that merely mentions the flag is not evidence.
      expect(classifyFlag(answer("could not find --limit"), "pr view", "--limit")).toBe("unknown");
    });
    it("accepts the field diagnostic only for --json", () => {
      const diagnostic = "Specify one or more comma-separated fields for `--json`:";
      expect(classifyFlag(answer(diagnostic), "pr view", "--json")).toBe("accepted");
      expect(classifyFlag(answer(diagnostic), "pr view", "--repo")).toBe("unknown");
    });
    it("treats a command that did not answer as no answer", () => {
      expect(
        classifyFlag({ output: "", exitCode: null, unresponsive: true }, "pr view", "--repo"),
      ).toBe("unknown");
    });
  });

  describe.skipIf(!ghAvailable)("against the installed binary", () => {
    for (const [command, profile] of Object.entries(ghCommandProfiles)) {
      it(`${command} still accepts the flags the transport sends`, async () => {
        const flags = Object.keys(profile.flags);
        const verdicts = await Promise.all(flags.map((flag) => probeFlag(command, flag)));
        const rejected = flags.find((_, index) => verdicts[index] === "rejected");
        expect(rejected, `${command} no longer accepts ${rejected ?? "its flags"}`).toBeUndefined();
        const unknown = flags.find((_, index) => verdicts[index] === "unknown");
        expect(
          unknown,
          `${command} gave no answer about ${unknown ?? "its flags"}`,
        ).toBeUndefined();
      });
      it(`${command} rejects a flag it does not have`, async () => {
        // The probe above is only meaningful if the command still rejects an
        // unknown flag, so the premise is checked rather than assumed.
        expect(await probeFlag(command, UNKNOWN_FLAG)).toBe("rejected");
      });
      if (!profile.json) continue;
      it(`${command} still supports the fields the transport requests`, async () => {
        const fields = await supportedFields(command);
        for (const list of profile.json)
          for (const field of list.split(","))
            expect(fields.has(field), `${command} no longer supports the field ${field}`).toBe(
              true,
            );
      });
    }
    it("the api group still accepts --jq", async () => {
      expect(await probeFlag("api", "--jq")).toBe("accepted");
    });
    it("the api group rejects a flag it does not have", async () => {
      expect(await probeFlag("api", UNKNOWN_FLAG)).toBe("rejected");
    });

    it("the release projection runs in the installed binary", async () => {
      // The projection is the transport's contract with the binary's own jq,
      // so it is checked against that jq rather than against an assumption
      // about it. The document comes from a local server, so the check needs
      // no token and no network.
      const long = "x".repeat(MAX_RELEASE_BODY_CHARS + 10);
      const payload = {
        tag_name: "v1.0",
        name: "Release",
        draft: false,
        html_url: "https://github.com/o/r/releases/tag/v1.0",
        published_at: "2026-10-20T04:13:50Z",
        body: long,
      };
      const headers: string[] = [];
      const server = createServer((request, response) => {
        headers.push(request.headers.authorization ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const outcome = await runGh([
          "api",
          `http://127.0.0.1:${port}/releases/1`,
          "--jq",
          RELEASE_JQ_EXPRESSION,
        ]);
        expect(outcome.exitCode, outcome.output).toBe(0);
        const result = JSON.parse(outcome.output) as Record<string, unknown>;
        expect(result.tagName).toBe("v1.0");
        expect(result.name).toBe("Release");
        expect(result.bodyTruncated).toBe(true);
        expect((result.body as string).length).toBe(MAX_RELEASE_BODY_CHARS);
        // The binary is asked for a local document, and it sends no
        // credentials to it.
        expect(headers).toEqual([""]);
      } finally {
        server.close();
      }
    });

    it("the release projection drops metadata it cannot fit", async () => {
      const payload = {
        tag_name: "v1.0",
        name: "N".repeat(MAX_RELEASE_NAME_CHARS + 1),
        draft: false,
        html_url: "https://github.com/o/r/releases/tag/v1.0",
        published_at: "2026-10-20T04:13:50Z",
        body: "notes",
      };
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const outcome = await runGh([
          "api",
          `http://127.0.0.1:${port}/releases/1`,
          "--jq",
          RELEASE_JQ_EXPRESSION,
        ]);
        expect(outcome.exitCode, outcome.output).toBe(0);
        const result = JSON.parse(outcome.output) as Record<string, unknown>;
        // A field that does not fit is unknown, not shortened.
        expect(result.name).toBeNull();
        expect(result.tagName).toBe("v1.0");
        expect(result.bodyTruncated).toBe(false);
      } finally {
        server.close();
      }
    });
  });
});
