# xin-pi decisions

## Grill 1 (2026-11-09)

1. pi-pipipi moves into the monorepo as workspace package `packages/pipipi`, package name `@xin-pi/pipipi`; later pi-roost goes to `packages/roost` the same way.
2. Loaded as a built-in extension `builtin:pipipi` registered in packages/coding-agent/src/extensions/index.ts, on by default, disabled with `-builtin:pipipi`.
3. Background scripts are implemented natively in the codemode built-in extension: codemode exposes a first-class "move this running script to the background / return early, keep running" capability that pipipi calls. No wrapper, no tool replacement, no "was not loaded" warning. v3a behaviour and tests stay the same.
4. Based on upstream latest main; fix whatever breaks in pi-pipipi on the newer pi while moving it.
5. xin-pi `main` is the product line; upstream is merged in periodically (no rebase); every piece of work on a branch from main, PR, merge.
6. The command is `xpi`, living alongside the globally installed `pi`; config dir shared `~/.pi/agent` for now.
7. Development moves to xin-pi; the pi-pipipi repo is frozen at its current main with a README note "merged into xin-pi"; the owner's local pi keeps loading pi-pipipi until xpi works.
8. packages/pipipi keeps node:test and its existing suites; `npm test` inside the package; real-model tests are not part of the monorepo's default check, run by hand in the package.

## Grill 1 addendum (2026-11-09): spec gaps, all as recommended

9. `packages/xpi` (bin `xpi`, `piConfig.name: "xpi"`) injects builtin:pipipi via `main(args, { extensionFactories })`;
   coding-agent is changed only for the codemode background capability.
10. Package `npm test` = offline suites; real/parent/tui/evals/stress run by hand under their own scripts.
11. Development tests use a temp `XPI_CODING_AGENT_DIR`; the old pi-pipipi entry leaves settings.json on switch day.
12. `xpi` skips the upstream version check by default.

## Grill 1 addendum 2 (2026-11-09): /upstream, all as recommended (owner's change on S5)

13. `/upstream` command (no key binding) in xpi.
14. Source: local git in `xinpi.sourceDir` (default `~/Developer/xin-pi`), `git fetch upstream`; fallback to upstream
    `CHANGELOG.md` when there is no checkout.
15. Report: upstream changes (features / fixes / breaking), conflicts with our changes, overlap with our built-ins
    (adopt upstream's or keep ours), recommendation list (merge as-is / port or adapt / skip, reason, risk).
16. Read-only first version: report and a suggested next step; merging is a separate request through branch + PR.
17. Owner's change: no dedicated read-only subagent. `/upstream` gathers the data itself and injects a prompt into the
    normal main agent, which may delegate on its own.
18. Summary to main, full report at `~/.pi/agent/upstream/<stamp>.md`.
19. Ticket 04, after porting (03); docs, freeze and the owner's look move to 05-07.

20. Renamed by the owner (2026-11-09): the command is `/upstream` (was `/sushi`); reports under `~/.pi/agent/upstream/`.

## Owner direction (2026-11-09): xpi replaces the global pi

21. When xin-pi is done and the owner's look passes, the owner switches for good: install `xpi` globally, drop the old
    pi-pipipi entry from `~/.pi/agent/settings.json`, uninstall the global `@earendil-works/pi-coding-agent`, and develop
    only xpi from then on. Checked: pi-roost and pi-mobile do not spawn the `pi` binary; the `com.nuckcole.pi-update`
    launchd job only runs `git pull` in ~/Developer/nukcole-pi. The uninstall is confirmed with the owner when it happens.
