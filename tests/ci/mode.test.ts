import { describe, expect, it } from "vite-plus/test";

import { IMPLEMENTED_MODES, MODES, assertModeImplemented, parseMode } from "../../src/ci/mode.js";

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

  it("throws for a mode that is understood but not implemented", () => {
    expect(() => assertModeImplemented("dependency")).toThrow(/not available/);
  });

  it("tracks the implemented set", () => {
    expect(IMPLEMENTED_MODES).toContain("review");
    expect(MODES).toEqual(["review", "dependency"]);
  });
});
