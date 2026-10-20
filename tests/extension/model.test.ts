import { describe, expect, it } from "vite-plus/test";

import { resolveBudgetModelId, resolveCurrentModelId } from "../../extensions/pi-reviewer/model.js";

describe("resolveBudgetModelId", () => {
  it("budgets SSH reviews against the session model, not the override", () => {
    expect(
      resolveBudgetModelId({
        ssh: true,
        currentModelId: "anthropic/claude-opus-4-6",
        sessionModel: { id: "small-model", provider: "zai" },
      }),
    ).toBe("zai/small-model");
  });

  it("falls back to undefined when SSH has no session model", () => {
    expect(
      resolveBudgetModelId({
        ssh: true,
        currentModelId: "anthropic/claude-opus-4-6",
        sessionModel: undefined,
      }),
    ).toBeUndefined();
  });

  it("budgets local reviews against the override", () => {
    expect(
      resolveBudgetModelId({
        ssh: false,
        currentModelId: "anthropic/claude-opus-4-6",
        sessionModel: { id: "small-model", provider: "zai" },
      }),
    ).toBe("anthropic/claude-opus-4-6");
  });
});

describe("resolveCurrentModelId", () => {
  it("prefers the registry entry for a configured model", () => {
    expect(
      resolveCurrentModelId("claude-opus-4-6", [{ id: "claude-opus-4-6", provider: "anthropic" }], {
        id: "other",
        provider: "zai",
      }),
    ).toBe("anthropic/claude-opus-4-6");
  });
});
