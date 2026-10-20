/** Command groups the transport may invoke. */
type GhGroup = "pr" | "issue" | "repo" | "run" | "workflow" | "release" | "search" | "api";
const allowed: Record<GhGroup, readonly string[]> = {
  pr: ["view", "list", "diff", "checks"],
  issue: ["view", "list", "status"],
  repo: ["view"],
  run: ["view", "list"],
  workflow: ["view", "list"],
  release: ["view", "list"],
  search: ["repos", "code", "prs", "issues"],
  api: [],
};
/** The exact group and command pairs the transport may invoke. */
type GhCommand =
  | "search repos"
  | "search code"
  | "search prs"
  | "search issues"
  | "run list"
  | "workflow list"
  | "release list"
  | "repo view"
  | "pr view"
  | "issue view"
  | "pr diff"
  | "pr checks"
  | "run view";
/** The flags the transport knows. */
type GhFlag =
  | "--all"
  | "--assignee"
  | "--attempt"
  | "--author"
  | "--branch"
  | "--draft"
  | "--event"
  | "--exclude-drafts"
  | "--exclude-pre-releases"
  | "--exit-status"
  | "--jq"
  | "--json"
  | "--label"
  | "--language"
  | "--limit"
  | "--log"
  | "--match"
  | "--merged"
  | "--milestone"
  | "--name-only"
  | "--order"
  | "--project"
  | "--repo"
  | "--sort"
  | "--state"
  | "--status"
  | "--workflow";
interface GhCommandProfile {
  /** Flags this command accepts, and whether each takes a value. */
  flags: Readonly<Partial<Record<GhFlag, "value" | "boolean">>>;
  /** The exact `--json` field lists this command accepts. */
  json?: readonly string[];
}
/** The spec for a flag the command accepts, or undefined when it does not. */
function flagSpec(
  profile: GhCommandProfile | undefined,
  flag: string,
): "value" | "boolean" | undefined {
  if (!profile || !Object.hasOwn(profile.flags, flag)) return undefined;
  return profile.flags[flag as GhFlag];
}
// Typed inputs are converted to fixed argv by the client; this layer verifies command, flag, and value combinations.
const commands: Record<GhCommand, GhCommandProfile> = {
  "search repos": {
    flags: {
      "--limit": "value",
      "--json": "value",
      "--jq": "value",
      "--language": "value",
      "--match": "value",
      "--sort": "value",
      "--order": "value",
    },
    json: ["name,fullName,description,url,visibility,defaultBranch"],
  },
  "search code": {
    flags: {
      "--limit": "value",
      "--json": "value",
      "--jq": "value",
      "--language": "value",
      "--match": "value",
    },
    json: ["path,repository,url"],
  },
  "search prs": {
    flags: {
      "--limit": "value",
      "--json": "value",
      "--jq": "value",
      "--state": "value",
      "--merged": "boolean",
      "--draft": "boolean",
      "--label": "value",
      "--assignee": "value",
      "--author": "value",
      "--milestone": "value",
      "--project": "value",
      "--language": "value",
      "--match": "value",
      "--sort": "value",
      "--order": "value",
    },
    json: ["number,title,state,url,repository,updatedAt"],
  },
  "search issues": {
    flags: {
      "--limit": "value",
      "--json": "value",
      "--jq": "value",
      "--state": "value",
      "--label": "value",
      "--assignee": "value",
      "--author": "value",
      "--milestone": "value",
      "--project": "value",
      "--language": "value",
      "--match": "value",
      "--sort": "value",
      "--order": "value",
    },
    json: ["number,title,state,url,repository,updatedAt"],
  },
  "run list": {
    flags: {
      "--limit": "value",
      "--json": "value",
      "--jq": "value",
      "--workflow": "value",
      "--branch": "value",
      "--status": "value",
      "--event": "value",
    },
    json: ["databaseId,name,status,conclusion,url,headBranch,headSha"],
  },
  "workflow list": {
    flags: { "--json": "value", "--jq": "value", "--all": "boolean" },
    json: ["id,name,state,path"],
  },
  "release list": {
    flags: {
      "--limit": "value",
      "--json": "value",
      "--jq": "value",
      "--exclude-drafts": "boolean",
      "--exclude-pre-releases": "boolean",
      "--order": "value",
    },
    json: ["tagName,name,isDraft,isLatest,publishedAt"],
  },
  "repo view": {
    flags: { "--json": "value" },
    json: [
      "name,nameWithOwner,description,url,visibility,defaultBranchRef",
      // Emitted by the CWD-repo visibility probe for repo-local searches (client.ts); not dead.
      "isPrivate,nameWithOwner,url",
    ],
  },
  "pr view": {
    flags: { "--repo": "value", "--json": "value" },
    json: [
      "number,title,body,state,url,headRefName,baseRefName,updatedAt,isDraft",
      "number,title,body,comments,state,url,headRefName,baseRefName,updatedAt,isDraft",
    ],
  },
  "issue view": {
    flags: { "--repo": "value", "--json": "value" },
    json: [
      "number,title,body,state,url,updatedAt",
      "number,title,body,comments,state,url,updatedAt",
    ],
  },
  "pr diff": { flags: { "--repo": "value", "--name-only": "boolean" } },
  "pr checks": { flags: { "--repo": "value", "--json": "value" }, json: ["name,state,workflow"] },
  "run view": {
    flags: {
      "--repo": "value",
      "--json": "value",
      "--log": "boolean",
      "--exit-status": "boolean",
      "--attempt": "value",
    },
    json: ["databaseId,name,status,conclusion,url,headBranch,headSha"],
  },
};
const mutationFlags = new Set([
  "--add",
  "--remove",
  "--delete",
  "--edit",
  "--close",
  "--create",
  "--web",
  "--input",
  "--field",
  "--raw-field",
  "--header",
  "--silent",
  "--confirm",
  "--approve",
  "--request-review",
  "--publish",
  "--merge",
  "--auto",
  "--admin",
  "--template",
  "--paginate",
  "--watch",
  "--hostname",
  "-w",
  "-R",
  "-f",
  "-F",
]);
const jqExpressions = new Set([
  ".private",
  "{path:.path,url:.html_url,content:.content}",
  "{id,name,state,path,url,html_url}",
  "{tagName:.tag_name,name,isDraft:.draft,url:.html_url,publishedAt:.published_at}",
  "{number,title,body,html_url,created_at,updated_at,category:.category.name,user:.user.login}",
]);

