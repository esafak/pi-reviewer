/**
 * Whether the reader is enabled for this run.
 *
 * The input is read from the environment the action maps it into, so the
 * reader's registration and this answer come from the same switch. The
 * reader is off by default: it is the only tool in the action that can reach
 * an arbitrary host.
 */
export function isUrlReaderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_REVIEWER_URL_READER === "true";
}
