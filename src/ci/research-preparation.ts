import {
  resolveGitHubResearchConfig,
  type GitHubResearchConfig,
} from "./github-research/config.js";
import { isUrlReaderEnabled } from "./web-fetch/capability.js";

/**
 * Which readers can open a location in this run.
 *
 * A candidate is only usable when the model has a way to read it, and which
 * ways exist is a property of the run rather than an assumption: a tool that
 * was not registered cannot open anything.
 */
export interface ReaderCapabilities {
  /** The GitHub research tools are registered, so a repository is readable. */
  github: boolean;
  /** The bounded URL reader is registered, so an https URL is readable. */
  url: boolean;
}

/** What the run's readers are and how the GitHub research tools are configured. */
export interface ResearchPreparation {
  /** The GitHub research configuration, or undefined when the tools are off. */
  githubResearch?: GitHubResearchConfig;
  /** The readers this run can open a location with. */
  readers: ReaderCapabilities;
}

/** What the preparation needs beyond the environment. */
export interface PrepareResearchOptions {
  /** The token the GitHub research tools authenticate with. */
  token?: string;
}

/**
 * The shared preparation both the review path and the dependency resolver
 * call.
 *
 * The capabilities and the tool registration cannot disagree, because both
 * come from here: the GitHub research configuration is resolved exactly as
 * the review path resolves it, and the URL reader's switch decides the other
 * capability.
 */
export function prepareResearch(
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareResearchOptions = {},
): ResearchPreparation {
  const githubResearch = resolveGitHubResearchConfig(env, options.token);
  return {
    ...(githubResearch ? { githubResearch } : {}),
    readers: { github: Boolean(githubResearch), url: isUrlReaderEnabled(env) },
  };
}
