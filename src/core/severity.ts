/** The severity levels a finding can carry. */
export type Severity = "CRITICAL" | "WARN" | "INFO";

/** The order severities are filtered by, least severe first. */
export const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

/** The badge each severity is rendered with. */
export const SEVERITY_EMOJI: Record<Severity, string> = {
  CRITICAL: "🔴",
  WARN: "🟡",
  INFO: "🔵",
};

/** Narrows an arbitrary value to a severity this version understands. */
export function isSeverity(value: unknown): value is Severity {
  return value === "CRITICAL" || value === "WARN" || value === "INFO";
}

/**
 * Reads back the badge rendered at the top of a posted finding body. Posted
 * inline comments are the only record of a finding's severity once the review
 * run is over, so the badge doubles as that record. Hidden metadata comments
 * precede the badge and must be skipped; an unbadged body stays unknown rather
 * than being guessed at.
 */
export function severityFromFindingBody(body: string | null | undefined): Severity | undefined {
  if (!body) return undefined;
  const visible = body.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/u, "").trimStart();
  for (const [severity, emoji] of Object.entries(SEVERITY_EMOJI) as Array<[Severity, string]>) {
    if (visible.startsWith(emoji)) return severity;
  }
  return undefined;
}
