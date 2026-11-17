# Tickets: milestone 1, the package `xpi-graph`

Spec: `.scratch/xpi-graph/01-graph.md` (sections 1 to 4). One PR (branch `graph-package`): `npm run check`, the
package's tests, green CI, an independent Opus review. Nothing in the coding agent changes in this PR.

- [ ] G1.1 the package: `packages/xpi-graph` laid out like `packages/xpi-relay` (`package.json` private with the
      `source` export, `tsconfig.build.json`, vitest, README); added to the root `build` and `build:offline`
      scripts, the `tsconfig.json` paths, `scripts/check-entry-graphs.mjs`, `test.sh` if it lists packages, and the
      lockfile (`npm install --package-lock-only --ignore-scripts`; the lockfile change is part of this PR)
- [ ] G1.2 types and `parseGraph`: the graph, the two node kinds, edges, `requires`; every field validated (this is
      the trust boundary); one error listing every problem with its place
- [ ] G1.3 `checkGraph`: the structural rules, exit kinds per node kind, loops and the default `max: 3`, both
      `requires` checks with the offending path in the error
- [ ] G1.4 entries and `readState`: the entry data types of spec section 4; the fold (current node, counts since
      the start or the last goto, a pending move, halted and a halt left by a user message, ended, error state); `exits(graph, state)`
- [ ] G1.5 tests: as listed under "Package" in the spec's Tests
- [ ] G1.6 `packages/xpi-graph/README.md`: what the package answers, the file format, the checks
