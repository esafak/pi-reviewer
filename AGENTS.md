# Project Conventions

* Use mise for tools
* When reviewing or planning, iterate using one agent until convergence; don't create a new one at each step.

## Function Naming
- Prefix async data fetchers with `fetch` (e.g. `fetchUser`, `fetchOrders`)
- Prefix boolean functions with `is`, `has`, or `can`
- Prefix mutations with a verb: `update`, `delete`, `create`, `reset`
