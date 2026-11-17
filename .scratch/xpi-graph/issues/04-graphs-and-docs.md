# Tickets: milestone 4, the two graphs and the real-model check

Spec: `.scratch/xpi-graph/01-graph.md` (section 8, Tests, Docs). One PR (branch `graph-flows`), after milestone 3:
green CI, an independent Opus review.

- [x] G4.1 `.pi/graphs/dev.js`: grill, spec, build, ci, review, merge, with `requires` and the review node's
      prompt that starts a fresh-context Opus subagent; the merge and push commands denied on `build` and on
      `review`
      Done. A command node, `branch`, stands between the spec and the build so that the build never starts on main; the review node may not write code (`readOnly`), and `build` may not use `--no-verify` or name main in a push.
- [x] G4.2 `.pi/graphs/release.js`: the flow of `.pi/skills/release.md` up to the tag. If the engine cannot express
      a step, stop and report it to the owner; do not extend the engine in this PR
      Done, with no change to the engine. Nodes: plan, patch, minor, ci, fix, review, merge, sync, main-ci, tag, done. `main-ci` waits for the CI run of the merge commit itself.
- [x] G4.3 a test that loads and checks both graphs, and that the dev graph without its `ci` node fails the load
      Done: `test/repo-graphs.test.ts` (15 tests): both load; dev is refused without `ci`, with `build -> merge`, and with a patch node that skips the check; release is refused when the tag can skip the merge or a fix can skip the check.
- [x] G4.4 by hand, real Haiku 5.5 only, in a temp repository with a local stand-in for CI and every node on Haiku
      (the lead runs it): the runs listed under "By hand" in the spec's Tests; the results and the cost per node
      change go in the PR
      Done for the shapes, not for the two files themselves: `dev.js` and `release.js` call `gh` and would merge and tag for real, so graphs of the same shape with stand-in commands were run (the release shape without the `main-ci` step). Total cost $0.0084, every node on Haiku 5.5, `xpi -p` in sandboxes. Dev shape three times: each time the check failed once, the graph went back to build, the check passed, review, merge; the merge stand-in never ran on a red check; the denied command was blocked and recorded each time. Quit and reopen: the first process halted in the first node after one reminder, the second (`xpi -c -p`) went on from that node to the end. Release shape once: five command nodes in a row, to the end. The traces are in the PR.
- [x] G4.5 docs: the two graphs in `docs/graph.md`; a last grep of both READMEs, `docs/xin-pi.md` and the
      package's `docs/` for anything the four milestones touched
      Done: `docs/graph.md` (the two graphs, and a short one to copy), `docs/xin-pi.md`. Grep of both READMEs and the package's `docs/`: nothing else names what this milestone touched.
- [x] G4.6 the success list of `prd.html` checked item by item in the PR body
      Done, in the PR body.
