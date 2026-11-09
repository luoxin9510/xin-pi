# xin-pi: a pi distribution with pipipi built in

Status: needs-owner-approval

Decisions behind this spec: `decisions.md`, "Grill 1" (2026-11-09), items 1-8. Facts with file paths: `facts.md`.
pi-pipipi design history: `~/Developer/pi-pipipi/.scratch/` (v1, v2, v3a) and `~/Developer/pi-pipipi/docs/porting.md`.

## Problem Statement

My subagent work (pi-pipipi) lives in a separate repo as a pi extension. It has to wrap pi's `codemode` tool to get
background scripts, reaches into pi through a porting guide's worth of contracts, spawns children by calling whatever
`pi` is on the PATH, and breaks when pi moves. I also want more of my own extensions (pi-roost next) shipped together
with pi. A fork that I own, with these pieces built in, removes the wrapper, makes the child process always the same
build, and lets me change pi's core where an extension cannot do it cleanly. Today `xin-pi` is only a clone of upstream
(326 commits past v1.5.0).

## Solution

`xin-pi` `main` becomes a product line: upstream pi plus my packages. First piece: pi-pipipi moves in as
`packages/pipipi` (`@xin-pi/pipipi`) and loads as the built-in extension `builtin:pipipi`, on by default, off with
`-builtin:pipipi`. It is started with the new command `xpi`, which lives next to the global `pi` and shares
`~/.pi/agent`. Background scripts become a codemode capability (pipipi calls it; nothing wraps or replaces `codemode`).
Subagent children are launched from the running xpi build. The behaviour I have today (v3a: Agent tool, subagent panel
and screen, background scripts, worktrees, agent memory) does not change, and my everyday `pi` keeps loading the old
pi-pipipi until xpi is good enough to replace it.

## User Stories

1. As the owner, I want a command `xpi` built from this repo that runs next to my global `pi`, so that I can try the fork without touching my daily setup.
2. As the owner, I want `xpi` to use `~/.pi/agent` (auth, settings, sessions), so that I do not log in or configure twice.
3. As the owner, I want `xpi` to show its own name (title, help, debug log), so that I can tell which build I am in.
4. As the owner, I want `xpi` to never announce upstream pi releases as its own update, so that the update notice is not wrong.
5. As a user of `xpi`, I want the `Agent` tool and `/subagents` available without installing or configuring anything, so that pipipi is part of the product.
6. As a user of `xpi`, I want `-builtin:pipipi` (in `extensions` or `--no-extensions` plus others) to turn pipipi off like any built-in, so that I can run plain pi behaviour.
7. As a user of `xpi`, I want `pi config` / `xpi config` to list `builtin:pipipi` beside the other built-ins, so that I find the switch where I expect it.
8. As a user of `xpi`, I want a codemode script that starts a subagent to move to the background exactly as in v3a (same results, messages, ctrl+b, `x`, `run_in_background`), so that nothing I rely on changes.
9. As a user of `xpi`, I want no "built-in extension codemode was not loaded" warning and no second `codemode` tool, so that startup is clean.
10. As a codemode author in pi core, I want "move this running script to the background" to be a documented codemode capability with tests in the codemode extension's own suite, so that it is not an accident of a wrapper.
11. As main (the model), I want ids of nested calls to stay unique after a script is moved to the background, so that tool events and records are not ambiguous.
12. As a user of `xpi`, I want the cost of a background script's nested calls recorded somewhere, so that session totals are not silently low.
13. As a user of `xpi`, I want every subagent child to run the same xpi build as its parent (same binary, same dev flags in a source checkout), so that a global `pi` of another version never answers instead.
14. As a user of `xpi`, I want `pipipi.piCommand` and `PIPIPI_TEST_PI` to still override the child command, so that tests and special setups work.
15. As a user of `xpi`, I want children to finish their shutdown cleanly when stopped, so that a stopped agent leaves no stray process.
16. As a developer, I want packages/pipipi to build, type check, lint and format under the monorepo's `npm run check`, so that it follows the repo's rules.
17. As a developer, I want `npm test` in packages/pipipi to run offline suites quickly, and the real-model suites (real, parent, tui, evals, stress) to run only by hand, so that `./test.sh` (empty environment) stays green.
18. As a developer, I want all existing pipipi test suites ported and passing on current main, so that the move loses no coverage.
19. As a developer, I want `git merge upstream/main` to stay cheap: our changes in upstream-owned files are few, small and listed in one place, so that periodic merges rarely conflict.
20. As a developer, I want every piece of work on a branch from `main`, merged by PR, so that `main` always works.
21. As the owner, I want pi-pipipi's repo frozen at its current main with a README note "merged into xin-pi", so that there is one place to develop.
22. As the owner, I want my global `pi` and its pi-pipipi to keep working unchanged until I switch, so that I am never without a working agent.
23. As someone porting pipipi elsewhere, I want `docs/porting.md` to move with the package and be updated for the native codemode capability, so that the knowledge is kept.
24. As the owner, I want a clear list of what changed in upstream pi's core for xin-pi (`docs/xin-pi.md`), so that I can review and re-apply it after merges.
25. As the owner, I want the layout to take pi-roost next (`packages/roost`, same way), so that this first move is the template.

