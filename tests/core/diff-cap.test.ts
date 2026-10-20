import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  getBuiltinModel: vi.fn(),
}));

import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  DEFAULT_MAX_CHARS,
  MAX_DERIVED_DIFF_CHARS,
  resolveMaxDiffChars,
} from "../../src/core/diff-filter.js";

const getBuiltinModelMock = vi.mocked(getBuiltinModel);

function mockModel(contextWindow: number, maxTokens: number) {
  getBuiltinModelMock.mockReturnValue({ contextWindow, maxTokens } as never);
}

describe("resolveMaxDiffChars arithmetic", () => {
  it("computes context minus prompt minus headroom minus output exactly", () => {
    // 100k ctx tokens * 4 = 400k; −50k prompt −40k tools −(8k*4) output = 278k.
    mockModel(100_000, 8_000);
    expect(resolveMaxDiffChars({ model: "p/m", nonDiffChars: 50_000 })).toBe(278_000);
  });

  it("falls back to a fixed output reserve when maxTokens is missing", () => {
    // 100k*4 = 400k; −0 prompt −40k tools −32k default output = 328k.
    getBuiltinModelMock.mockReturnValue({ contextWindow: 100_000 } as never);
    expect(resolveMaxDiffChars({ model: "p/m" })).toBe(328_000);
  });

  it("caps the derived value at the 500k ceiling", () => {
    mockModel(1_000_000, 128_000);
    expect(resolveMaxDiffChars({ model: "p/m", nonDiffChars: 0 })).toBe(MAX_DERIVED_DIFF_CHARS);
  });

  it("floors the derived value at the 100k compat minimum", () => {
    mockModel(32_000, 8_000);
    expect(resolveMaxDiffChars({ model: "p/m", nonDiffChars: 200_000 })).toBe(DEFAULT_MAX_CHARS);
  });
});
