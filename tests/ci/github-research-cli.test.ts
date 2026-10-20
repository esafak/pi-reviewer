import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { ghCommandProfiles } from "../../src/ci/github-research/gh-allowlist.js";

/**
 * The transport's contract with the `gh` binary, checked against the binary's
 * own answers.
 *
 * `gh <command> --json` prints the fields the command supports, and
 * `gh <command> --help` tells us whether the flags we send are still
 * accepted. Both are answered locally, before any request, so the check needs
 * no token and no network.
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

const ghAvailable = (() => {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: GH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
})();

const runGh = (args: string[]): string => {
  try {
    return execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
  } catch (error) {
    // gh answers a usage error with a nonzero exit and the explanation on
    // stderr; that explanation is the answer, not a failure.
    const stderr = (error as { stderr?: string }).stderr;
    return typeof stderr === "string" ? stderr : String(error);
  }
};

/**
 * Whether the command still accepts the flags the transport sends.
 *
 * Asking is more durable than reading: `gh <command> --<flag> --help`
 * answers `unknown flag: --<flag>` for a flag that is gone, and prints the
 * help for one that is not. A flag that is recognised but given a bad value
 * says so instead, which still proves it is recognised.
 */
const acceptsFlags = (command: string, flags: readonly string[]): string | undefined => {
  const output = runGh([...command.split(" "), ...flags, "--help"]);
  const unknown = output.match(/unknown flag:?\s*(--[\w-]+)/i);
  return unknown ? unknown[1] : undefined;
};

/**
 * The fields the command supports, from the usage error it answers with.
 *
 * The list is one field per line, after a header line. A format the parser
 * does not recognise yields no fields, which fails the check rather than
 * quietly passing it.
 */
const supportedFields = (command: string): Set<string> => {
  const output = runGh([...command.split(" "), "--json"]);
  const fields = new Set<string>();
  for (const line of output.split("\n").slice(1)) {
    const field = line.trim();
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(field)) fields.add(field);
  }
  if (fields.size === 0)
    throw new Error(
      `gh ${command} --json did not list the fields it supports: ${output.slice(0, 200)}`,
    );
  return fields;
};

describe.skipIf(!ghAvailable)("gh CLI contract", () => {
  for (const [command, profile] of Object.entries(ghCommandProfiles)) {
    it(`${command} still accepts the flags the transport sends`, () => {
      const unknown = acceptsFlags(command, Object.keys(profile.flags));
      expect(unknown, `${command} no longer accepts ${unknown ?? "its flags"}`).toBeUndefined();
    });
    if (!profile.json) continue;
    it(`${command} still supports the fields the transport requests`, () => {
      const fields = supportedFields(command);
      for (const list of profile.json)
        for (const field of list.split(","))
          expect(fields.has(field), `${command} no longer supports the field ${field}`).toBe(true);
    });
  }
  it("the api group still accepts --jq", () => {
    expect(acceptsFlags("api", ["--jq"])).toBeUndefined();
  });
});
