# Project Conventions

* You can ask the user questions, preferably multiple choice with adequate context, on initiating a project.
* Iterate on the working tree code until a reviewer agent signs off, then notify the user. Don't commit yet.
* NEVER create a PR until the user has approved. Then you can commit and create a PR. Don't skip git hooks; fix errors.
* NEVER push to `main`, use feature branches in worktrees. Create a worktree right away if the main branch is dirty.
* Run repo scripts with `vpr` (npm-script runner, e.g. `vpr test`), not the `vp` built-ins — CI uses `vpr test`.
* When reviewing or planning, iterate using one agent until convergence; don't create a new one at each step.
* Write permanent comments: state the invariant or rationale, never the incident that prompted it,
  which belongs in the commit or PR, not the code.
* Name inline object types, key Records by union types when keys are closed, keep one source of truth;
  at untrusted boundaries prefer `unknown` + narrowing over interfaces that lie, and never `any`.