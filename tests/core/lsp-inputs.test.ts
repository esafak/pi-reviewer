import { describe, expect, it } from "vite-plus/test";

import { parseLspServers } from "../../src/core/lsp/inputs.js";
import { LSP_PRESET_IDS } from "../../src/core/lsp/presets.js";

describe("parseLspServers", () => {
  it("defaults to every preset when unset or blank", () => {
    for (const raw of [undefined, "", "   "]) {
      const selection = parseLspServers(raw);
      expect(selection).toEqual({ disabled: false, ids: [...LSP_PRESET_IDS] });
    }
  });

  it("includes trusted custom ids in the blank default, deduped", () => {
    for (const raw of [undefined, "", "   "] as const) {
      const selection = parseLspServers(raw, ["custom", "ty"]);
      expect(selection.ids).toEqual([...LSP_PRESET_IDS, "custom"]);
    }
  });

  it("disables LSP on exactly 'none' even with trusted extras", () => {
    expect(parseLspServers("none")).toEqual({ disabled: true });
    expect(parseLspServers("  NONE  ")).toEqual({ disabled: true });
    expect(parseLspServers("none", ["custom"])).toEqual({ disabled: true });
  });

  it("parses a comma-separated subset, deduped", () => {
    expect(parseLspServers("tsc-rs, ty,tsc-rs")).toEqual({
      disabled: false,
      ids: ["tsc-rs", "ty"],
    });
  });

  it("fails fast on unknown ids so typos cannot silently narrow coverage", () => {
    expect(() => parseLspServers("tsc-rs,pyright")).toThrow('Unknown LSP server "pyright"');
    expect(() => parseLspServers("none,ty")).toThrow('Unknown LSP server "none"');
  });

  it("accepts trusted custom ids alongside presets", () => {
    expect(parseLspServers("ty,custom", ["custom"])).toEqual({
      disabled: false,
      ids: ["ty", "custom"],
    });
  });
});
