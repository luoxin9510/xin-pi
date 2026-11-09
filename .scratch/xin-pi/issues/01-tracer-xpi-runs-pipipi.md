# 01: Tracer: `xpi` runs with `builtin:pipipi` and makes one real Agent call

**What to build:** the thinnest end-to-end slice. pi-pipipi's `src/` is copied into `packages/coding-agent/src/extensions/pipipi` (see the design change in Comments), formatted by `npm run check`, loaded as the built-in extension `builtin:pipipi`, and started with the command `xpi`. In a temp agent dir, `xpi` makes a real haiku `Agent` call from a codemode script and prints the child's answer. Background scripts still use the old wrapper (replaced in 02), children are launched from the running build.

**Blocked by:** None (can start immediately)

**Status:** closed (done 2026-11-09)

- [x] Spike first and record in Comments (answered for the first layout, then superseded by the owner's design change below)
- [x] pipipi source moved (one verbatim commit, one reformat commit, then wiring); root `build` chain / `tsconfig` `paths` not needed in the new layout
- [x] `xpi` command: coding-agent `bin` is `xpi`, `piConfig.name = "xpi"`, `configDir: ".pi"`; `./pi-test.sh` runs it from source (no second launcher needed); `--help` says `xpi`; `XPI_CODING_AGENT_DIR` redirects the agent dir; the upstream version check is skipped
- [x] Child launcher `piInvocation` (execPath + execArgv + argv[1]) replaces the `"pi"` default; `pipipi.piCommand` / `PIPIPI_TEST_PI` still override
- [x] `xpi` in a temp agent dir (auth copied) shows the `Agent` tool and `/subagents`; `-builtin:pipipi` removes both; the `codemode` replacement warning is recorded below
- [x] One real haiku call: a codemode script `await tools.Agent({ prompt: "Reply OK" })` returns the child's text; the child process was started from the same build (argv below)
- [x] Contract re-check recorded from facts.md section 2
- [x] `npm run check` green (full output)

## Comments

### Design change (owner, 2026-11-09, mid-ticket)

xin-pi is fully independent (no upstream merges) and pipipi lives INSIDE coding-agent: `packages/coding-agent/src/extensions/pipipi/`, registered in `src/extensions/index.ts` as `{ name: "pipipi", factory, builtin: true }` (not replaceable). No `packages/pipipi`, no `packages/xpi`. The command comes from coding-agent itself (`bin.xpi`, `piConfig.name = "xpi"`). Package and directory renames, and deleting chord/durable/env/apps, are separate tickets. Everything first built as `packages/pipipi` + `packages/xpi` (with a `PI_APP_NAME` env hook, a `setupCli` export and a source-resolver alias) was dropped and redone; none of it is in the history.

### Spike (short)

The earlier spike found that `main(args, { extensionFactories })` already merges injected built-ins with `-builtin:`/`xpi config` support, and that `piConfig` is only read from coding-agent's own package.json. With the new layout none of that is needed: the built-in is in `builtInExtensions`, and `piConfig` is edited in place. Confirmed by runs: `xpi config` (pty) shows `[x] pipipi` under Built-in > Extensions; toggled off in settings (`"extensions": ["-builtin:pipipi"]`) it shows `[ ] pipipi`, `/subagents` goes to the model as a plain message, and the model sees no `Agent` in the codemode declarations.

### What changed (coding-agent files, for docs/xin-pi.md)

- `package.json`: `bin` `xpi`, `piConfig.name` `xpi`, `copy-assets` also copies `src/extensions/pipipi/builtin/*.md` to `dist/extensions/pipipi/builtin`.
- `src/extensions/index.ts`: registers pipipi.
- `src/cli/setup.ts`: `PI_SKIP_VERSION_CHECK ??= "1"` (version check skipped).
- Env override names are now `XPI_CODING_AGENT_DIR` / `XPI_CODING_AGENT_SESSION_DIR`: renamed in coding-agent tests, evals, docs (not the CHANGELOGs) and `scripts/*smoke*`, `scripts/profile-coding-agent-node.mjs`. `scripts/coding-agent-smoke.mjs` reads `manifest.bin.xpi`. `scripts/local-release.mjs` still names `pi` (release is out of scope here).
- `src/extensions/pipipi/` (new): imports rewritten to relative imports into coding-agent (`core/extensions/types.ts`, `core/session-manager.ts`, `modes/interactive/{components,theme}`, `../codemode/index.ts`); `pi-tui`, `pi-ai`, `typebox`, `yaml` stay package imports.
- Deviations inside pipipi forced by the bundle (`dist/bundle/cli.js` has no `child-codemode.ts` or `builtin/` next to it):
  - `discovery.ts`: `BUILTIN_DIR` = `<packageDir>/(src|dist)/extensions/pipipi/builtin`.
  - `child-codemode.ts` is gone; a codemode-only child is told by env (`PIPIPI_CHILD_CODEMODE=only`, plus `PIPIPI_DEPTH=1`) and the pipipi factory registers `createCodemodeExtension({ mode: "only" })` itself. The `-e <file>` argument disappears from the child argv (ticket 03 must adjust tests that assert it).
  - `invocation.ts` (new): `piInvocation()` = `process.execPath` + `process.execArgv` + `process.argv[1]` (compiled binary: itself; last fallback `xpi`). Order of precedence: `pipipi.piCommand`, `PIPIPI_TEST_PI`, the running build.

### Run xpi

From source: `./pi-test.sh [args]`. Built: `npm run build`, then `node packages/coding-agent/dist/bundle/cli.js [args]`. Always with a temp agent dir: `mkdir /tmp/xpi-agent-01 && cp ~/.pi/agent/auth.json /tmp/xpi-agent-01/ && export XPI_CODING_AGENT_DIR=/tmp/xpi-agent-01`, and run in an empty directory (a repo dir asks for project trust).

### Real haiku call

`xpi -p --model anthropic/claude-haiku-5-5 --tools +codemode --no-session 'Call the codemode tool exactly once ... return await tools.Agent({ description: "ok", prompt: "Reply with the single word OK" });'`
Result, source and built: `{"agentType":"general-purpose","model":"anthropic/claude-haiku-5-5","status":"completed","output":"OK",...}` (about $0.001 each). Child argv sampled with `ps`:

- source: `node --import file://$R/packages/coding-agent/src/experimental/source-resolver.ts $R/packages/coding-agent/src/cli.ts --mode rpc --model anthropic/claude-haiku-5-5 --thinking medium --tools +codemode --approve --no-session --system-prompt ...`
- built: `node $R/packages/coding-agent/dist/bundle/cli.js --mode rpc --model anthropic/claude-haiku-5-5 --thinking medium --tools +codemode --approve --no-session --system-prompt ...`

Same build as the parent in both. About 9 haiku calls overall, plus two chat answers from the default model in the `/subagents` check without pipipi (a prompt without `--model`).

Recorded warning (expected until ticket 02): `Extension builtin:pipipi registers tool codemode, so built-in extension codemode was not loaded`. pipipi still wraps and re-registers `codemode` (old `background.ts`).

### Contract re-checks (facts.md section 2)

- `tui.focusedComponent`: still a private field (`packages/tui/src/tui.ts` L515); pipipi reads it through a cast in `panel.ts`. A public `getFocusedComponent()` exists now; switching is ticket 03's option.
- `ctx.modelRegistry.getAvailable()`: exists (`core/model-registry.ts` L68); `subagent-screen.ts` type checks.
- Alias `haiku` -> `anthropic/claude-haiku-5-5` resolves on the current catalog (real runs).
- rpc SIGTERM grace: `runner.ts` SIGTERM then SIGKILL after `KILL_GRACE_MS = 5000`; rpc-mode now runs `runtimeHost.dispose()` on the first SIGTERM and only a second signal force-exits. Codemode-only children dispose fast; a child with MCP could exceed 5 s. Unchanged here; for tickets 02/03 (spec: wait longer than dispose).

### Tests

pipipi's tests are not copied (tickets 03 puts them under `packages/coding-agent/test/pipipi/`). Not run: `./test.sh` and the coding-agent vitest suite (only the env var rename touched tests).

### `npm run check`

Green on the final tree (see the report).
