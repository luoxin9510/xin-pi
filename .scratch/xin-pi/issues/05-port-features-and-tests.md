# 05: Port the remaining features and the whole test inventory

**What to build:** everything v1-v3a and worktree/memory that is not covered by the tracer runs on current main: all suites ported, offline ones green under `npm test` in the package, the real-model ones passing by hand. Fixes for whatever broke on the newer pi are made here, each with the test that caught it.

**Blocked by:** 04

**Status:** ready-for-agent

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [ ] `faults`, `panel`, `worktree`, `memory` ported and green with `npm test` in `packages/pipipi` (offline, runs under `env -i`: no auth, no haiku, git identity set inside the tests)
- [ ] `real` (01-14), `parent` (01-04), `tui` (05-10, node-pty) green by hand with haiku against the xpi build; sandbox env is `XPI_CODING_AGENT_DIR` in all helpers/harnesses
- [ ] `evals` (15 cases) and `stress` run; numbers compared with pipipi's last README numbers, differences explained
- [ ] Root `npm test` / `./test.sh` still pass with the package's `test` script (spec open question 2)
- [ ] Children: SIGTERM/SIGKILL grace checked against the rpc shutdown rework (facts.md section 2, item 1); no stray processes after stop-all
- [ ] Codemode-only child (`child-codemode.ts`) works, or the built-in form chosen and recorded; agent `tools` still bind inside scripts (`test/real/09-codemode-only`)
- [ ] Worktree isolation and agent memory work in a repo checkout of xin-pi itself (its own `.pi/worktrees/` exclude)
- [ ] Every upstream contract that broke is listed in Comments with the fix and the test; `npm run check` green

## Comments
