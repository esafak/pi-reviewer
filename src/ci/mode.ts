/**
 * The action's check modes.
 *
 * A mode names the kind of check the action performs, not the workflow that
 * triggered it. Which pull requests reach a mode is the caller's decision:
 * the action never chooses whether a pull request is checked, only how.
 */
export type Mode = "review" | "dependency";

export const MODES: readonly Mode[] = ["review", "dependency"];

/**
 * The modes this build can run. A mode that is understood but not
 * implemented is a hard error: silently running a different check than the
 * one that was asked for is worse than failing.
 */
export const IMPLEMENTED_MODES: readonly Mode[] = ["review"];

/**
 * Parses the `mode` input. An absent or blank value is the default mode.
 * The value is trimmed and lowercased, so indentation mistakes in a workflow
 * file do not fail; an unrecognized value throws, because a typo must not
 * quietly run the wrong check.
 */
export function parseMode(raw: string | undefined): Mode {
  const value = raw?.trim().toLowerCase();
  if (!value) return "review";
  if ((MODES as readonly string[]).includes(value)) return value as Mode;
  throw new Error(`Invalid mode "${raw}" — expected one of: ${MODES.join(", ")}`);
}

export function assertModeImplemented(mode: Mode): void {
  if (!IMPLEMENTED_MODES.includes(mode))
    throw new Error(`Mode "${mode}" is not available in this build.`);
}
