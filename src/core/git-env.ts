// Git subprocesses that mean "operate on cwd" must not inherit repository
// redirection from the parent environment. Hooks and tooling set these,
// which would otherwise retarget temp-fixture repositories at the wrong root.
const REDIRECT_VARS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
];

export function gitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (REDIRECT_VARS.includes(key)) continue;
    env[key] = value;
  }
  return env;
}
