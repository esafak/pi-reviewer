---
description: Load when working on the browser review UI, its state model, panels, shortcuts, or config syncing.
---

# Review UI

<boot>
  <rule><requirement>`App` boots from `window.__DATA__` and falls back to `mockData` when no server payload exists.</requirement><example>The page still renders in dev mode without a live `UIData` payload.</example></rule>
  <rule><requirement>Theme changes are persisted through `/config`, and the tab keeps the server alive with `/ping`.</requirement><example>Switching dark/light mode posts a config patch and a 30s heartbeat keeps the server from timing out.</example></rule>
  <rule><requirement>Closing the tab posts a `closed` action so the server can resolve the session cleanly.</requirement><example>`pagehide` sends `{ type: "closed", decisions: [] }` with `keepalive: true`.</example></rule>
</boot>

<review-flow>
  <rule><requirement>The diff view parses files into split or unified rows, shows orphan comments separately, and builds a file tree from comment counts.</requirement><example>`OrphanComments` is used for findings whose file does not exist in the diff.</example></rule>
  <rule><requirement>The header exposes review progress, token usage, source labels, sidebar toggles, and finish actions.</requirement><example>`Finish review` opens a submit panel that can save, send, or do both.</example></rule>
  <rule><requirement>Keyboard shortcuts support `j/k`, `a`, `r`, `d`, `f`, and `?` for review navigation.</requirement><example>`f` dispatches `pi:open-finish` to open the submit flow.</example></rule>
</review-flow>

<panels>
  <rule><requirement>The settings panel patches view mode, default model, thinking level, and auto-collapse behavior through the shared settings context.</requirement><example>Choosing a new model posts `{ model: "provider/id" }` to `/config`.</example></rule>
  <rule><requirement>The submit panel lets the reviewer choose send/save/save-and-send and optionally narrow which context groups are injected back into the agent.</requirement><example>Rejected comments are excluded from the injection message, while discuss notes are preserved.</example></rule>
  <rule><requirement>Summary and context side panels are rendered on demand from the header buttons.</requirement><example>The context panel lists loaded context files and expands each file body on click.</example></rule>
</panels>

<self-verification>
  <check>The boot, review flow, shortcut model, and side panels are all covered.</check>
  <check>No backend or extension implementation details were described as UI behavior.</check>
  <check>Every rule includes a concrete example from the app.</check>
</self-verification>
