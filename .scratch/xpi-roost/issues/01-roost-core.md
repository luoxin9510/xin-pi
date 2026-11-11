# 01: xpi-roost phase 1

Spec: `../01-roost-core.md`. One branch per PR, merged in order. Source: `~/Developer/pi-roost` at main `890cbe9`.
Every PR updates the docs it touches and lists them in its description.

**Status:** not started (the spec waits for the owner's approval)

## Before PR 1

- [ ] pi-roost 0.1.21: release PR with what is on main and a README notice that the project continues in xin-pi; tag
      and GitHub release; npm is the owner's

## PR 1: core processes (branch `roost-core`)

- [ ] T1 `packages/xpi-roost`: package.json (private, version in step with the others), tsconfig, vitest config,
      workspace and root tsconfig wiring, `npm run check` covers it
- [ ] T2 `packages/xpi-roost/docs/port-inventory.md`: every pi-roost source and test file as ported, split or cut,
      with the spec decision that cuts it
- [ ] T3 `lib/` for phase 1. Moved whole: client, framing, atomic, locks, job-events, dispatch-input, worker-state,
      term-modes, attach, transcript, usage, schema, orphans, heuristics, identity, paths, workspace-env. Split (the
      kept part moves): protocol, protocol-schema, callers, config, dispatch, store, view-model, filter, events,
      agent-client (`Reporter` and `jobIdentity` only). Not moved: everything decision 6 names, `term-signals.ts`
      (profile jobs only), `pi-resolve.ts`, `pi-commands.ts`
- [ ] T4 Paths: state in `<agent dir>/xpi-roost/`, the runtime directory keyed by the agent directory (short enough
      for a unix socket), `ROOST_HOME` and `ROOST_RUNTIME_DIR` overrides, only the `ROOST_` prefix. The agent
      directory and the two entry paths are given to the library by its caller, never found by importing xpi
- [ ] T5 `host/main.ts` without telemetry and profile jobs
- [ ] T6 `daemon/main.ts` with decision 4's ops: no task board, workspaces, concierge, orders, schedules, watches,
      messages, peers, profiles, PR polling, worktree isolation, agent-definition dispatch or telemetry; crash
      restart and reconciliation kept, with an interrupted session ending instead of resuming; settings read from the
      `"roost"` section of `<agent dir>/settings.json`; an unknown op answers as today
- [ ] T7 Tests in scope moved; tests of cut features removed whole; one deleted guard per kept test file shows the
      test failing; a test that two daemons with different agent directories do not share a socket, jobs or roster
- [ ] T8 CI: job `test (roost)` on Linux with `npm rebuild node-pty`; `xpi-roost` out of `test (other)` and of
      `./test.sh`'s default walk; the orphan sweep after the suite; no roost test starts a test runner. `node-pty`,
      `@xterm/headless` 6 and `@xterm/addon-serialize` as the package's own dependencies (the pin check and the
      lockfile change reviewed in the PR)
- [ ] Docs: `docs/xin-pi.md` (the new package, how it is tested), `packages/xpi-roost/README.md`, the inventory,
      `packages/xpi-roost/docs/protocol.md` generated with the test that keeps it current

## PR 2: command line and packaging (branch `roost-cli`)

- [ ] T9 `xpi roost <subcommand>` in `src/main.ts`: `ls`/`list` (`--json`), `logs`/`log`, `attach`, `reply`, `stop`,
      `rm`, `respawn` (`--all`), `daemon status|logs|stop`, the internal command that runs the daemon; help text; an
      unknown subcommand is an error; `hub` says it comes with the next version until PR 3
- [ ] T10 Bundle: entry files for the daemon and the host (as `codemode-worker.js`), found by `xpi-coding-agent` and
      handed to `xpi-roost`; the entry-graph and runtime-dependency checks know them; the version message when a
      client meets a daemon of another version
- [ ] T11 `node-pty` as an optional dependency of `xpi-coding-agent`, imported only when a host starts; the
      install-lock allowlist entry with its reason; install-lock refreshed; the messages when `node-pty` does not
      load, when there is no Node runtime (standalone binary), and on Windows
- [ ] T12 Settings: the `"roost"` section (the keys of decision 9, the keys a project may not set), its schema;
      `roost.json` is not read
- [ ] Tests: the CLI against a real daemon in a temporary agent directory (a shell-command session started through
      the client library); the packed npm tarball starts a daemon and a shell-command session (`release:local`)
- [ ] Docs: `packages/xpi-coding-agent/docs/cli.md`, `settings.md`, `environment-variables.md`, `docs/xin-pi.md`

## PR 3: the hub (branch `roost-hub`)

- [ ] T13 `hub/` on `xpi-tui`: agent view (split: no board, concierge, schedule, pr, worktree, task or agent-definition
      code), overlay host, the log and usage overlays, the editor for a new session's prompt; the tasks, workspaces,
      review, concierge, schedules and compare overlays are not ported and their keys are gone from the help
- [ ] T14 `xpi roost hub [dir]`; hub options from xpi (models, presets, resume, the session's slash commands read
      from xpi, not from a copied table)
- [ ] T15 New xpi sessions from the hub; attach with replay and several windows; earlier history when entering a
      session (M53; its tests in `xpi-coding-agent` if they need the adapter)
- [ ] T16 AGENTS.md: the hub's files in the key exemption list
- [ ] Tests: the hub's tests in scope; a pty test of `xpi roost hub` (list, peek, reply, attach, detach); real Haiku:
      two sessions in parallel, reply to one from peek, attach to the other
- [ ] Docs: `packages/xpi-coding-agent/docs/roost.md` (first version: the hub and its keys), `docs.json`

## PR 4: `builtin:roost`, the session side (branch `roost-session`)

- [ ] T17 The extension, listed in `src/extensions/index.ts`; does nothing in a subagent child
      (`XPI_SUBAGENT_DEPTH`); where roost cannot run it only gives the messages of T11
- [ ] T18 Worker role: a session the daemon started reports state, waiting, dialogs, context and model (`worker.ts`,
      the parts of `worker-extras.ts` in scope)
- [ ] T19 `/agents`; `xpi --bg "<task>"` and `--bg-name`; `/bg` (alias `/background`) and `/bg-fork`, opening the hub
      after the hand-off; the left arrow on an empty editor behind `leftArrowOpensAgents` (AGENTS.md exemption)
- [ ] Tests (in `xpi-coding-agent`): foreground, reply queue, reporter, worker wiring; real Haiku: `xpi --bg` starts a
      session that reports working then idle, `xpi roost reply` gets an answer, `/bg` moves a foreground session to
      the daemon and it appears in the hub
- [ ] Docs: `roost.md` (sessions, `/bg`, `--bg`), `slash-commands.md`, `cli.md`, `extensions.md` if the extension API
      is touched

## PR 5: docs and release (branch `roost-docs`)

- [ ] T20 `roost.md` complete; README files; `docs/xin-pi.md`; `packages/xpi-roost/docs/porting.md` cut to phase 1;
      the inventory updated; what was left out and by which decision
- [ ] T21 pi-roost: the README notice merged; the repository archived when the owner says so
- [ ] Release (patch or minor, by what changed for users), Node smoke test including `xpi roost`

## After phase 1

- [ ] Phase 2 spec: schedules and resume after an interruption
- [ ] Agent teams spec (messages between sessions, watches), with the owner
