import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_MAX_CHARS,
  filterDiff,
  lookupModelLimits,
  MAX_DERIVED_DIFF_CHARS,
  MAX_DIFF_CHARS_ENV_VAR,
  parseMaxDiffChars,
  resolveExplicitMaxDiffChars,
  resolveMaxDiffChars,
  stripNoiseFiles,
} from "../../src/core/diff-filter.js";
import { extractDiffFiles } from "../../src/core/diff-resolver.js";
import { readConfig } from "../../src/core/config.js";

vi.mock("../../src/core/config.js", () => ({
  readConfig: vi.fn(() => ({})),
}));

const readConfigMock = vi.mocked(readConfig);

afterEach(() => {
  vi.unstubAllEnvs();
  readConfigMock.mockReset();
  readConfigMock.mockReturnValue({});
});

function makeDiffSection(file: string, lines = "+"): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${lines}\n`;
}

describe("filterDiff", () => {
  it("passes clean diffs unchanged", () => {
    const raw = makeDiffSection("src/index.ts");
    const { diff, warning } = filterDiff(raw);
    expect(diff).toBe(raw);
    expect(warning).toBeUndefined();
  });

  it("excludes package-lock.json", () => {
    const raw = makeDiffSection("src/index.ts") + makeDiffSection("package-lock.json");
    const { diff, warning } = filterDiff(raw);
    expect(diff).not.toContain("package-lock.json");
    expect(warning).toMatch(/1 noise file excluded/);
    expect(warning).toContain("package-lock.json");
  });

  it("excludes yarn.lock", () => {
    const { diff, warning } = filterDiff(makeDiffSection("yarn.lock"));
    expect(diff.trim()).toBe("");
    expect(warning).toMatch(/yarn\.lock/);
  });

  it("excludes dist/ files", () => {
    const raw = makeDiffSection("src/index.ts") + makeDiffSection("dist/index.js");
    const { diff, warning } = filterDiff(raw);
    expect(diff).not.toContain("dist/index.js");
    expect(warning).toMatch(/dist\/index\.js/);
  });

  it("excludes multiple noise files and lists them", () => {
    const raw =
      makeDiffSection("src/index.ts") +
      makeDiffSection("package-lock.json") +
      makeDiffSection("yarn.lock");
    const { warning } = filterDiff(raw);
    expect(warning).toMatch(/2 noise files excluded/);
  });

  it("skips whole sections when diff exceeds maxChars", () => {
    const sectionA = makeDiffSection("src/a.ts");
    const sectionB = makeDiffSection("src/b.ts");
    const maxChars = sectionA.length + 1; // fits A, not B
    const { diff, warning, skippedFiles } = filterDiff(sectionA + sectionB, maxChars);
    expect(diff).toContain("src/a.ts");
    expect(diff).not.toContain("src/b.ts");
    expect(skippedFiles).toEqual(["src/b.ts"]);
    expect(warning).toMatch(/1 file skipped/);
    expect(warning).toContain("src/b.ts");
  });

  it("never slices a section mid-way", () => {
    const section = makeDiffSection("src/index.ts");
    const maxChars = Math.floor(section.length / 2); // smaller than one section
    const { diff, skippedFiles } = filterDiff(section, maxChars);
    expect(diff).toBe("");
    expect(skippedFiles).toEqual(["src/index.ts"]);
  });

  it("combines noise exclusion and size-skip warnings", () => {
    const sectionA = makeDiffSection("src/index.ts");
    const raw = makeDiffSection("package-lock.json") + sectionA + makeDiffSection("src/big.ts");
    const maxChars = sectionA.length + 1;
    const { warning } = filterDiff(raw, maxChars);
    expect(warning).toMatch(/noise file/);
    expect(warning).toMatch(/skipped/);
  });

  it("uses DEFAULT_MAX_CHARS by default", () => {
    const small = makeDiffSection("src/index.ts");
    const { diff } = filterDiff(small);
    expect(diff.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
  });

  it("selection is skip-and-continue, not a strict prefix", () => {
    // A 150k section followed by an 80k section: at 100k only the second
    // fits; at 200k only the first fits. Selection is not monotonic in the
    // cap, so context must come from the noise-stripped candidate set, never
    // from an intermediate capped pass.
    const big = `diff --git a/src/big.ts b/src/big.ts\n${"x".repeat(150_000)}\n`;
    const small = `diff --git a/src/small.ts b/src/small.ts\n${"y".repeat(80_000)}\n`;
    const at100k = filterDiff(big + small, 100_000);
    expect(at100k.diff).not.toContain("src/big.ts");
    expect(at100k.diff).toContain("src/small.ts");
    const at200k = filterDiff(big + small, 200_000);
    expect(at200k.diff).toContain("src/big.ts");
    expect(at200k.diff).not.toContain("src/small.ts");
  });
});

describe("stripNoiseFiles", () => {
  it("returns candidate sections and excluded noise paths", () => {
    const raw = makeDiffSection("src/index.ts") + makeDiffSection("package-lock.json");
    const { kept, excluded } = stripNoiseFiles(raw);
    expect(kept.join("")).toContain("src/index.ts");
    expect(kept.join("")).not.toContain("package-lock.json");
    expect(excluded).toEqual(["package-lock.json"]);
  });

  it("candidate set covers every file the size filter could keep", () => {
    const big = `diff --git a/src/big.ts b/src/big.ts\n${"x".repeat(150_000)}\n`;
    const small = `diff --git a/src/small.ts b/src/small.ts\n${"y".repeat(80_000)}\n`;
    const candidates = stripNoiseFiles(big + small).kept.join("");
    for (const cap of [100_000, 200_000, 500_000]) {
      const { diff } = filterDiff(big + small, cap);
      for (const file of extractDiffFiles(diff)) {
        expect(candidates).toContain(file);
      }
    }
  });
});

describe("parseMaxDiffChars", () => {
  it("accepts positive integers and numeric strings", () => {
    expect(parseMaxDiffChars(250_000)).toBe(250_000);
    expect(parseMaxDiffChars("250000")).toBe(250_000);
    expect(parseMaxDiffChars("  100 ")).toBe(100);
  });

  it("rejects missing, malformed, fractional, and non-positive input", () => {
    expect(parseMaxDiffChars(undefined)).toBeUndefined();
    expect(parseMaxDiffChars("")).toBeUndefined();
    expect(parseMaxDiffChars("12abc")).toBeUndefined();
    expect(parseMaxDiffChars("3.5")).toBeUndefined();
    expect(parseMaxDiffChars("0")).toBeUndefined();
    expect(parseMaxDiffChars("-5")).toBeUndefined();
    expect(parseMaxDiffChars(0)).toBeUndefined();
    expect(parseMaxDiffChars(-1)).toBeUndefined();
    expect(parseMaxDiffChars(1.5)).toBeUndefined();
    expect(parseMaxDiffChars(Number.NaN)).toBeUndefined();
    expect(parseMaxDiffChars(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("lookupModelLimits", () => {
  it("returns limits for a catalog model", () => {
    const limits = lookupModelLimits("anthropic/claude-opus-4-6");
    expect(limits?.contextWindow).toBeGreaterThan(0);
  });

  it("splits on the first slash for ids containing slashes", () => {
    const limits = lookupModelLimits("openrouter/openai/gpt-5.4-mini");
    expect(limits?.contextWindow).toBeGreaterThan(0);
  });

  it("returns undefined for missing, malformed, and unknown models", () => {
    expect(lookupModelLimits(undefined)).toBeUndefined();
    expect(lookupModelLimits("noslash")).toBeUndefined();
    expect(lookupModelLimits("provider/")).toBeUndefined();
    expect(lookupModelLimits("no/such-model-xyz")).toBeUndefined();
  });
});

describe("resolveExplicitMaxDiffChars", () => {
  it("prefers the flag over env and config", () => {
    vi.stubEnv(MAX_DIFF_CHARS_ENV_VAR, "200000");
    readConfigMock.mockReturnValue({ maxDiffChars: 300_000 });
    expect(resolveExplicitMaxDiffChars(100_000)).toBe(100_000);
  });

  it("falls through flag to env to config", () => {
    expect(resolveExplicitMaxDiffChars(undefined)).toBeUndefined();
    readConfigMock.mockReturnValue({ maxDiffChars: 300_000 });
    expect(resolveExplicitMaxDiffChars(undefined)).toBe(300_000);
    vi.stubEnv(MAX_DIFF_CHARS_ENV_VAR, "200000");
    expect(resolveExplicitMaxDiffChars(undefined)).toBe(200_000);
    expect(resolveExplicitMaxDiffChars(100_000)).toBe(100_000);
    vi.stubEnv(MAX_DIFF_CHARS_ENV_VAR, "");
    expect(resolveExplicitMaxDiffChars(undefined)).toBe(300_000);
  });

  it("ignores malformed values at every level", () => {
    vi.stubEnv(MAX_DIFF_CHARS_ENV_VAR, "lots");
    readConfigMock.mockReturnValue({ maxDiffChars: -5 });
    expect(resolveExplicitMaxDiffChars(Number.NaN)).toBeUndefined();
  });
});

describe("resolveMaxDiffChars", () => {
  it("returns an explicit value verbatim, even outside the derived bounds", () => {
    expect(resolveMaxDiffChars({ explicit: 10 })).toBe(10);
    expect(resolveMaxDiffChars({ explicit: 10_000_000 })).toBe(10_000_000);
  });

  it("falls back to 100k for unknown models", () => {
    expect(resolveMaxDiffChars({ model: "no/such-model-xyz" })).toBe(DEFAULT_MAX_CHARS);
    expect(resolveMaxDiffChars({})).toBe(DEFAULT_MAX_CHARS);
  });

  it("derives a larger cap for large-context models", () => {
    const cap = resolveMaxDiffChars({
      model: "anthropic/claude-opus-4-6",
      nonDiffChars: 0,
    });
    expect(cap).toBeGreaterThan(DEFAULT_MAX_CHARS);
    expect(cap).toBeLessThanOrEqual(MAX_DERIVED_DIFF_CHARS);
  });

  it("shrinks the derived cap as the measured prompt grows", () => {
    const small = resolveMaxDiffChars({
      model: "anthropic/claude-opus-4-6",
      nonDiffChars: 0,
    });
    const large = resolveMaxDiffChars({
      model: "anthropic/claude-opus-4-6",
      nonDiffChars: 3_000_000,
    });
    expect(large).toBeLessThan(small);
  });

  it("floors the derived cap at the 100k compat minimum", () => {
    const cap = resolveMaxDiffChars({
      model: "anthropic/claude-opus-4-6",
      nonDiffChars: 10_000_000_000,
    });
    expect(cap).toBe(DEFAULT_MAX_CHARS);
  });
});
