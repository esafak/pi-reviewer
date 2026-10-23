/**
 * The shape of a GitHub repository identifier.
 *
 * The research tool reads a repository by its owner and its name, and it
 * refuses anything outside these shapes before it makes a request. The
 * resolver builds candidates from metadata other people wrote, so it holds
 * them to the same contract: a candidate the reader would refuse is not a
 * location the model can open.
 */

/** The owner pattern the research tool accepts. */
export const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/** The repository name pattern the research tool accepts. */
export const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Whether an owner and a repository name are a repository the tool reads. */
export function isGitHubRepository(owner: string, name: string): boolean {
  return GITHUB_OWNER_PATTERN.test(owner) && GITHUB_REPOSITORY_PATTERN.test(name);
}
