# 04: Native background scripts in the codemode built-in

**What to build:** the codemode extension gets the first-class "move this running script to the background" capability (spec shape A: `codemodeScripts` with `owner`, `background`, `backgroundAll`, `stop`, `subscribe`), including nested-call bookkeeping that survives the early return. pipipi's `src/background.ts` is reduced to policy and calls it. The `codemode` tool is no longer wrapped or replaced: no proxy `registerTool`, no "was not loaded" warning. v3a behaviour (results, messages, `run_in_background`, 8 KB cap) is unchanged.

**Blocked by:** 03

**Status:** ready-for-agent

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [ ] Failing coding-agent tests first (vitest, faux provider, `test/suite/harness.ts`) that prove or refute the inference in facts.md section 3: after an early return a later nested call reuses `<id>/1`, its usage is never recorded, `agent_end` clears the scope
- [ ] `NestedToolCallRunner` keeps a detached scope (ids continue, records and usage kept, released when the script ends); `agent_end` does not drop it; also test the `executionMode: "sequential"` queue with a detached script
- [ ] `executeCodemode` registers scripts, links main's signal only while foreground, races sandbox vs "moved", returns the early result with `details.background`, notifies `onEnd` with result or error; foreground path byte-for-byte unchanged when nothing calls `background`
- [ ] Controller exported from the package index; unit tests: early return, keeps running, stop, error end, Esc on main does not stop a background script, session shutdown
- [ ] pipipi: `installBackground` and the `registerTool` proxy deleted; the registry, end message, delivery and ctrl+b call the controller; `pipipi.backgroundScripts: false` means "never call `background()`"; print mode stays foreground
- [ ] The `test/parent` seam now drives the plain xpi binary; its suites (`01`-`04`) pass by hand with haiku
- [ ] Startup shows no codemode replacement warning; `/subagents`, panel rows `S1..`, `x`, ctrl+b checked in a pty (`test/tui/10-script-panel`) by hand
- [ ] `npm run check` green; the codemode changes listed in `docs/xin-pi.md` (file by file)

## Comments
