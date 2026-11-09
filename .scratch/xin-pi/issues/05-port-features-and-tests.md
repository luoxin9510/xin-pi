# 05: Port the remaining features and the whole test inventory

**What to build:** everything v1-v3a and worktree/memory that is not covered by the tracer runs on current main: all suites ported, offline ones green under `npm test` in the package, the real-model ones passing by hand. Fixes for whatever broke on the newer pi are made here, each with the test that caught it.

**Blocked by:** 04

**Status:** done

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [x] `faults`, `panel`, `worktree`, `memory` ported and green with `npm test` in `packages/pipipi` (offline, runs under `env -i`: no auth, no haiku, git identity set inside the tests)
- [x] `real` (01-14), `parent` (01-04), `tui` (05-10, node-pty) green by hand with haiku against the xpi build; sandbox env is `XPI_CODING_AGENT_DIR` in all helpers/harnesses
- [x] `evals` (15 cases) and `stress` run; numbers compared with pipipi's last README numbers, differences explained
- [x] Root `npm test` / `./test.sh` still pass with the package's `test` script (spec open question 2)
- [x] Children: SIGTERM/SIGKILL grace checked against the rpc shutdown rework (facts.md section 2, item 1); no stray processes after stop-all
- [x] Codemode-only child (`child-codemode.ts`) works, or the built-in form chosen and recorded; agent `tools` still bind inside scripts (`test/real/09-codemode-only`)
- [x] Worktree isolation and agent memory work in a repo checkout of xin-pi itself (its own `.pi/worktrees/` exclude)
- [x] Every upstream contract that broke is listed in Comments with the fix and the test; `npm run check` green

## Comments

- 2026-11-09: done. Suites live in `packages/xpi-coding-agent/test/subagent/` (`faults`, `panel`, `worktree`, `memory`, `real`, `parent`, `tui`, `evals`, `stress`, `fake-pi.mjs`, `helpers.ts`). Scripts in the package: `test:subagent` (offline), `test:subagent:real|parent|tui|evals|stress`. The ticket text says `packages/pipipi` / `npm test`; per Grill 2 the package is xpi-coding-agent and the offline set is `test:subagent`.
- Results (haiku 5.5 only, temp `XPI_CODING_AGENT_DIR` with a copy of auth.json; built bundle): offline 129/129 (also under `./test.sh`'s empty environment: temp HOME, no git config); real 77/77 plus 4 new tests (about $0.023); parent 12/12; tui 13/13 (pty: ctrl+b with an empty editor and with text, `x` on a script row and on an agent row, `shift+x`, script rows, `/subagents worktrees`); evals `--runs 3` 51/51, $0.0156, 68 s wall (pi-pipipi README: 51/51, $0.037, 94 s); stress, 20 calls at limit 20: 20/20 on haiku, wall 5.1 s (README 5.3), latency p50/p95 3.6/4.8 s (4.7/5.2), queue wait + spawn p50/p95 12/14 ms (9/17), peak 20 children, RSS 3.5 GB (4.5 GB), $0.0035 ($0.0085). No stray `cli.js` processes after any seam.
- Root `npm test` / `./test.sh`: the package `test` script is now `npm run test:subagent && vitest --run`, so both include the offline set (it needs no auth and no network). `vitest.config.ts` excludes `test/subagent/**` (node:test files). Root `npm test` was not run end to end; the vitest part still has the 2 `resource-loader.test.ts` failures from ticket 03.
- Contracts re-checked from facts.md section 2: none of the upstream contracts broke. Every real, parent and tui test passed with no change to `src/`: rpc flags and events, session file shape, `before_provider_request`, nested ids, the `tui.focusedComponent` read, `ctx.modelRegistry.getAvailable()`, alias `haiku`, kitty key encodings. What changed was on our side of the move, and the tests were adapted:
  - `installBackground` and `scripts.start(...)` are gone (ticket 04). `faults/background-edges`, `bugfix-queue`, `bugfix-scripts`, `panel/scripts`, `panel/polish` (`/subagents stop`) and `parent/02` (registry unit test) now drive the real controller (`beginCodemodeScript`; `codemodeStandIn` in `test/subagent/helpers.ts` mirrors `executeCodemode`). The "backgroundScripts false" and "no UI" tests load the extension with that setting or `hasUI: false`, because tracking is decided by the extension instance (`enabled()`), not by a wrapper argument. B3 (a delivery handler throws) uses `loadTool(..., { sendThrows })`.
  - Found while porting: extension instances in one process stay connected to the controller (`connect` is undone only by the same instance's next `session_start`), so two `loadTool`s with the same session id both track a script. Tests that need a quiet session use a unique `sessionId`. Not an issue in the product (one instance per process).
  - `child-codemode.ts` is gone (ticket 01): `real/09-codemode-only` passes with the env-driven child (`XPI_SUBAGENT_CHILD_CODEMODE=only`); agent `tools` still bind inside scripts.
- New tests (not in pi-pipipi):
  - `real/15-shutdown-grace`: a child extension whose `session_shutdown` takes 3.5 s (end of run) or 2.5 s (after a stop) finishes before the run resolves, and the pid is gone afterwards. Passes with the current runner (settle grace 2 s, then SIGTERM, KILL_GRACE 5 s): the rpc child ignores the first SIGTERM while disposing, so a shutdown of up to about 7 s after settling is safe. A longer one (a slow MCP close) would be SIGKILLed and orphan its servers: known limit, unchanged.
  - `real/16-xin-pi-checkout`: isolation and `memory: project` in a local clone of xin-pi and in a linked worktree of it (the developers' layout, `.git` is a file): the `/.pi/worktrees/` exclude lands in the common `info/exclude`, the checkout stays clean, `.claude/agent-memory` (gitignored in xin-pi) is written and read back. Never creates worktrees in the checkout the tests run from.
- Harness changes: sandboxes copy auth.json instead of symlinking it; evals and stress now also sandbox (temp HOME and agent dir, `GIT_CONFIG_GLOBAL` with an identity), while in pi-pipipi they used the user's real environment; the pty harness resolves `node-pty` with `require.resolve` (hoisted) and drops the `--no-extensions -e ...` arguments (built-ins are on by default). `node-pty` 1.1.0 and `@xterm/headless` 5.5.0 (pi-pipipi used ^6.0.0; xpi-tui already pins 5.5.0) are dev dependencies of xpi-coding-agent. Biome has an override for `test/subagent/**`.
- Not done: pi-pipipi's `docs/porting.md` is not ported (ticket 07 covers docs); a "Testing the subagent extension" section is in `docs/xin-pi.md`.
