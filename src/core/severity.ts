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
