# 01: xpi-roost phase 1

Spec: `../01-roost-core.md`. One branch per PR, merged in order. Source: `~/Developer/pi-roost` at main `890cbe9`.
Every PR updates the docs it touches and lists them in its description.

**Status:** not started (spec approved by the owner on 2026-11-11)

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
- [ ] T4 Paths: state in `<agent dir>/xpi-roost/`, the runtime directory keyed by the agent directory (two levels
      under `/tmp`, both checked for owner and symlinks; short enough for a unix socket), `ROOST_HOME` and
      `ROOST_RUNTIME_DIR` overrides. Every `PI_ROOST_*` variable renamed `ROOST_*`, `PI_JOB_ID` and `PI_DAEMON_SOCK`
      too; the inventory lists the renames. The agent directory and the two entry paths are given to a client by its
      caller and travel to the daemon, hosts and sessions in their environment, never found by importing xpi
- [ ] T5 `host/main.ts` without telemetry and profile jobs, with `fixSpawnHelper`
- [ ] T6 `daemon/main.ts` with decision 4's ops: no task board, workspaces, concierge, orders, schedules, watches,
      messages, peers, `handback`, profiles, PR polling, worktree isolation, agent-definition dispatch or telemetry;
      `events` kept; restart of a session whose agent process crashed and reconciliation at start kept (DM-5), a
      session whose host is gone ends (no M38); settings read from the
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

- [ ] T9 `xpi roost <subcommand>` in `src/main.ts`: `ls`/`list` (`--all`, `--cwd`, `--json`), `logs`/`log`, `attach`,
      `reply`, `stop`, `rm`, `respawn` (`--all`), `daemon status|logs|stop` (`stop --keep-workers`), the internal
      command that runs the daemon; help text; an unknown subcommand is an error; `hub` says it is not there yet
      until PR 4
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

## PR 3: `builtin:roost`, the session side (branch `roost-session`)

- [ ] T13 The extension, listed in `src/extensions/index.ts`; does nothing in a subagent child
      (`XPI_SUBAGENT_DEPTH`); where roost cannot run it only gives the messages of T11. The session write lock
      (DM-8): taken at `session_start`, released at `session_shutdown`, in every xpi session
- [ ] T14 `xpi --bg "<task>"` and `--bg-name`: an xpi session started under the daemon, with the agent directory,
      state and runtime directories in its environment (the allow and deny lists do not apply to these); the hint
      it prints says `xpi roost attach` and `xpi roost ls --json`
- [ ] T15 Worker role (`worker.ts`, the parts of `worker-extras.ts` in scope): reports of state, waiting, dialogs,
      context and model; replies delivered and acked; the session's slash-command list written for the peek; the
      earlier history (M53); detach keys from the user's keybindings (`app.suspend`, `app.clear` twice, `app.exit`
      twice; the first `app.clear` still clears the editor; key releases skipped; with a dialog open only the
      suspend key acts), the left arrow on an empty editor (AGENTS.md exemption) and a submitted `/quit` or `/exit`;
      the recap on attach without the summary model's branch; `attachSignal: true` reported only with the SIGUSR2
      handler installed; no repaint on attach (M14, dead with a current host), no automatic naming, `handback`,
      peers or agent tools
- [ ] Tests (in `xpi-coding-agent`): reply queue, reporter, worker wiring, earlier history, detach keys with default
      and rebound keybindings, the write lock, an attach does not end a session (SIGUSR2); real Haiku: `xpi --bg`
      starts a session that reports working then idle, `xpi roost reply` gets an answer, `xpi roost attach` shows
      the session and detaches
- [ ] Docs: `packages/xpi-coding-agent/docs/roost.md` (first version: background sessions and the CLI), `cli.md`,
      `docs.json`, `extensions.md` if the extension API is touched

## PR 4: the hub (branch `roost-hub`)

- [ ] T16 `hub/` on `xpi-tui`: agent view (split: no board, concierge, schedule, pr, worktree, task or
      agent-definition code), overlay host, the log and usage overlays, the editor for a new session's prompt; the
      tasks, workspaces, review, concierge, schedules and compare overlays are not ported and their keys are gone from
      the help
- [ ] T17 `xpi roost hub [dir]` and `/agents`; hub options from xpi (models, presets without `worktree`, `agent` and
      `fanout`, resume); settings written back through xpi's settings
- [ ] T18 The table of xpi's built-in slash commands with how the hub runs each, in `builtin:roost`, and the test
      that every command in `BUILTIN_SLASH_COMMANDS` has a class
- [ ] T19 `/bg` (alias `/background`) and `/bg-fork`, opening the hub after the hand-off; the left arrow on an empty
      editor behind `leftArrowOpensAgents`; AGENTS.md: the hub's files and the left-arrow check in the key exemption
      list
- [ ] Tests: the hub's tests in scope; foreground (`/bg`) tests in `xpi-coding-agent`; a pty test of `xpi roost hub`
      (list, peek, reply, attach, detach); real Haiku: two sessions in parallel, reply to one from peek, attach to
      the other, `/bg` moves a foreground session to the daemon and it appears in the hub
- [ ] Docs: `roost.md` (the hub and its keys, `/bg`), `slash-commands.md`, `cli.md`

## PR 5: docs and release (branch `roost-docs`)

- [ ] T20 `roost.md` complete; README files; `docs/xin-pi.md`; `packages/xpi-roost/docs/porting.md` cut to phase 1;
      the inventory updated; what was left out and by which decision
- [ ] T21 pi-roost: the README notice merged; the repository archived when the owner says so
- [ ] Release (patch or minor, by what changed for users), Node smoke test including `xpi roost`

## After phase 1

- [ ] Phase 2 spec: schedules and resume after an interruption
- [ ] Agent teams spec (messages between sessions, watches), with the owner
