---
description: Load when working on the doc-context provider that injects project notes into the review prompt.
---

# Doc-context provider

<matching>
  <rule><requirement>The provider extracts keywords from diff file paths, not from diff content.</requirement><example>`src/auth/login.ts` yields keywords like `auth` and `login`.</example></rule>
  <rule><requirement>It loads only `.md` files with YAML frontmatter that includes `description:`.</requirement><example>A note without `description:` is ignored even if the filename looks relevant.</example></rule>
  <rule><requirement>Doc files are considered relevant when any keyword matches the description or file path.</requirement><example>`auth` in the description or path pulls the doc into the prompt for auth-related diffs.</example></rule>
</matching>

<scan>
  <rule><requirement>By default it scans `.pi/notes`, `.claude/notes`, and `.agents/notes`, one level deep.</requirement><example>`/repo/.pi/notes/backend/auth.md` is picked up, but deeper nesting is not.</example></rule>
  <rule><requirement>When `gitRoot` is present, it walks from repo root down to cwd so parent docs stay visible in monorepos.</requirement><example>A package can load `../.pi/notes/shared.md` from the repo root and `.pi/notes/local.md` from its own directory.</example></rule>
  <rule><requirement>SSH mode works because the provider uses the supplied filesystem abstraction.</requirement><example>The same provider logic reads local files and remote files through `FsOps`.</example></rule>
</scan>

<self-verification>
  <check>The provider’s keyword extraction, doc filtering, and monorepo walk-up are all represented.</check>
  <check>No unrelated extension behavior was mixed into this note.</check>
  <check>Every rule has a concrete example.</check>
</self-verification>
