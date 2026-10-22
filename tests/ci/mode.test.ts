import { describe, expect, it } from "vite-plus/test";

import {
  IMPLEMENTED_MODES,
  MODES,
  assertModeImplemented,
  parseMode,
  type Mode,
} from "../../src/ci/mode.js";

describe("parseMode", () => {
  it("defaults to review when the value is absent", () => {
    expect(parseMode(undefined)).toBe("review");
  });

  it("defaults to review when the value is blank", () => {
    expect(parseMode("")).toBe("review");
    expect(parseMode("   ")).toBe("review");
  });

  it("reads the known modes", () => {
    expect(parseMode("review")).toBe("review");
    expect(parseMode("dependency")).toBe("dependency");
  });

  it("trims and lowercases the value", () => {
    expect(parseMode("  Dependency  ")).toBe("dependency");
    expect(parseMode("REVIEW")).toBe("review");
  });

  it("throws on an unknown mode", () => {
    expect(() => parseMode("deps")).toThrow(/Invalid mode/);
  });
});

describe("assertModeImplemented", () => {
  it("accepts an implemented mode", () => {
    expect(() => assertModeImplemented("review")).not.toThrow();
  });

  it("accepts every mode this build can run", () => {
    for (const mode of MODES) expect(() => assertModeImplemented(mode)).not.toThrow();
  });

  it("throws for a mode the build does not list", () => {
    // The union is closed, so only a cast can name a mode this build does not
    // implement; the guard is what turns such a value into a loud failure.
    expect(() => assertModeImplemented("ledger" as Mode)).toThrow(/not available/);
  });

  it("tracks the implemented set", () => {
    // The concrete set, not `MODES`: a mode can be understood and not
    // implemented, and then the guard below is what must catch it — not this
    // assertion.
    expect(IMPLEMENTED_MODES).toEqual(["review", "dependency"]);
    expect(MODES).toEqual(["review", "dependency"]);
  });
});
