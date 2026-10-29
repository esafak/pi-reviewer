import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_MAX_CHARS,
  describeSectionSize,
  filterDiff,
  lookupModelLimits,
  MAX_DERIVED_DIFF_CHARS,
  MAX_DIFF_CHARS_ENV_VAR,
  MAX_SHARDS,
  parseMaxDiffChars,
  planReview,
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

describe("shard", () => {
  it("packs in diff order without splitting a file", () => {
    const a = makeDiffSection("src/a.ts");
    const b = makeDiffSection("src/b.ts");
    // Both fit the fit cap, so this is the single path; sharded packing
    // below uses caps that force overflow.
    const single = planReview([a, b], [], a.length + b.length + 1, 10_000);
    expect(single.kind).toBe("single");
    const plan = planReview([a, b], [], 10, 10_000);
    expect(plan.kind).toBe("sharded");
    if (plan.kind !== "sharded") return;
    // Shard 1 is the legacy-kept set (skip-and-continue under fitCap): with
    // fitCap 10 neither section fits, so the legacy set is empty and both
    // sections pack into the first remainder shard in diff order.
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.shards[0]?.diff).toBe(a + b);
  });

  it("packs multiple shards when sections exceed the shard cap", () => {
    const a = makeDiffSection("src/a.ts");
    const plan = planReview([a, a, a], [], 10, a.length);
    expect(plan.kind).toBe("sharded");
    if (plan.kind !== "sharded") return;
    expect(plan.shards).toHaveLength(3);
    expect(plan.skipped).toEqual([]);
  });

  it("skips oversize single sections with their own size as cap", () => {
    const big = `diff --git a/src/big.ts b/src/big.ts\n${"x".repeat(500)}\n`;
    const small = makeDiffSection("src/small.ts");
    const plan = planReview([big, small], [], 10, 200);
    expect(plan.kind).toBe("sharded");
    if (plan.kind !== "sharded") return;
    expect(plan.skipped).toEqual([{ path: "src/big.ts", reason: "oversize", cap: big.length }]);
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards[0]?.files).toEqual(["src/small.ts"]);
  });

  it("returns unreviewable when every section exceeds the shard budget", () => {
    const big = `diff --git a/src/big.ts b/src/big.ts\n${"x".repeat(500)}\n`;
    const plan = planReview([big], [], 10, 200);
    expect(plan.kind).toBe("unreviewable");
    if (plan.kind !== "unreviewable") return;
    expect(plan.skipped).toEqual([{ path: "src/big.ts", reason: "oversize", cap: big.length }]);
  });

  it("takes the single path for empty and all-noise candidate sets", () => {
    const empty = planReview([], [], 10, 10);
    expect(empty.kind).toBe("single");
    if (empty.kind !== "single") return;
    expect(empty.diff).toBe("");
    expect(empty.skipped).toEqual([]);

    const noiseExcluded = planReview([], ["package-lock.json"], 10, 10);
    expect(noiseExcluded.kind).toBe("single");
    if (noiseExcluded.kind !== "single") return;
    expect(noiseExcluded.diff).toBe("");
    expect(noiseExcluded.warning).toMatch(/package-lock\.json/);
  });

  it("carries the noise warning on sharded plans", () => {
    const a = makeDiffSection("src/a.ts");
    const warned = planReview([a, a], ["package-lock.json"], 10, a.length);
    expect(warned.kind).toBe("sharded");
    if (warned.kind !== "sharded") return;
    expect(warned.warning).toMatch(/package-lock\.json/);
    expect(warned.skipped).toEqual([]);
  });

  it("cuts the contiguous diff-order tail beyond MAX_SHARDS", () => {
    expect(MAX_SHARDS).toBe(5);
    const one = makeDiffSection("src/a.ts");
    const kept = [0, 1, 2, 3, 4, 5, 6].map((i) => one.replaceAll("src/a.ts", `src/f${i}.ts`));
    const cap = kept[0]?.length ?? one.length;
    const plan = planReview(kept, [], 10, cap);
    expect(plan.kind).toBe("sharded");
    if (plan.kind !== "sharded") return;
    expect(plan.shards).toHaveLength(MAX_SHARDS);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["shard_limit", "shard_limit"]);
    expect(plan.skipped[0]?.cap).toBe(cap);
  });

  it("reviews a superset of the legacy path: set violation repro", () => {
    // Six 506-char sections then a 394-char one, fitCap = shardCap = 1000.
    // Legacy skip-and-continue keeps e0 and s.ts; a naive contiguous packer
    // fills five shards with e0..e4 and drops e5 and s.ts as shard_limit.
    // Shard 1 must hold exactly the legacy-kept set.
    const e = (i: number): string =>
      `diff --git a/src/e${i}.ts b/src/e${i}.ts\n${"x".repeat(470)}\n`;
    const s = `diff --git a/src/s.ts b/src/s.ts\n${"y".repeat(360)}\n`;
    expect(e(0).length).toBe(506);
    expect(s.length).toBe(394);
    const fitCap = 1000;
    const kept = [0, 1, 2, 3, 4, 5].map(e).concat([s]);
    const { diff: legacyDiff } = filterDiff(kept.join(""), fitCap);
    expect(legacyDiff).toContain("src/e0.ts");
    expect(legacyDiff).toContain("src/s.ts");
    const plan = planReview(kept, [], fitCap, fitCap);
    expect(plan.kind).toBe("sharded");
    if (plan.kind !== "sharded") return;
    // Pinned exactly: shard 1 IS the legacy-kept set (fails on the old
    // packer, whose shards[0] is ["src/e0.ts"] alone).
    expect(plan.shards[0]?.files).toEqual(["src/e0.ts", "src/s.ts"]);
    const reviewed = plan.shards.flatMap((shard) => shard.files);
    expect(reviewed).toContain("src/e0.ts");
    expect(reviewed).toContain("src/s.ts");
  });

  it("reviews at least as many files as the legacy path: count repro", () => {
    // fitCap 1000, shardCap 2000; six ~1486-char sections then fourteen
    // ~56-char ones. Legacy skips the big six and reviews all fourteen tiny
    // files; a naive packer fills five shards with big files and reviews
    // only 5. Sharding must review at least the legacy 14.
    const big = (i: number): string =>
      `diff --git a/src/x${i}.ts b/src/x${i}.ts\n${"x".repeat(1450)}\n`;
    const tiny = (i: number): string =>
      `diff --git a/src/t${i}.ts b/src/t${i}.ts\n${"y".repeat(20)}\n`;
    const kept = [0, 1, 2, 3, 4, 5].map(big).concat(Array.from({ length: 14 }, (_, i) => tiny(i)));
    const { diff: legacyDiff } = filterDiff(kept.join(""), 1000);
    const legacyCount = legacyDiff.split("diff --git ").length - 1;
    expect(legacyCount).toBe(14);
    const plan = planReview(kept, [], 1000, 2000);
    expect(plan.kind).toBe("sharded");
    if (plan.kind !== "sharded") return;
    const reviewedCount = plan.shards.flatMap((shard) => shard.files).length;
    expect(reviewedCount).toBeGreaterThanOrEqual(legacyCount);
  });

  it("is deterministic across runs", () => {
    const kept = ["c", "a", "b"].map((f) => makeDiffSection(`src/${f}.ts`));
    const first = planReview(kept, ["x"], 10, 10_000);
    const second = planReview(kept, ["x"], 10, 10_000);
    expect(second).toEqual(first);
  });

  it("honours an explicit cap below the floor and above the ceiling", () => {
    expect(resolveMaxDiffChars({ explicit: 10 })).toBe(10);
    expect(resolveMaxDiffChars({ explicit: 10_000_000 })).toBe(10_000_000);
  });

  it("is monotone non-increasing in nonDiffChars", () => {
    const model = "anthropic/claude-opus-4-6";
    const caps = [0, 1000, 50_000, 3_000_000].map((nonDiffChars) =>
      resolveMaxDiffChars({ model, nonDiffChars }),
    );
    for (let i = 1; i < caps.length; i += 1) {
      expect(caps[i]).toBeLessThanOrEqual(caps[i - 1] ?? 0);
    }
  });

  it("derives section size signals from raw text only", () => {
    const sized = describeSectionSize(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n+new\n-old\n context\n",
    );
    expect(sized.added).toBe(1);
    expect(sized.removed).toBe(1);

    const headers = describeSectionSize(makeDiffSection("src/h.ts"));
    // The section body is a single "+" line; +++ / --- / @@ markers excluded.
    expect(headers.added).toBe(1);
    expect(headers.removed).toBe(0);

    const binary = describeSectionSize(
      "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files a/img.png and b/img.png differ\n",
    );
    expect(binary.added).toBe(0);
    expect(binary.removed).toBe(0);
    expect(binary.chars).toBe(
      "diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files a/img.png and b/img.png differ\n"
        .length,
    );
  });
});
