import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { resolveDiff } from "../../src/core/diff-resolver.js";
import { gitEnv } from "../../src/core/git-env.js";

describe("leaked GIT_INDEX_FILE", () => {
  it("is neither used nor modified when resolving a diff with untracked files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-git-index-"));
    try {
      const g = (command: string) =>
        execSync(command, { cwd: dir, stdio: "ignore", env: gitEnv() });
      g("git init");
      await writeFile(path.join(dir, "a.ts"), "v1\n", "utf-8");
      g("git add a.ts");
      g("git -c user.name=t -c user.email=t@t commit -m init");
      await writeFile(path.join(dir, "a.ts"), "v2\n", "utf-8");
      await writeFile(path.join(dir, "new.ts"), "new\n", "utf-8");

      // withUntrackedFiles runs git add -N / git rm --cached; a leaked
      // index path would redirect those writes at a foreign index.
      const marker = path.join(dir, "leaked-index");
      const previousIndexFile = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = marker;
      let diff: string;
      try {
        ({ diff } = await resolveDiff({ diff: "HEAD", cwd: dir }));
      } finally {
        if (previousIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = previousIndexFile;
      }

      expect(existsSync(marker)).toBe(false);
      expect(diff).toContain("v2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
