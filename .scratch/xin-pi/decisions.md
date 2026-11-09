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

## Grill 2 (2026-11-09): independence, slimming, rename (all as recommended)

The owner wants xin-pi to become his own agent for good. This supersedes earlier items where they conflict
(1, 2, 3's "smallest core change", 5's periodic merges, 9, 19's merge budget).

22. No more merging upstream. `upstream` stays as a remote for reading; `/upstream` recommends features to port
    (cherry-pick or rewrite), not merges. Core code may be changed freely.
23. Remove `packages/chord`, `packages/durable`, `packages/env`, `apps/p2`, `apps/p3` (coding-agent, ai, agent and tui do
    not depend on them), with the root build, workspaces, tsconfig paths and examples config cleaned.
24. Rename every package to an unscoped `xpi-` name with the directory renamed to match: xpi-ai, xpi-agent-core,
    xpi-tui, xpi-coding-agent, xpi-codemode, xpi-mcp, xpi-schema, xpi-telemetry, xpi-evals. Not published to npm now.
    The rename is done by a committed script, reusable to translate code ported from upstream.
25. pipipi lives inside coding-agent as a built-in extension (`src/extensions/pipipi/`, registered in
    `extensions/index.ts`), like codemode and mcp. No separate pipipi package, no `packages/xpi` launcher; the `xpi` bin
    and `piConfig.name: "xpi"` are on coding-agent.
26. App name and command `xpi`; env vars `XPI_*`; config dir stays the shared `~/.pi/agent` for now.
27. MIT: keep the original copyright notice, add the owner's line; README says it is based on pi by earendil-works.
28. Order: 01 (in progress, adapted to 25) → slim (23) → rename (24) → native codemode background → port the rest
    → /upstream → docs → freeze pi-pipipi → owner's look and switch.

29. (2026-11-09) No compatibility aliases for old `@earendil-works/*` imports in third-party extensions (pi-roost,
    critic-guy, pi-mobile, ...). They are ported to xpi later if needed; until then they may fail to load under xpi.
