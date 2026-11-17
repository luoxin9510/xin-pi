# Tickets: milestone 4, the two graphs and the real-model check

Spec: `.scratch/xpi-graph/01-graph.md` (section 8, Tests, Docs). One PR (branch `graph-flows`), after milestone 3:
green CI, an independent Opus review.

- [ ] G4.1 `.pi/graphs/dev.js`: grill, spec, build, ci, review, merge, with `requires` and the review node's
      prompt that starts a fresh-context Opus subagent; the merge and push commands denied on `build` and on
      `review`
- [ ] G4.2 `.pi/graphs/release.js`: the flow of `.pi/skills/release.md` up to the tag. If the engine cannot express
      a step, stop and report it to the owner; do not extend the engine in this PR
- [ ] G4.3 a test that loads and checks both graphs, and that the dev graph without its `ci` node fails the load
- [ ] G4.4 by hand, real Haiku 5.5 only, in a temp repository with a local stand-in for CI and every node on Haiku
      (the lead runs it): the runs listed under "By hand" in the spec's Tests; the results and the cost per node
      change go in the PR
- [ ] G4.5 docs: the two graphs in `docs/graph.md`; a last grep of both READMEs, `docs/xin-pi.md` and the
      package's `docs/` for anything the four milestones touched
- [ ] G4.6 the success list of `prd.html` checked item by item in the PR body
