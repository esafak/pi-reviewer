---
description: Load when you need repo-wide context for pi-reviewer packaging, commands, and deployment surfaces.
---

# Project surface

<scope>
  <rule><requirement>This repo ships a pi extension, a GitHub Action, and a browser UI from one codebase.</requirement><example>`README.md` describes `/review`, `CI.md` describes the Action, and `ui/` builds the review app.</example></rule>
  <rule><requirement>The npm scripts build the UI first, then compile TypeScript.</requirement><example>`npm run build` runs `build:ui` before `tsc -p tsconfig.json`.</example></rule>
  <rule><requirement>`action.yml` must point at the compiled CI entrypoint in `dist/src/ci/action-entry.js`.</requirement><example>GitHub Actions installs the package, then runs `node .../dist/src/ci/action-entry.js`.</example></rule>
</scope>

<runtime>
  <rule><requirement>Local review runs inside pi as `/review`; CI review runs on pull requests; UI review is a post-processing step.</requirement><example>`/review --ui` opens the browser flow, while GitHub Actions posts the review comment automatically.</example></rule>
</runtime>

<self-verification>
  <check>This note covers repo-level packaging and execution surfaces only.</check>
  <check>README, CI, and action wiring match the current codebase.</check>
  <check>No core, extension, or UI implementation detail was duplicated here.</check>
</self-verification>
