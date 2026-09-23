import type { GitHubResearchScope } from "./client.js";

export interface GitHubResearchConfig {
  scope: GitHubResearchScope;
  token: string;
}

export function resolveGitHubResearchConfig(
  env: NodeJS.ProcessEnv = process.env,
  token = env.GITHUB_TOKEN,
): GitHubResearchConfig | undefined {
  if (env.PI_REVIEWER_GITHUB_RESEARCH !== "true") return undefined;
  const scope = env.PI_REVIEWER_GITHUB_SCOPE || "public";
  if ((scope !== "public" && scope !== "token-accessible") || !token) return undefined;
  return { scope, token };
}

export function unavailableGitHubResearchWarnings(
  env: NodeJS.ProcessEnv = process.env,
  token = env.GITHUB_TOKEN,
): string[] {
  if (env.PI_REVIEWER_GITHUB_RESEARCH !== "true") return [];
  if (!token) return ["GitHub research is unavailable (a GitHub token is required)"];
  const scope = env.PI_REVIEWER_GITHUB_SCOPE;
  if (scope && scope !== "public" && scope !== "token-accessible")
    return ["GitHub research is unavailable (scope must be public or token-accessible)"];
  return [];
}
