import { describe, expect, it } from "vite-plus/test";

import { severityFromFindingBody } from "../../src/core/severity.js";

describe("severityFromFindingBody", () => {
  it("reads the badge the reviewer renders at the top of a finding", () => {
    expect(severityFromFindingBody("🔴 the base image tag does not exist")).toBe("CRITICAL");
    expect(severityFromFindingBody("🟡 handle the empty list")).toBe("WARN");
    expect(severityFromFindingBody("🔵 prefer a constant")).toBe("INFO");
  });

  it("skips the hidden markers that precede the badge", () => {
    expect(
      severityFromFindingBody(
        '<!-- pi-reviewer:finding:v1 -->\n<!-- pi-reviewer:re-raise:v1 {"a":1} -->\n🔴 duplicated',
      ),
    ).toBe("CRITICAL");
  });

  it("ignores a badge that is not the leading token", () => {
    expect(severityFromFindingBody("**src/a.ts:1**\n\n🔴 buried")).toBeUndefined();
    expect(severityFromFindingBody("no badge at all")).toBeUndefined();
  });

  it("returns undefined for an absent body", () => {
    expect(severityFromFindingBody(undefined)).toBeUndefined();
    expect(severityFromFindingBody(null)).toBeUndefined();
    expect(severityFromFindingBody("")).toBeUndefined();
  });
});