/** The subcommands a group accepts, or undefined when the group is not allowed. */
function subcommandsFor(group: string): readonly string[] | undefined {
  return Object.hasOwn(allowed, group) ? allowed[group as GhGroup] : undefined;
}

/** The profile for a group and command pair, or undefined when the pair is not allowed. */
function profileFor(group: string, command: string): GhCommandProfile | undefined {
  const key = `${group} ${command}`;
  return Object.hasOwn(commands, key) ? commands[key as GhCommand] : undefined;
}

/** The flags whose values are drawn from a fixed set. */
type GhEnumFlag = "--state" | "--match" | "--order" | "--status" | "--sort";

export function validateGhArgs(args: string[]): string | undefined {
  if (
    !Array.isArray(args) ||
    args.length < 2 ||
    args.length > 64 ||
    args.some((a) => typeof a !== "string" || a.length > 2048 || /[\0\r\n]/.test(a))
  )
    return "Invalid gh arguments";
  const [group, command] = args;
  const subcommands = subcommandsFor(group!);
  if (!subcommands || (group !== "api" && !subcommands.includes(command!)))
    return "gh command is not allowed";
  if (group === "api" && command!.startsWith("-")) return "gh api endpoint is required";
  if (args.some((a) => /[;&|`$<>]/.test(a))) return "Mutation or shell syntax is not allowed";
  let method = "GET";
  const profile =
    group === "api" ? { flags: { "--jq": "value" as const } } : profileFor(group!, command!);
  if (!profile && group !== "api") return "gh command profile is not allowed";
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=", 1)[0]!.toLowerCase();
    if (mutationFlags.has(flag) || /^-[fFwR]/.test(arg) || flag.startsWith("--hostname"))
      return "Mutation or unsafe flags are not allowed";
    if (group === "api" && (arg === "--method" || arg.startsWith("--method="))) {
      method = arg === "--method" ? (args[++i] ?? "") : arg.slice("--method=".length);
      continue;
    }
    if (group === "api" && (arg === "-X" || arg.startsWith("-X"))) {
      method =
        arg === "-X" ? (args[++i] ?? "") : arg.startsWith("-X=") ? arg.slice(3) : arg.slice(2);
      continue;
    }
    if (
      group === "api" &&
      (arg === "--input" || arg.startsWith("--input=") || arg === "-f" || arg.startsWith("-f="))
    )
      return "Only read-only GET API calls are allowed";
    if (arg.startsWith("-")) {
      const spec = flagSpec(profile, flag);
      if (!spec) return `Flag ${flag} is not allowed for this command`;
      if (spec === "boolean" && arg.includes("=")) return `Unexpected value for ${flag}`;
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : spec === "value"
          ? args[++i]
          : undefined;
      if (spec === "value" && (!value || value.startsWith("-"))) return `Missing value for ${flag}`;
      if (flag === "--repo" && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value!))
        return "Repository argument is invalid";
      const enumValues: Record<GhEnumFlag, readonly string[]> = {
        "--state": ["open", "closed"],
        "--match":
          group === "search" && command === "repos"
            ? ["name", "description", "readme"]
            : command === "code"
              ? ["file", "path"]
              : ["title", "body", "comments"],
        "--order": ["asc", "desc"],
        "--status": [
          "queued",
          "completed",
          "in_progress",
          "requested",
          "waiting",
          "pending",
          "action_required",
          "cancelled",
          "failure",
          "neutral",
          "skipped",
          "stale",
          "startup_failure",
          "success",
          "timed_out",
        ],
        "--sort":
          command === "repos"
            ? ["forks", "help-wanted-issues", "stars", "updated"]
            : ["comments", "created", "interactions", "reactions", "updated"],
      };
      // The flag is a runtime string; only the flags in the table have a
      // fixed set of values.
      const allowedValues = enumValues[flag as GhEnumFlag];
      if (allowedValues && !allowedValues.includes(value!)) return `Invalid value for ${flag}`;
      if (flag === "--attempt" && (!/^[1-9][0-9]{0,3}$/.test(value!) || Number(value) > 1000))
        return "Run attempt is invalid";
      if (
        flag === "--branch" &&
        (value!.length > 256 ||
          !/^[A-Za-z0-9._/-]+$/.test(value!) ||
          value!.startsWith("-") ||
          value!.includes("..") ||
          value!.endsWith("/") ||
          value!.includes("//"))
      )
        return "Branch ref is invalid";
      if (
        ["--label", "--assignee", "--author"].includes(flag) &&
        (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value!) ||
          value!.length > (flag === "--label" ? 50 : 39))
      )
        return `Invalid value for ${flag}`;
      if (
        flag === "--workflow" &&
        (!/^[A-Za-z0-9._ /-]{1,100}$/.test(value!) ||
          value!.startsWith("-") ||
          value!.includes(".."))
      )
        return "Workflow is invalid";
      if (flag === "--language" && !/^[A-Za-z0-9+#.-]{1,40}$/.test(value!))
        return "Language is invalid";
      if (flag === "--event" && !/^[a-z][a-z0-9_]{0,39}$/.test(value!)) return "Event is invalid";
      if (
        flag === "--milestone" &&
        (value!.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9_. -]*$/.test(value!))
      )
        return "Milestone is invalid";
      if (flag === "--project" && !/^[A-Za-z0-9-]+\/[1-9][0-9]*$/.test(value!))
        return "Project is invalid";
      if (flag === "--limit" && !/^[1-5]$/.test(value!)) return "Result limit is invalid";
      if (flag === "--json" && !profile?.json?.includes(value!))
        return `JSON fields are not allowed for ${group} ${command}`;
      if (flag === "--jq" && !/^\.\[:[1-5]\]$/.test(value!) && !jqExpressions.has(value!))
        return "jq expression is not allowed";
      continue;
    }
  }
  if (group === "api" && method.toUpperCase() !== "GET")
    return "Only read-only GET API calls are allowed";
  if (
    group !== "api" &&
    args.some(
      (a) => a === "-X" || a.startsWith("-X") || a === "--method" || a.startsWith("--method="),
    )
  )
    return "HTTP method flags are only allowed for gh api";
  return undefined;
}