26. As the owner, I want `/upstream` in xpi to look at upstream pi and have the model compare it with xin-pi (new upstream features, fixes and breaking changes; conflicts with our changes; overlap with our built-ins) and recommend what to merge, port or skip, so that keeping up with upstream is a decision, not a chore.
27. As the owner, I want `/upstream` to be read-only (report only, no edits, no merge) and to save the report under `~/.pi/agent/upstream/`, so that I decide when to sync.

## Implementation Decisions

Layout and build

- `packages/pipipi`: `package.json` name `@xin-pi/pipipi`, `private: true` (no publish, skips `check:runtime-deps`), `type: module`, depends on `yaml` and (dev/peer) the pi workspace packages at exact versions (root `check:pinned-deps`). Sources under `src/`, tests under `test/` with the existing layout (`faults`, `panel`, `worktree`, `memory`, `parent`, `real`, `tui`), `evals/` and `stress/` kept. Root `tsconfig.json` gets a `paths` entry for `@xin-pi/pipipi`.
- Style: the move commit reformats with `npm run check` (tabs, width 120); no behaviour changes in that commit. `any` stays where it is (biome allows it) but is not added.
- Strip-types sources are fine for tests and dev, but coding-agent's build is `tsc` + esbuild from `dist/`, so the package needs a `tsconfig.build.json` and a `build` script, and a line in the root `build` chain before coding-agent (or the registration mechanism of open question 1).

Loading

- `builtin:pipipi` is an `InlineExtension` `{ name: "pipipi", factory, builtin: true }`. Not `replaceable` (it must never be silently dropped, and it does not register `codemode`). The existing guard `PIPIPI_DEPTH` stays: children get no Agent tool.
- Registration site follows decision 2 (`packages/coding-agent/src/extensions/index.ts`), subject to the dependency cycle in open question 1.

Command and naming

- `packages/coding-agent/package.json`: bin key `xpi` -> `dist/bundle/cli.js` (the `pi` bin is removed from this package so `npm link` cannot replace the global `pi`), `piConfig: { name: "xpi", configDir: ".pi" }`. Effects (all from `config.ts`): title and help say `xpi`, config dir stays `~/.pi/agent`, env overrides are `XPI_CODING_AGENT_DIR` and `XPI_CODING_AGENT_SESSION_DIR` (tests and docs use these). Literal `PI_*` variables keep their names.
- Version check and self-update: `xpi` skips the pi.dev latest-version check and does not offer `update self` for the upstream package (set `PI_SKIP_VERSION_CHECK` default in the launcher or gate in `utils/version-check.ts`; smallest diff wins).
- Dev launch: `./pi-test.sh` stays as it is (it runs the source as `xpi` once `piConfig` is set); add `./xpi-test.sh` only if a second name is wanted.

