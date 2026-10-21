import { describe, expect, it } from "vite-plus/test";

import { classifyVersionChange } from "../../../src/core/dependency/versions.js";

describe("PEP 440 suffix numbers", () => {
  it("tells a pre-release's development number apart", () => {
    expect(classifyVersionChange("pep440", "1.0rc1.dev1", "1.0rc1.dev2")?.kind).toBe("patch");
    expect(classifyVersionChange("pep440", "1.0rc1.dev2", "1.0rc1.dev1")?.kind).toBe("downgrade");
  });

  it("tells a post-release's development number apart", () => {
    expect(classifyVersionChange("pep440", "1.0.post1.dev1", "1.0.post1.dev2")?.kind).toBe("patch");
    expect(classifyVersionChange("pep440", "1.0.post1.dev2", "1.0.post1.dev1")?.kind).toBe(
      "downgrade",
    );
  });

  it("tells a pre-release's post-release number apart", () => {
    expect(classifyVersionChange("pep440", "1.0rc1.post1", "1.0rc1.post2")?.kind).toBe("patch");
    expect(classifyVersionChange("pep440", "1.0rc1.post2", "1.0rc1.post1")?.kind).toBe("downgrade");
  });

  it("tells a development release of a post-release apart from the post-release", () => {
    expect(classifyVersionChange("pep440", "1.0rc1.post1", "1.0rc1.post1.dev1")?.kind).toBe(
      "downgrade",
    );
    expect(classifyVersionChange("pep440", "1.0rc1.post1.dev1", "1.0rc1.post1")?.kind).toBe(
      "patch",
    );
  });

  it("orders a pre-release's own development release before it", () => {
    expect(classifyVersionChange("pep440", "1.0a1.dev1", "1.0a1")?.kind).toBe("patch");
  });
});
