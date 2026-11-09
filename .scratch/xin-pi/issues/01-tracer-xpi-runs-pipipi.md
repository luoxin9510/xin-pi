# 01: Tracer: `xpi` runs with `builtin:pipipi` and makes one real Agent call

**What to build:** the thinnest end-to-end slice. pi-pipipi's `src/` is copied into `packages/pipipi` (`@xin-pi/pipipi`, private), formatted by `npm run check`, loaded as the built-in extension `builtin:pipipi`, and started with the command `xpi`. In a temp agent dir, `xpi` makes a real haiku `Agent` call from a codemode script and prints the child's answer. Background scripts still use the old wrapper (replaced in 02), children are launched from the running build.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Spike first and record in Comments: how `builtin:pipipi` gets registered without a package cycle (spec open question 1: `main(args, { extensionFactories })` from the `xpi` entry vs import in `extensions/index.ts`); pick the cheapest that keeps `-builtin:pipipi` working
- [ ] `packages/pipipi` exists: `package.json` (`@xin-pi/pipipi`, private, exact-pinned deps), `src/`, root `tsconfig.json` `paths`, build wiring (root `build` chain or the chosen mechanism); the move itself is one commit with no behaviour change, the reformat another
- [ ] `xpi` command: coding-agent `bin` -> `xpi`, `piConfig.name = "xpi"`, `configDir: ".pi"`; `./pi-test.sh --help` says `xpi`; `XPI_CODING_AGENT_DIR` redirects the agent dir; version check skipped
- [ ] Child launcher `piInvocation` (execPath + execArgv + argv[1]) replaces the `"pi"` default; `pipipi.piCommand` / `PIPIPI_TEST_PI` still override
- [ ] `xpi` in a temp agent dir (auth copied) shows the `Agent` tool and `/subagents`; `-builtin:pipipi` removes both; no `codemode` replacement warning from pipipi at this stage is acceptable only if recorded
- [ ] One real haiku call: a codemode script `await tools.Agent({ prompt: "Reply OK" })` returns the child's text; the child process was started from the same build (check its argv)
- [ ] Contract re-check recorded from facts.md section 2: `tui.focusedComponent`, `ctx.modelRegistry.getAvailable()`, alias `haiku` resolves on the current catalog, rpc SIGTERM grace in `runner.ts` vs the new shutdown
- [ ] `npm run check` green (full output)

## Comments