Native background capability (codemode)

- Add the typed controller of `facts.md` section 3, shape A (`codemodeScripts`: `owner`, `background`, `backgroundAll`, `stop`, `subscribe`), implemented in `extensions/codemode/execute.ts` (+ one new small file for the controller). It is the mechanism of today's `src/background.ts` wrapper, moved inside: own `AbortController` linked to main's signal only while foreground, a race between the sandbox and the "moved" promise, early return with the result pipipi chooses, end notification with result or error.
- `NestedToolCallRunner` learns a detached scope: after the codemode call returns early, the scope of its id (and counter) stays alive until the script ends, nested ids continue (`/n+1`), their records and usage are kept and handed to the end notification. `agent_end` `clear()` does not drop detached scopes. This is the only change outside `extensions/codemode/`.
- `src/background.ts` in pipipi shrinks to policy: the script registry rows (S1, S2...), the rule for moving (`Agent` call without `run_in_background`, pinned by `false`), the end message with the agent list and the 8 KB cap, delivery by `sendMessage` (`triggerTurn` when idle, `deliverAs: "steer"` when running), ctrl+b, stop on session shutdown. `installBackground` and its proxy of `registerTool` are deleted; `pipipi.backgroundScripts: false` simply makes pipipi never call `background()`.
- Print mode (`!ctx.hasUI`) keeps scripts in the foreground, as today.

Child processes

- A child launcher `piInvocation(args)` in packages/pipipi ports `getPiInvocation()` of `examples/extensions/subagent/index.ts`: `process.execPath` + `process.execArgv` + `process.argv[1]` (not a Bun virtual path), else the compiled binary itself. Used when `pipipi.piCommand` is unset; `piCommand` and `PIPIPI_TEST_PI` override. The default `"pi"` is gone.
- The `-e` for codemode-only children keeps working as a file path (`child-codemode.ts`, `createCodemodeExtension({ mode: "only" })`) unless ticket 3 finds a simpler built-in form.
- `runner.ts` waits for children after SIGTERM longer than `runtimeHost.dispose()` can take (rpc-mode now finishes disposal before exiting; a second signal force-exits).

Docs

- `packages/pipipi/README.md` and `docs/porting.md` move with the package (porting.md: layer 4 rewritten for the native capability; "Keeping up with pi" points at xin-pi). New `docs/xin-pi.md` (repo root docs): what xin-pi is, the `xpi` command, the list of core files we changed, merge procedure (`git fetch upstream && git merge upstream/main`, then re-run `npm run check` and the pipipi suites).
- The pi-pipipi repo: last commit adds a README note "merged into xin-pi (path)" and nothing else; no further development there.

Process

- Branch per ticket from `main`, PR on `luoxin9510/xin-pi`, independent review, merge; upstream merged into `main` by merge commit. Commit trailer per this session's attribution rules. No company information in repo, commits or PRs.

/upstream

- A command registered by `packages/xpi` (injected like pipipi). It gathers facts with git in `xinpi.sourceDir`
  (default `~/Developer/xin-pi`): `git fetch upstream`, upstream commits not in `main`, diffstat, the upstream-owned
  files xin-pi changed, new `CHANGELOG.md` entries; without a checkout it falls back to upstream's `CHANGELOG.md`.
  Facts go to a data file `~/.pi/agent/upstream/<stamp>-data.md`.
- No dedicated subagent: it injects a prompt into the current main agent (new turn when idle, steer when busy) with
  the data file path, the four report sections, the read-only rule and the report path `~/.pi/agent/upstream/<stamp>.md`.
  Main may delegate with the Agent tool itself. Read-only is an instruction, not enforced.

## Testing Decisions

