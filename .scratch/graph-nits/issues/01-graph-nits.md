# Ticket 01: graph nits from PR #141

Spec: `../01-graph-nits.md`. One PR.

- [ ] `dev.js` `branch`: branch from `main` only; fail with a clear message on a detached HEAD or another branch.
- [ ] `dev.js` and `release.js` `ci`: `gh pr view --json number,state` first; no open pull request (closed and merged do not count) fails at once with
      `ci: no open pull request for branch "<name>"` and gh's stderr.
- [ ] `dev.js` header and `branch` comment updated.
- [ ] `test/repo-graphs.test.ts`: behaviour tests for `branch` (main, detached, other branch) and `ci` (fake gh,
      fake sleep) in both files.
- [ ] `docs/graph.md` "Two graphs to read" updated.
- [ ] `npm run check` and the test file pass.
