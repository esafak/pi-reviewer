const allowed: Record<string, readonly string[]> = {
  pr: ["view", "list", "diff", "status", "checks"],
  issue: ["view", "list", "status"],
  repo: ["view"],
  run: ["view", "list"],
  workflow: ["view", "list"],
  release: ["view", "list"],
  search: ["repos", "code", "prs", "issues"],
  api: [],
};
// Intentionally over-broad for read subcommands: mutation-capable flags stay blocked even if a CLI version starts accepting them.
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
  "--silent",
  "--confirm",
  "--approve",
  "--request-review",
  "--assign",
  "--label",
  "--milestone",
  "--project",
  "--draft",
  "--publish",
  "--merge",
  "--auto",
  "--admin",
  "-f",
  "-F",
  "-w",
]);

export function validateGhArgs(args: string[]): string | undefined {
  if (
    !Array.isArray(args) ||
    args.length < 2 ||
    args.length > 64 ||
    args.some((a) => typeof a !== "string" || a.length > 2048 || /[\0\r\n]/.test(a))
  )
    return "Invalid gh arguments";
  const [group, command] = args;
  if (!Object.hasOwn(allowed, group!) || (group !== "api" && !allowed[group!]?.includes(command!)))
    return "gh command is not allowed";
  if (group === "api" && command!.startsWith("-")) return "gh api endpoint is required";
  let method = "GET";
  if (args.some((a) => /[;&|`$<>]/.test(a))) return "Mutation or shell syntax is not allowed";
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg.split("=", 1)[0]!.toLowerCase();
    if (
      mutationFlags.has(flag) ||
      /^-[fFw]/.test(arg) ||
      [...mutationFlags].some((m) => m.startsWith("--") && flag.startsWith(`${m}-`))
    )
      return "Mutation flags are not allowed";
    if (group === "api" && (arg === "--method" || arg.startsWith("--method="))) {
      method = arg === "--method" ? (args[++i] ?? "") : arg.slice("--method=".length);
    } else if (group === "api" && arg === "-X") {
      method = args[++i] ?? "";
    } else if (group === "api" && arg.startsWith("-X")) {
      method = arg.startsWith("-X=") ? arg.slice(3) : arg.slice(2);
    } else if (
      arg === "-f" ||
      arg.startsWith("-f=") ||
      arg === "--input" ||
      arg.startsWith("--input=")
    ) {
      return "Only read-only GET API calls are allowed";
    }
  }
  if (group === "api") {
    if (method.toUpperCase() !== "GET") return "Only read-only GET API calls are allowed";
  } else if (
    args.some(
      (a) => a === "-X" || a.startsWith("-X") || a === "--method" || a.startsWith("--method="),
    )
  ) {
    return "HTTP method flags are only allowed for gh api";
  }
  return undefined;
}