- Port every existing suite unchanged in intent: `faults` (fake pi), `panel`, `worktree`, `memory` are offline and form `npm test` of the package; `real`, `parent`, `tui` (needs node-pty), `evals`, `stress` need haiku and `~/.pi/agent/auth.json` and run by hand (`npm run test:real` etc.) with `PIPIPI_TEST_PI` unset, so the child is the xpi build under test. The suites' sandbox sets `XPI_CODING_AGENT_DIR` (was `PI_CODING_AGENT_DIR`) in `test/real/helpers.ts`, `test/tui/harness.ts`, `test/parent/helpers.ts`, evals harness.
- The `test/parent` seam changes from "`--no-extensions -e builtin:codemode -e src/index.ts`" to the plain xpi binary with default built-ins, since pipipi is a built-in now.
- New codemode tests live in coding-agent's vitest suite (`packages/coding-agent/test/`), with the faux provider, no real model: early return on `background()`, script keeps running and ends, foreground behaviour unchanged, stop, end notification with result and error, nested id continuity and usage after the move (the facts.md inference is proved or refuted here first), Esc/abort of main does not stop a background script, `agent_end` does not drop it. Use `test/suite/harness.ts`; a test for the regression must exist before the fix.
- Tracer acceptance for the first ticket: `xpi` (built or from source) with `builtin:pipipi` loaded makes one real haiku `Agent` call and prints its answer.
- Existing prior art: `packages/coding-agent/test/nested-tool-calls.test.ts`, v3a `test/parent/`.
- The monorepo's default check is `npm run check` (+ `./test.sh` when asked); real-model results are recorded in ticket comments, as in pipipi.

## Out of Scope

- pi-roost (next project, same template: `packages/roost`).
- Any behaviour change of pipipi beyond what moving requires (v3b polish, new features).
- Publishing to npm or a package rename of upstream packages; a release process for xpi.
- Replacing the global `pi` on this machine, or editing `~/.pi/agent/settings.json`.
- Rebasing onto upstream; tracking upstream by anything but merges.
- A separate config dir for xpi (shared `~/.pi/agent` for now).

## Further Notes

- The v1.5.0 -> main diff touched few contracts pipipi uses (facts.md section 2): the rpc shutdown rework, `ModelRuntime`, `main.ts` dispose. Nothing was removed. The first ticket's real run decides whether anything else broke.
- The nested-id/usage defect after an early return is an inference from reading `nested-tool-calls.ts` and `agent-session.ts`; v3a worked because pipipi only needed prefix matching. Treat as a hypothesis until ticket 2's test.
- Merge-cost budget (story 19): upstream-owned files we expect to touch: `packages/coding-agent/package.json` (bin, piConfig, deps), `src/extensions/index.ts`, `src/extensions/codemode/{execute,index}.ts`, `src/core/nested-tool-calls.ts`, `src/index.ts` (one export), root `package.json` (build chain), root `tsconfig.json` (paths), `utils/version-check.ts` maybe. Anything beyond this list needs a line in `docs/xin-pi.md`.

## Resolved questions

Answered by the owner on 2026-11-09 ("all as recommended"):

1. Registration without a package cycle: a distribution package `packages/xpi` owns the `xpi` bin and `piConfig`
   (`name: "xpi"`, `configDir: ".pi"`); its entry calls coding-agent's `main()` and injects
   `{ name: "pipipi", factory, builtin: true }` through `extensionFactories`. Users see decision 2 unchanged
   (`builtin:pipipi`, on by default, `-builtin:pipipi`). coding-agent itself changes only for the codemode background
   capability. Ticket 1 spikes this first; pi-roost is injected the same way later.
2. The package's `npm test` is the offline subset (faults, panel, worktree, memory); real, parent, tui, evals and stress
   have their own script names and run by hand.
3. Old and new pipipi: all development tests use a temp `XPI_CODING_AGENT_DIR`; on switch day the owner removes the old
   pi-pipipi package from `settings.json` (ticket 6 says so).
4. The `xpi` entry skips the upstream version check by default; `update` commands are left alone.
