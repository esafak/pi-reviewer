import { describe, expect, it } from "vite-plus/test";

import { parseLspServers } from "../../src/core/lsp/inputs.js";

describe("parseLspServers", () => {
  it("leaves every language unpinned when unset or blank", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(parseLspServers(raw)).toEqual({ disabled: false, pinned: {} });
    }
  });

  it("disables LSP on exactly 'none' even with trusted extras", () => {
    expect(parseLspServers("none")).toEqual({ disabled: true });
    expect(parseLspServers("  NONE  ")).toEqual({ disabled: true });
    expect(parseLspServers("none", ["custom"])).toEqual({ disabled: true });
  });

  it("pins the named languages and leaves the others alone", () => {
    expect(parseLspServers("pyright")).toEqual({
      disabled: false,
      pinned: { python: ["pyright"] },
    });
    expect(parseLspServers("ty,tsrs, gopls")).toEqual({
      disabled: false,
      pinned: { python: ["ty"], typescript: ["tsrs"], go: ["gopls"] },
    });
    expect(parseLspServers("ty,custom", ["custom"])).toEqual({
      disabled: false,
      pinned: { python: ["ty"] },
    });
  });

  it("keeps the built-in preference order among the named candidates", () => {
    expect(parseLspServers("pyright,ty")).toEqual({
      disabled: false,
      pinned: { python: ["ty", "pyright"] },
    });
  });

  it("fails fast on ids that name no server to run", () => {
    expect(() => parseLspServers("tsc-rs,pyreflly")).toThrow('Unknown LSP server "pyreflly"');
    expect(() => parseLspServers("none,ty")).toThrow('Unknown LSP server "none"');
    expect(() => parseLspServers("python")).toThrow('"python" is a language, not a server');
  });
});
