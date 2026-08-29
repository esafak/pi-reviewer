import { describe, expect, it } from "vite-plus/test";

import { parseDiffPositions, partitionComments } from "../../src/core/diff-positions.js";
import type { ReviewComment } from "../../src/core/output.js";

// Real diff from fresnel PR #2760 (commit 22f7cbf2) — the tag-input change.
const TAG_INPUT_DIFF = `diff --git a/client/web/src/lib/components/core/tag-input/tag-input.svelte b/client/web/src/lib/components/core/tag-input/tag-input.svelte
index 37c59cd9..0adfa8e9 100644
--- a/client/web/src/lib/components/core/tag-input/tag-input.svelte
+++ b/client/web/src/lib/components/core/tag-input/tag-input.svelte
@@ -17,6 +17,7 @@
         handleTagAdded?: (tag: string) => void;
         handleTagRemoved?: (tagRemoved: string, currentTags: string[]) => void;
         errorTags?: string[];
+        customValidation?: (tag: string) => boolean;
     }
 </script>
 
@@ -27,6 +28,7 @@
         handleTagAdded,
         handleTagRemoved,
         errorTags,
+        customValidation,
     }: TagInputProps = $props();
 
     $effect(() => {
@@ -63,6 +65,9 @@
     <TagsCompat
         addKeys={[Key.Enter, Key.Space, Key.Comma]}
         removeKeys={[]}
+        allowPaste={true}
+        splitWith={/[,;\\s]+/}
+        {customValidation}
         onTagAdded={handleTagAdded}
         onTagRemoved={handleTagRemoved}
         {placeholder}
`;

// Real diff from fresnel PR #2760 at head (commit 2f5d85bf) — the d.ts sync.
const DTS_DIFF = `diff --git a/client/web/src/types/svelte-tags-input.d.ts b/client/web/src/types/svelte-tags-input.d.ts
index 4029e868..669cc9a0 100644
--- a/client/web/src/types/svelte-tags-input.d.ts
+++ b/client/web/src/types/svelte-tags-input.d.ts
@@ -4,7 +4,11 @@ declare module "svelte-tags-input" {
     export interface SvelteTagsInputProps {
         tags?: string[];
         placeholder?: string;
-        removeKeys?: string[];
+        addKeys?: number[];
+        removeKeys?: number[];
+        allowPaste?: boolean;
+        splitWith?: string | RegExp;
+        customValidation?: (tag: string) => boolean;
         onTagAdded?: (tag: string) => void;
         onTagRemoved?: (tagRemoved: string, currentTags: string[]) => void;
     }
`;

const PATH = "client/web/src/lib/components/core/tag-input/tag-input.svelte";
const DTS_PATH = "client/web/src/types/svelte-tags-input.d.ts";

describe("parseDiffPositions", () => {
  it("computes RIGHT positions from added and context lines", () => {
    const positions = parseDiffPositions(TAG_INPUT_DIFF);
    const pos = positions.get(PATH)!;
    // hunk @@ -17,6 +17,7 @@ → new lines 17-23
    expect(pos.right.has(17)).toBe(true);
    expect(pos.right.has(20)).toBe(true);
    expect(pos.right.has(23)).toBe(true);
    // line 36 is in the unmodified $effect block — not in any hunk
    expect(pos.right.has(36)).toBe(false);
    // later hunks still tracked
    expect(pos.right.has(65)).toBe(true);
    expect(pos.right.has(73)).toBe(true);
  });

  it("computes LEFT positions from removed and context lines", () => {
    const positions = parseDiffPositions(DTS_DIFF);
    const pos = positions.get(DTS_PATH)!;
    // hunk @@ -4,7 +4,11 @@ → old lines 4-10
    expect(pos.left.has(4)).toBe(true);
    expect(pos.left.has(7)).toBe(true);
    expect(pos.left.has(10)).toBe(true);
    // line 1 is outside the hunk
    expect(pos.left.has(1)).toBe(false);
    expect(pos.right.has(4)).toBe(true);
    expect(pos.right.has(14)).toBe(true);
  });

  it("returns empty sets for a file absent from the diff", () => {
    const positions = parseDiffPositions(TAG_INPUT_DIFF);
    expect(positions.get("client/web/src/types/svelte-tags-input.d.ts")).toBeUndefined();
  });

  it("handles a brand-new file with a 0,0 left hunk", () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line one
+line two
+line three
`;
    const positions = parseDiffPositions(diff);
    const pos = positions.get("src/new.ts")!;
    expect(pos.left.size).toBe(0);
    expect(pos.right.has(1)).toBe(true);
    expect(pos.right.has(3)).toBe(true);
  });

  it("handles a deleted file (LEFT-only lines)", () => {
    const diff = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index e69de29..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
    const positions = parseDiffPositions(diff);
    const pos = positions.get("src/old.ts")!;
    expect(pos.left.has(1)).toBe(true);
    expect(pos.left.has(2)).toBe(true);
    expect(pos.right.size).toBe(0);
  });

  it("handles binary files with no hunks", () => {
    const diff = `diff --git a/src/blob.bin b/src/blob.bin
index 1234567..89abcde 100644
Binary files a/src/blob.bin and b/src/blob.bin differ
`;
    const positions = parseDiffPositions(diff);
    expect(positions.get("src/blob.bin")).toEqual({ left: new Set(), right: new Set() });
  });

  it("ignores '\\ No newline at end of file' markers", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcde 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -5,2 +5,2 @@
 hello
-world
+world
\\ No newline at end of file
`;
    const positions = parseDiffPositions(diff);
    const pos = positions.get("src/a.ts")!;
    expect(pos.left.has(6)).toBe(true);
    expect(pos.right.has(6)).toBe(true);
    expect(pos.left.has(7)).toBe(false);
  });
});

