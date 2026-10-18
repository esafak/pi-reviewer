import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { buildLspServerEntries } from "../../src/core/lsp/config.js";
import { resolveLspRoots } from "../../src/core/lsp/roots.js";

/**
 * Uses pi-lsp's real findProjectRoot + glob matchers (via resolveLspRoots),
 * so the diagnostic cannot drift from what the extension itself would open.
 */
describe("resolveLspRoots", () => {
  it("resolves nested roots per server and skips marker-less files with reasons", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-reviewer-lsp-roots-"));
    try {
      // Monorepo layout: root config + nested sub-project config.
      await writeFile(path.join(dir, "pyproject.toml"), '[project]\nname = "root"\n');
      await writeFile(path.join(dir, "a.py"), "x = 1\n");
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "sub", "pyproject.toml"), '[project]\nname = "sub"\n');
      await writeFile(path.join(dir, "sub", "b.py"), "y = 2\n");
      await writeFile(path.join(dir, "notes.md"), "# notes\n");
      // Plain `.git` directory as the root marker: marker discovery only
      // checks existence, and shelling out to `git init` flakes under
      // parallel-suite load. No test here needs a real repository.
      await mkdir(path.join(dir, ".git"), { recursive: true });

      const entries = buildLspServerEntries(["ty", "markdown-oxide", "taplo"], {});
      const files = ["a.py", path.join("sub", "b.py"), "notes.md"];
      const { matches, skipped } = await resolveLspRoots(dir, files, entries);

      const tyRoots = matches.filter((match) => match.id === "ty");
      expect(tyRoots).toHaveLength(2);
      const byRoot = new Map(tyRoots.map((match) => [match.root, match.files]));
      expect(byRoot.get(dir)).toEqual(["a.py"]);
      expect(byRoot.get(path.join(dir, "sub"))).toEqual([path.join("sub", "b.py")]);

      // Markdown resolves to the git root.
      const mdRoots = matches.filter((match) => match.id === "markdown-oxide");
      expect(mdRoots).toHaveLength(1);
      expect(mdRoots[0]?.root).toBe(dir);
      expect(mdRoots[0]?.files).toEqual(["notes.md"]);

      // taplo has no .toml files and no markers for these paths: the .py/.md
      // files never match its include globs, so nothing resolves and nothing
      // is skipped for it either.
      expect(matches.some((match) => match.id === "taplo")).toBe(false);
      expect(skipped.filter((entry) => entry.server === "taplo")).toEqual([]);

      // A server whose markers exist nowhere reports why per file.
      const orphan = buildLspServerEntries(["ty"], {
        ty: { rootMarkers: ["definitely-no-such-marker"] },
      });
      const orphaned = await resolveLspRoots(dir, ["a.py"], orphan);
      expect(orphaned.matches).toEqual([]);
      expect(orphaned.skipped).toEqual([
        {
          file: "a.py",
          server: "ty",
          reason: expect.stringContaining("definitely-no-such-marker"),
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
