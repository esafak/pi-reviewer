# Project Conventions

* NEVER PUSH TO `main`, create PRs
* Use mise for tools
* Run repo scripts with `vpr` (npm-script runner, e.g. `vpr test`), not the `vp` built-ins — CI uses `vpr test`.
* When reviewing or planning, iterate using one agent until convergence; don't create a new one at each step.
* Write permanent comments: state the invariant or rationale, never the incident that prompted it, which belongs in the commit or PR, not the code.
* Name inline object types, key Records by union types when keys are closed, keep one source of truth; at untrusted boundaries prefer `unknown` + narrowing over interfaces that lie, and never `any`.