describe("partitionComments", () => {
  it("splits comments into positionable inline and unpositionable moved", () => {
    const positions = parseDiffPositions(TAG_INPUT_DIFF);
    const comments: ReviewComment[] = [
      // positionable: inside hunk @@ -17,6 +17,7 @@ (new line 20)
      {
        file: PATH,
        line: 20,
        side: "RIGHT",
        severity: "INFO",
        body: "customValidation missing from types",
      },
      // unpositionable: line 36 in the unmodified $effect block
      {
        file: PATH,
        line: 36,
        side: "RIGHT",
        severity: "INFO",
        body: "global DOM query in $effect",
      },
      // positionable: line 65 in hunk @@ -63,6 +65,9 @@
      { file: PATH, line: 65, side: "RIGHT", severity: "WARN", body: "allowPaste is fine" },
    ];

    const { inline, moved } = partitionComments(comments, positions);
    expect(inline.map((c) => c.line)).toEqual([20, 65]);
    expect(moved.map((c) => c.line)).toEqual([36]);
  });

  it("moves comments on files absent from the diff", () => {
    const positions = parseDiffPositions(TAG_INPUT_DIFF);
    const comments: ReviewComment[] = [
      { file: DTS_PATH, line: 1, side: "LEFT", severity: "INFO", body: "d.ts not updated" },
    ];

    const { inline, moved } = partitionComments(comments, positions);
    expect(inline).toHaveLength(0);
    expect(moved).toEqual(comments);
  });

  it("moves comments outside a hunk even when the file is in the diff", () => {
    const positions = parseDiffPositions(DTS_DIFF);
    const comments: ReviewComment[] = [
      // hunk is @@ -4,7 +4,11 @@; line 1 LEFT is outside it
      { file: DTS_PATH, line: 1, side: "LEFT", severity: "INFO", body: "line 1 comment" },
      // line 5 LEFT is inside the hunk
      { file: DTS_PATH, line: 5, side: "LEFT", severity: "INFO", body: "line 5 comment" },
    ];

    const { inline, moved } = partitionComments(comments, positions);
    expect(inline.map((c) => c.line)).toEqual([5]);
    expect(moved.map((c) => c.line)).toEqual([1]);
  });

  it("treats context lines inside a hunk as positionable", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 context-one
-removed
+added
+added-two
 context-two
`;
    const positions = parseDiffPositions(diff);
    const comments: ReviewComment[] = [
      { file: "src/a.ts", line: 10, side: "RIGHT", severity: "INFO", body: "on leading context" },
      {
        file: "src/a.ts",
        line: 11,
        side: "LEFT",
        severity: "INFO",
        body: "on removed line (LEFT)",
      },
      { file: "src/a.ts", line: 13, side: "RIGHT", severity: "INFO", body: "on added-two (RIGHT)" },
      {
        file: "src/a.ts",
        line: 13,
        side: "LEFT",
        severity: "INFO",
        body: "trailing context is LEFT-only on old side",
      },
    ];

    const { inline, moved } = partitionComments(comments, positions);
    expect(inline).toHaveLength(3);
    expect(moved).toHaveLength(1);
    expect(moved[0].body).toBe("trailing context is LEFT-only on old side");
  });

  it("dedups exact duplicate comments, keeps distinct comments on the same line", () => {
    const positions = parseDiffPositions(TAG_INPUT_DIFF);
    const comments: ReviewComment[] = [
      { file: PATH, line: 20, side: "RIGHT", severity: "INFO", body: "same" },
      { file: PATH, line: 20, side: "RIGHT", severity: "INFO", body: "same" },
      { file: PATH, line: 20, side: "RIGHT", severity: "WARN", body: "different" },
    ];

    const { inline } = partitionComments(comments, positions);
    expect(inline).toHaveLength(2);
    expect(inline.map((c) => c.body).sort()).toEqual(["different", "same"]);
  });
});
