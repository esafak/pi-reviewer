/**
 * Whether the bounded URL reader is part of this build.
 *
 * The reader and the action input that enables it arrive together, so a
 * build that has the reader says so here rather than promising a tool that
 * is not registered: a location the model cannot open is worse than a
 * location it is never offered.
 */
export const URL_READER_AVAILABLE = false;

/**
 * Whether the reader is enabled for this run.
 *
 * The input is read from the environment the action maps it into, so the
 * reader's registration and this answer come from the same switch. The
 * reader is off by default: it is the only tool in the action that can reach
 * an arbitrary host.
 */
export function isUrlReaderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return URL_READER_AVAILABLE && env.PI_REVIEWER_URL_READER === "true";
}
