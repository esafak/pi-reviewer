import { describe, expect, it } from "vite-plus/test";

import { NOISE_PATTERNS } from "../../../src/core/diff-filter.js";
import { isDependencyNoise } from "../../../src/core/dependency/noise.js";

describe("the dependency mode's noise list", () => {
  it("keeps the shared list", () => {
    // The shared list is the review mode's own, and the dependency mode
    // filters with it as well.
    for (const path of ["package-lock.json", "dist/index.js", "node_modules/a/index.js"]) {
      expect(isDependencyNoise(path), path).toBe(true);
    }
  });

  it("adds the lockfiles of the formats the dependency mode supports", () => {
    for (const path of [
      "aube-lock.yaml",
      "mise.lock",
      "aqua-checksums.json",
      ".aqua-checksums.json",
      "packages.lock.json",
      "pdm.lock",
      "uv.lock",
      "poetry.lock",
      "gradle.lockfile",
      "Gemfile.lock",
      "composer.lock",
    ]) {
      expect(isDependencyNoise(path), path).toBe(true);
    }
  });

  it("adds the lockfiles beside the manifest they belong to", () => {
    for (const path of [
      "apps/api/uv.lock",
      "src/MyProject/packages.lock.json",
      "tools/mise.lock",
      "backend/pdm.lock",
      "api/Gemfile.lock",
      "api/composer.lock",
    ]) {
      expect(isDependencyNoise(path), path).toBe(true);
    }
  });

  it("leaves a manifest alone", () => {
    for (const path of [
      "package.json",
      "mise.toml",
      ".tool-versions",
      "aqua.yaml",
      ".github/workflows/ci.yml",
      "requirements.txt",
    ]) {
      expect(isDependencyNoise(path), path).toBe(false);
    }
  });

  it("does not change the review mode's list", () => {
    // The shared list is the review mode's own: a review's behavior must not
    // depend on which mode is running.
    expect(NOISE_PATTERNS.some((pattern) => pattern.test("mise.lock"))).toBe(false);
    expect(NOISE_PATTERNS.some((pattern) => pattern.test("uv.lock"))).toBe(false);
  });
});
