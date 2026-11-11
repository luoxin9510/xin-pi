# 01: xpi-roost phase 1

Spec: `../01-roost-core.md`. One branch per PR, merged in order. Source: `~/Developer/pi-roost` at main `890cbe9`.

**Status:** not started (the spec waits for the owner's approval)

## Before PR 1

- [ ] pi-roost 0.1.21: release PR with M79 and M80 and a README notice that the project continues in xin-pi; tag and
      GitHub release; npm is the owner's
- [ ] An inventory committed with PR 1 (`packages/xpi-roost/docs/port-inventory.md`): every pi-roost source and test
      file, marked ported, cut (with the decision that cuts it) or split, so a reviewer can check the cut

## PR 1: core processes (branch `roost-core`)

- [ ] T1 `packages/xpi-roost`: package.json (private, version in step with the others), tsconfig, vitest config,
      workspace and root tsconfig wiring, `npm run check` covers it
- [ ] T2 `lib/` for phase 1: client, protocol, framing, store, atomic, locks, events, job-events, dispatch,
      dispatch-input, worker-state, view-model, term-modes, term-signals, attach, transcript, usage, config, schema,
      protocol-schema and callers (rows of unported ops removed), orphans, heuristics, and what these import
- [ ] T3 `host/main.ts` as it is
- [ ] T4 `daemon/main.ts` with phase 1's ops only: the injected modules of the task board, workspaces, concierge,
      orders, schedules, watches, comms, profiles, PR polling and telemetry are not wired and their ops are gone; an
      unknown op answers as today
- [ ] T5 Tests in scope moved; tests of cut features removed whole; each kept test file still fails when its subject
      is broken (spot-checked by deleting a guard, as in M66 and M70)
- [ ] T6 CI job `test (roost)` on Linux; the orphan sweep runs after the suite; no roost test starts a test runner
- [ ] Docs: `docs/xin-pi.md` (the new package), the inventory, `packages/xpi-roost/README.md`

## PR 2: command line and packaging (branch `roost-cli`)

- [ ] T7 `xpi roost <subcommand>` in `src/main.ts`: `hub` (answers "not yet" until PR 4), `ls`/`list`, `logs`,
      `attach`, `reply`, `stop`, `rm`, `respawn`, internal `daemon`; help text; unknown subcommand is an error
- [ ] T8 Bundle: entry files for the daemon and the host, started with the running Node; the entry-graph and
      runtime-dependency checks know them
- [ ] T9 `node-pty` as an optional dependency; `@xterm/*` bundled or declared; install-lock refreshed; the message
      when `node-pty` does not load, when there is no Node runtime (standalone binary), and on Windows
- [ ] T10 Settings: the `"roost"` section (global and project, the keys a project may not set), its schema and
      `docs/settings.md`; `roost.json` is not read
- [ ] T11 State under `<agent dir>/roost/`, following `XPI_CODING_AGENT_DIR`; a test that a temporary agent directory
      isolates a daemon completely (socket, jobs, roster)
- [ ] Tests: the CLI against a real daemon in a temporary agent directory; the packed npm tarball starts a daemon
      and a shell-command session (`release:local` smoke); real Haiku not needed yet
- [ ] Docs: `docs/cli.md`, `docs/settings.md`, `docs/xin-pi.md`

## PR 3: `builtin:roost`, the session side (branch `roost-session`)

- [ ] T12 The extension, listed in `src/extensions/index.ts`; does nothing in a subagent child (`XPI_SUBAGENT_DEPTH`)
      and nothing when roost cannot run on this machine beyond the messages of T9
- [ ] T13 Worker role: a session the daemon started reports state, waiting, dialogs, context and model
      (`worker.ts`, the parts of `worker-extras.ts` in scope)
- [ ] T14 `/bg` (alias `/background`) and `/bg-fork`; foreground registration (`foreground.ts`, without peers and
      agent tools)
- [ ] Tests: offline with a fake daemon where pi-roost has them; real Haiku: `xpi roost` starts a session, it
      reports working then idle, `reply` gets an answer, `/bg` moves a foreground session to the daemon
- [ ] Docs: `docs/roost.md` (first version), `docs/extensions.md` if the extension API is touched

## PR 4: the hub (branch `roost-hub`)

- [ ] T15 `hub/` on `xpi-tui`: agent view, overlay host, the log and usage overlays, the task editor used for a new
      session's prompt; the tasks, workspaces, review, concierge, schedules and compare overlays are not ported and
      their keys are gone from the help
- [ ] T16 `/agents` in a session and `xpi roost hub [dir]` in a terminal; hub options from xpi (models, presets,
      resume, the session's slash commands)
- [ ] T17 Earlier history when entering a session (M53)
- [ ] Tests: the hub's tests in scope; a pty test of `xpi roost hub` (list, peek, reply, attach, detach); real Haiku:
      two sessions in parallel, reply to one from peek, attach to the other
- [ ] Docs: `docs/roost.md` (the hub, keys), `docs/keybindings.md` if keys are configurable

## PR 5: docs and the porting document (branch `roost-docs`)

- [ ] T18 `docs/roost.md` complete; README files; `docs/xin-pi.md`; `packages/xpi-roost/docs/porting.md` cut to phase
      1; `packages/xpi-roost/docs/protocol.md` generated, with the test that keeps it current
- [ ] T19 The inventory updated; the roadmap of what was left out, with the decision that left it
- [ ] Release (patch or minor, by what changed for users), Node smoke test including `xpi roost`

## After phase 1

- [ ] Phase 2 spec: schedules and resume after an interruption
- [ ] Agent teams spec (messages between sessions, watches), with the owner
