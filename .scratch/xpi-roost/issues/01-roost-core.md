# 01: xpi-roost phase 1

Spec: `../01-roost-core.md`. One branch per PR, merged in order. Source: `~/Developer/pi-roost` at main `890cbe9`.
Every PR updates the docs it touches and lists them in its description.

**Status:** PR 1 built on `roost-core` (spec approved by the owner on 2026-11-11)

## Before PR 1

- [ ] pi-roost 0.1.21: release PR with what is on main and a README notice that the project continues in xin-pi; tag
      and GitHub release; npm is the owner's

## PR 1: core processes (branch `roost-core`)

- [x] T1 `packages/xpi-roost`: package.json (private, version in step with the others), tsconfig, vitest config,
      workspace and root tsconfig wiring, `npm run check` covers it
- [x] T2 `packages/xpi-roost/docs/port-inventory.md`: every pi-roost source and test file as ported, split or cut,
      with the spec decision that cuts it
- [x] T3 `lib/` for phase 1. Moved whole: client, framing, atomic, locks, job-events, dispatch-input, worker-state,
      term-modes, attach, transcript, usage, schema, orphans, heuristics, identity, paths, workspace-env. Split (the
      kept part moves): protocol, protocol-schema, callers, config, dispatch, store, view-model, filter, events,
      agent-client (`Reporter` and `jobIdentity` only). Not moved: everything decision 6 names, `term-signals.ts`
      (profile jobs only), `pi-resolve.ts`, `pi-commands.ts`
- [x] T4 Paths: state in `<agent dir>/xpi-roost/`, the runtime directory keyed by the agent directory (two levels
      under `/tmp`, both checked for owner and symlinks; short enough for a unix socket), `ROOST_HOME` and
      `ROOST_RUNTIME_DIR` overrides. Every `PI_ROOST_*` variable renamed `ROOST_*`, `PI_JOB_ID` and `PI_DAEMON_SOCK`
      too; the inventory lists the renames. The agent directory and the two entry paths are given to a client by its
      caller and travel to the daemon, hosts and sessions in their environment, never found by importing xpi
- [x] T5 `host/main.ts` without telemetry and profile jobs, with `fixSpawnHelper`
- [x] T6 `daemon/main.ts` with decision 4's ops: no task board, workspaces, concierge, orders, schedules, watches,
      messages, peers, `handback`, profiles, PR polling, worktree isolation, agent-definition dispatch or telemetry;
      `events` kept; restart of a session whose agent process crashed and reconciliation at start kept (DM-5), a
      session whose host is gone ends (no M38); settings read from the
      `"roost"` section of `<agent dir>/settings.json`; an unknown op answers as today
- [x] T7 Tests in scope moved; tests of cut features removed whole; one deleted guard per kept test file shows the
      test failing; a test that two daemons with different agent directories do not share a socket, jobs or roster
- [x] T8 CI: job `test (roost)` on Linux with `npm rebuild node-pty`; `xpi-roost` out of `test (other)` and of
      `./test.sh`'s default walk; the orphan sweep after the suite; no roost test starts a test runner. `node-pty`,
      `@xterm/headless` 6 and `@xterm/addon-serialize` as the package's own dependencies (the pin check and the
      lockfile change reviewed in the PR)
- [x] Docs: `docs/xin-pi.md` (the new package, how it is tested), `packages/xpi-roost/README.md`, the inventory,
      `packages/xpi-roost/docs/protocol.md` generated with the test that keeps it current

Notes on PR 1 (details the spec left open, settled while building it):

- Layout: the code is in `src/lib`, `src/daemon` and `src/host`, as in every package of the monorepo, so the root
  `tsc`, biome and check scripts cover it without new wiring (decision 1 names `lib/`, `daemon/`, `host/`; only their
  parent differs). The generator of the op reference is `test/support/protocol-doc.ts` (`npm run docs:protocol`).
- package.json: private, 1.8.1, no `os` field (it would fail `npm install` of the monorepo on Windows), and no `test`
  script: root `npm test`, `./test.sh` and CI's `test (other)` skip the package through `--if-present`; CI's
  `test (roost)` runs `test:roost`, and `test (other)` also skips `packages/xpi-roost/` by name.
- Also moved, though T3's list does not name them: `hostclient`, `ids`, `proc`, `op`, `version` (the daemon and host
  need them). `SessionCommand` and `sessionCommandsFrom` moved from `pi-commands.ts` (not ported) to `store.ts`.
- Cut from modules listed as moved whole: `REPAINT_MARKER` in `attach.ts` (M14, dead) and the M19 tree helpers
  `pathOf`/`neighboursOf` in `transcript.ts` (decision 3). The `ack` op loses `exact` (peer items only).
- Location in the environment: the client sets `ROOST_AGENT_DIR`, `ROOST_HOME`, `ROOST_RUNTIME_DIR` and
  `ROOST_HOST_ENTRY`; the host gives a session the same plus `XPI_CODING_AGENT_DIR` (a name, not an import), over
  whatever the session's own environment held. The runtime key is the first 12 hex digits of SHA-256 of the agent
  directory's real path; an XDG path too long for a socket falls back to `/tmp/xpi-roost-<uid>/<key>`.
- `cleanable` (the `cleanupDays` removal) skips a session whose DM-5 restart is pending (`resumeAt` set), so a waiting
  restart is never removed under it.
- After the second review round: the state lock is `state.lock` (two files when `ROOST_HOME` and `ROOST_RUNTIME_DIR`
  are one directory); the locks are released in the reverse of the order taken; the overrides are ignored only when
  `ROOST_AGENT_DIR` is set and names another agent directory (a user's own override, set alone, applies). For PR 2: a
  client of a host socket (`attach`) runs the runtime-directory check before it connects.
- After the review of PR 1 (#65): `ROOST_HOME` and `ROOST_RUNTIME_DIR` apply only to this process's own roost (no agent
  directory given, or the one given is `ROOST_AGENT_DIR`, compared by real path); an agent directory is made absolute
  where it enters (`DaemonStart`, the path functions); every level of the runtime directory is checked (owner, not a
  link) before any connect, not only before a start; the daemon takes a second lock in the state directory
  (`<agent dir>/xpi-roost/daemon.lock`) and a client that works out another runtime directory gets `other_runtime_dir`
  naming the running daemon's; `privateDir` creates the XDG directory's parents again (as pi-roost did); `spawnHost`
  strips the `ROOST_JOB_*` prefix as well as `JOB_ENV_NAMES`; `DaemonClient.connect()` without a location rejects
  (`no_roost`) instead of throwing.
- Leftover processes: the suite's sweep clears what a killed run leaves (marked processes whose test run is gone), and
  tests clean up their own daemons; an interrupted run can still leave processes until the next sweep, so a run is
  followed by a `ps` check.
- DM-5: a crashed agent process is restarted with pi-roost's delays and budget (`resumeAt`, `ROOST_RESUME_DELAYS_MS`,
  a pending restart taken up after a daemon restart); the `resume` event kind stays for these restarts. A host that is
  gone, or a run that was interrupted, ends the session. `autoResume` is gone.
- The node-pty probe in the daemon is `createRequire(import.meta.url)("node-pty")` in a try/catch (the reason shown
  in `status.ptyError`). The job kind stays `"pi"` in records and rows (decision 12: formats unchanged).
- Tests: temporary directories are `<tmp>/xroost-*` (`TEST_DIR_PREFIX`), so the sweep never matches pi-roost's own
  test processes. The suite's global setup also sweeps after the run. New: `test/agent-dirs.test.ts`. The
  `job-events` test gained a first-sighting case: its guard did not fail the ported test before.
- For PR 2/3 to note: `src/lib/attach.ts` still scans for fixed detach keys (Ctrl+Z and its encodings); decision 11
  wants them from the keybindings, which is the session side's and the CLI's to settle.

## PR 2: command line and packaging (branch `roost-cli`)

- [x] T9 `xpi roost <subcommand>` in `src/main.ts`: `ls`/`list` (`--all`, `--cwd`, `--json`), `logs`/`log`, `attach`,
      `reply`, `stop`, `rm`, `respawn` (`--all`), `daemon status|logs|stop` (`stop --keep-workers`), the internal
      command that runs the daemon; help text; an unknown subcommand is an error; `hub` says it is not there yet
      until PR 4
- [x] T10 Bundle: entry files for the daemon and the host (as `codemode-worker.js`), found by `xpi-coding-agent` and
      handed to `xpi-roost`; the entry-graph and runtime-dependency checks know them; the version message when a
      client meets a daemon of another version
- [x] T11 `node-pty` as an optional dependency of `xpi-coding-agent`, imported only when a host starts; the
      install-lock allowlist entry with its reason; install-lock refreshed; the messages when `node-pty` does not
      load, when there is no Node runtime (standalone binary), and on Windows
- [x] T12 Settings: the `"roost"` section (the keys of decision 9, the keys a project may not set), its schema;
      `roost.json` is not read
- [x] Tests: the CLI against a real daemon in a temporary agent directory (a shell-command session started through
      the client library); the packed npm tarball starts a daemon and a shell-command session (`release:local`)
- [x] Docs: `packages/xpi-coding-agent/docs/cli.md`, `settings.md`, `environment-variables.md`, `docs/xin-pi.md`

Notes (PR 2):

- T9: the commands are `runRoostCli` in `xpi-roost/src/cli.ts`; `xpi-coding-agent/src/extensions/roost/cli.ts`
  (loaded lazily from `main.ts`, before the `mcp` branch) supplies the agent directory, the entry files, the detach
  key, the node-pty hint and the "cannot run here" messages. There is no internal command: the daemon is started as
  `node <roost-daemon.js>` (a `daemon run` was removed after the review: nothing called it). No command prints
  the help and exits 2, `--help` exits 0, an unknown command exits 2, `hub` exits 1 with "not in this version of xpi
  yet". `reply` exits 1 when the daemon did not deliver or save it. `ls` takes no options besides `--all`, `--cwd`,
  `--json` (others are a usage error). Cut from pi-roost's CLI: `schedule`, `review`, the raw `--json` op,
  `--version`, `--subagents`. `list-format.ts`, `text-width.ts` and `resume.ts` (`ensureLive` with M5a's
  `resumePrompt`: a failed run attached to is respawned with "Continue where you left off.", as the daemon's own
  "press Enter twice to resume" text promises; phase 1 cuts the daemon resuming on its own, not this) are ported;
  `list-format.test.ts` too.
- The CLI process writes its roost's `ROOST_LOCATION_ENV` values (`daemonEnv(start)`) into `process.env`, so from
  inside another roost's session it still reaches the agent directory it was given.
- Decision 11 / the PR 1 note: the library has no detach key. `attachToHost` takes `isDetachKey(key)`; the input is
  cut into whole keys (CSI, SS3, OSC, ESC and a character, UTF-8 characters; an unfinished sequence waits for the next
  chunk), a bracketed paste is text. xpi's matcher is the user's `app.suspend` through `KeybindingsManager.matches`
  (legacy, kitty CSI-u with lock bits and repeat, modifyOtherKeys), not on a key release, with kitty's associated-text
  field dropped first. `attach` with `app.suspend` unbound exits 1 and says so. After the review: `DetachScanner` holds
  a key that a read ends inside (CSI, SS3, OSC, ESC and a character, UTF-8) until it is whole, so no half of the
  detach key reaches the session; a lone ESC is still sent at once (pi-roost's timing, no Escape delay) and read
  again with what follows; a held key that never finishes is sent after 100 ms; more than 64 unfinished bytes are
  sent on. `attachToHost` runs the
  runtime-directory check before it connects.
- `agentDirKey` resolves the real path through the nearest existing parent, so the key (and the runtime directory) is
  the same before and after the agent directory is created (found by the `release:local` smoke: `/var` vs
  `/private/var` on macOS gave the CLI and the daemon different runtime directories).
- T10: xpi-roost now builds (`tsc -p tsconfig.build.json`, in the root build before coding-agent) with exports `.`,
  `./daemon`, `./host` (each with a `default` condition for `createRequire().resolve`). The bundle script builds
  `roost-daemon.js` and `roost-host.js` from the built entries into the chunk directory next to `config.ts`'s chunk;
  `resolveRoostEntries` in `config.ts` finds them (bundled), resolves `xpi-roost/daemon|host` (unbundled) or returns
  nothing (bun binary). xpi-roost is a devDependency of coding-agent and inlined; `@xterm/headless` and
  `@xterm/addon-serialize` are inlined into the host entry (pure JS, declared by xpi-roost). node-pty is the only
  external, and the bundle script fails when any output but the host imports it. `check-entry-graphs.mjs` budgets the
  three xpi-roost entries (`.` 25 files, `./daemon` 30, `./host` 25), each forbidden to pull in the others or `cli.ts`.
  `check-runtime-deps.mjs` needed no change: it walks the whole bundle directory, and coding-agent's sources import
  `xpi-roost`, an inlined devDependency. The daemon entry gets no data-URL treatment. `ROOST_VERSION` in the bundle is
  coding-agent's version (lockstep). The version message: every command warns once when the daemon's version differs,
  and says to run `xpi roost daemon stop --keep-workers`, then `xpi roost respawn --all`.
- T11: `optionalDependencies: { "node-pty": "1.1.0" }` (out of devDependencies). The install-lock allowlist entry
  `node-pty@1.1.0` ("native PTY for xpi roost; compiles on Linux (no prebuilt binary there)"); the generator now marks
  packages reached only through optionalDependencies `optional: true` (node-pty, node-addon-api), so a failed compile
  does not fail the install. Messages, in the order checked: Windows (use WSL), no entry files (a standalone binary:
  install with npm). node-pty is resolved, never loaded, by the CLI; when it is not there (after the review) only what
  starts a PTY host is refused, with the hint (reinstall without `--omit=optional`/`--ignore-scripts`; Linux needs
  python3, make and a C++ compiler; then `daemon stop --keep-workers`): `respawn`, and `attach` to a session that is
  not running. `attach` to a running session needs no node-pty in the CLI (it talks to the host's socket), so it runs;
  so do `ls`, `logs`, `log`, `reply`, `stop`, `rm` and `daemon ...`, for the sessions an older daemon still runs. A
  daemon that cannot load node-pty is reported by `daemon status` and a warning with the same hint. `reply` to a
  reaped session lets the daemon try the restart and reports its error.
- T12: `roost` in `settings-schema.ts` (14 keys of `RoostConfig`, `presets`; the user-only keys say so) and
  `schemas/settings.schema.json`. `roostSettings()` in `src/extensions/roost/settings.ts` is `mergeConfig(global,
  project)` (a project's `envAllowList`, `inheritEnv`, `envDenyList`, `workspaceEnv` dropped). The daemon reads the
  user's file itself (`reapIdleMinutes`, `cleanupDays`); the environment and dispatch keys take effect with PR 3.
- Tests: `xpi-roost/test/cli.test.ts` (6: help/unknown/hub/bad options; every command on a shell session against a
  real daemon; the given agent directory over another roost's variables; `daemon stop` without `--keep-workers`;
  `log --follow`; `attach` in a pty: an ended session started first, typed into, detached, refused without node-pty
  when not running, allowed when running), `cli-version.test.ts` (1: the version warning), `resume.test.ts` (2),
  `list-format.test.ts` (3), `attach-keys.test.ts` rewritten for the matcher and the scanner (5), `lib-core` gained
  the key-before-creation case; `xpi-coding-agent/test/roost-cli.test.ts` (7: messages, entries, detach-key
  encodings, rebinding, schema, merge, `runRoostCommand` with a rebound key and without node-pty). `release:local` runs `smokeTestRoost` on the packed install (daemon, PTY
  host, shell-command session; `npm rebuild node-pty` first on Linux; skipped on Windows).
- Docs: also `packages/xpi-roost/README.md` and `docs/port-inventory.md`.

## PR 3: `builtin:roost`, the session side (branch `roost-session`)

- [x] T13 The extension, listed in `src/extensions/index.ts`; does nothing in a subagent child
      (`XPI_SUBAGENT_DEPTH`); where roost cannot run it only gives the messages of T11. The session write lock
      (DM-8): taken at `session_start`, released at `session_shutdown`, in every xpi session
- [x] T14 `xpi --bg "<task>"` and `--bg-name`: an xpi session started under the daemon, with the agent directory,
      state and runtime directories in its environment (the allow and deny lists do not apply to these); the hint
      it prints says `xpi roost attach` and `xpi roost ls --json`
- [x] T15 Worker role (`worker.ts`, the parts of `worker-extras.ts` in scope): reports of state, waiting, dialogs,
      context and model; replies delivered and acked; the session's slash-command list written for the peek; the
      earlier history (M53); detach keys from the user's keybindings (`app.suspend`, `app.clear` twice, `app.exit`
      twice; the first `app.clear` still clears the editor; key releases skipped; with a dialog open only the
      suspend key acts), the left arrow on an empty editor (AGENTS.md exemption) and a submitted `/quit` or `/exit`;
      the recap on attach without the summary model's branch; `attachSignal: true` reported only with the SIGUSR2
      handler installed; no repaint on attach (M14, dead with a current host), no automatic naming, `handback`,
      peers or agent tools
- [x] Tests (in `xpi-coding-agent`): reply queue, reporter, worker wiring, earlier history, detach keys with default
      and rebound keybindings, the write lock, an attach does not end a session (SIGUSR2); real Haiku: `xpi --bg`
      starts a session that reports working then idle, `xpi roost reply` gets an answer, `xpi roost attach` shows
      the session and detaches
- [x] Docs: `packages/xpi-coding-agent/docs/roost.md` (first version: background sessions and the CLI), `cli.md`,
      `docs.json`, `extensions.md` if the extension API is touched

Notes (PR 3):

- Tests: the real Haiku part is the coordinator's check after this PR; the rest is ticked.
- T13: `src/extensions/roost/index.ts` is the factory (async). It returns at once when `XPI_SUBAGENT_DEPTH` is set.
  An ordinary start imports only `xpi-roost/session` (a new light entry: the locks and the job identity, budgeted
  at 6 files and forbidden to reach the client, the daemon or the host in `check-entry-graphs.mjs`) and
  `./messages.ts` (the "cannot run here" texts, split out of `cli.ts`; it imports only `node:module`). `background.ts`
  (`--bg`) and `worker.ts` (a session the daemon runs, `isRoostSession()`: `ROOST_JOB_ID` and `ROOST_SOCKET` set) are
  dynamic imports, so lazy chunks in the bundle. `--bg` where roost cannot run is stopped by the flag's `validate`
  (an empty task, Windows, a standalone binary, no node-pty), before any session starts; without `--bg` the
  extension says nothing. `--bg-name` without `--bg` is a warning, not an error.
- DM-8: the lock is taken at `session_start` on the session file (`<file>.lock`, pid and start token), released at
  `session_shutdown` and on a switch (`/new`, `/resume`, fork, reload); not on Windows, not without a session file
  (`--no-session`). Someone else holding it gives a notice, not a refusal. Cost to an ordinary start: one `ps -o
  lstart=` for the start token (about 1.5 to 2 ms, measured), one small file next to the session file (the session
  directory is created at start anyway). The `--bg` process takes no lock: it hands its session file to the daemon.
- T14: `background.ts`. `--bg` runs at `session_start` (reason `startup`) in interactive mode, dispatches through
  `DaemonClient.connectOrStart` and `buildLaunch` (origin `bg`; the flags that choose extensions and model are
  passed through, `-e` and `--session-dir` made absolute, plus `--session <file>`), prints the hint after the TUI has stopped (`atExit`), and shuts down. Errors exit 1 with
  `xpi --bg: <message>`. `launchSettings` reads the global and project settings files with `SettingsManager.create`
  (not `pi.getSettings()`, which is merged and would let a project set the user-only keys). `--model`/`--provider`
  on the command line beat `dispatchModel`, `--thinking` beats `dispatchThinking`. The location variables come
  from the host's `roostEnvironment`, past the lists; the job token is not carried (the worker deletes it from its
  own environment after reading it). The TUI is drawn briefly before `--bg` exits (seen in the faux end-to-end run).
- T15: `worker.ts` (reporter, `ReplyQueue` without agent items, tracker wiring, `commands.json`), `detach-keys.ts`,
  `recap.ts`, `earlier-history.ts`. Detach: `hostControl` on `host-<id>.sock` next to `ROOST_SOCKET`. The submit key
  for `/quit` is `tui.input.submit`, so a rebound submit key works too. `app.exit`'s first press notifies
  `<key> again to detach (the session keeps running)` and is consumed (xpi's own exit never runs in a roost
  session). The hello's capabilities: report, replies, steer, usage, context, model-switch, transcript.
  `attachSignal` is `sigusr2Handled()`: a process-wide SIGUSR2 handler installed once (a `Symbol.for` guard), so the
  signal never ends the process between two sessions of a `/new`. Entry and widget names: `roost-recap`,
  `roost-history`. The recap's deterministic list moved to `xpi-roost/src/lib/recap.ts`. Not ported: the summary
  model, naming, `handback`, peers, agent tools, `api.ts` (cut, decision 1), `setJobEventBus` (the hub's, PR 4).
- A manual end-to-end run with a faux-model extension (`-e`) against the built bundle in a pty: `--bg` printed the
  hint and exited 0; `roost ls` showed `done` with the faux answer; `roost reply` gave a second turn; `roost attach`
  showed the TUI with "While you were away: 2 turns finished"; `ctrl+z`, `ctrl+c` twice, `ctrl+d` twice, the left
  arrow and `/quit` each detached; the session kept running; `daemon stop` released the lock.
- After the review: `isRoostSession` needs the job's token too, so a process the session starts (`xpi -p` in bash, a
  check script), which inherits the id and the socket but not the token (the worker takes it out), loads nothing of
  the worker; the process keeps its answer for its job id, so `/reload` still is the session. `--bg` refuses, in the
  flag's check, before anything starts: other messages and `@file`s (xpi would prompt them itself before exiting),
  `-p`/`--mode`, redirected input or output, and `--no-session` (no session file to hand over; the fallback that
  created one in the default directory is gone). The CI `test (coding-agent)` job builds node-pty, and the real-daemon
  `--bg` test fails instead of skipping when `CI` is set and hosts cannot start. `roost.md`: xpi's own pickers are not
  dialogs to the extension, so the left arrow and a double `app.clear` detach while one is open.

## PR 4: the hub (branch `roost-hub`)

- [x] T16 `hub/` on `xpi-tui`: agent view (split: no board, concierge, schedule, pr, worktree, task or
      agent-definition code), overlay host, the log and usage overlays, the editor for a new session's prompt; the
      tasks, workspaces, review, concierge, schedules and compare overlays are not ported and their keys are gone from
      the help
- [x] T17 `xpi roost hub [dir]` and `/agents`; hub options from xpi (models, presets without `worktree`, `agent` and
      `fanout`, resume); settings written back through xpi's settings
- [x] T18 The table of xpi's built-in slash commands with how the hub runs each, in `builtin:roost`, and the test
      that every command in `BUILTIN_SLASH_COMMANDS` has a class
- [x] T19 `/bg` (alias `/background`) and `/bg-fork`, opening the hub after the hand-off; the left arrow on an empty
      editor behind `leftArrowOpensAgents`; AGENTS.md: the hub's files and the left-arrow check in the key exemption
      list
- [x] Tests: the hub's tests in scope; foreground (`/bg`) tests in `xpi-coding-agent`; a pty test of `xpi roost hub`
      (list, peek, reply, attach, detach); real Haiku: two sessions in parallel, reply to one from peek, attach to
      the other, `/bg` moves a foreground session to the daemon and it appears in the hub
- [x] Docs: `roost.md` (the hub and its keys, `/bg`), `slash-commands.md`, `cli.md`

Notes (PR 4):

- Tests: the real Haiku part is the coordinator's check after this PR; the rest is ticked. The pty test runs the built
  bundle (`npm run build`) with a fake model an extension in the temporary agent directory registers.
- T16: `xpi-roost/hub` is an entry of its own (budget 80 files, never the daemon, the host or the command line), so
  the worker and `xpi roost` do not load xpi-tui. xpi-tui against pi-roost's pi-tui (upstream `f9a263655`): HTML
  comments hidden in markdown, the `xpi-tui/...` symbols, `XPI_*` environment names, Kitty images drawn last on every
  terminal, every cursor marker stripped, `sliceWithWidth` no longer carrying APC codes from before the range,
  Alacritty detection, the native module's package name. None reaches the hub's components; nothing was changed for
  them. The header reads "xpi agents". A fifth command class, "reply", is new: one of xpi's built-in extensions'
  commands that the session's worker runs (`/subtask`, `/review`, `/handover`, ...): sent as a reply, said as
  `/name · session`, not listed with xpi's own in the peek's menu.
- T17: `hub-options.ts` (what the hub gets), `open-view.ts` (`/agents`, `ctx.ui.custom`, full screen unless
  `"fullscreen": false`), `hub-main.ts` (`xpi roost hub [dir]`, run through `runRoostCli`'s new `hub` option; it
  disposes the view when it ends, which pi-roost left to `process.exit`). The hub's process carries the roost's
  location variables (`roostStart`). Presets and `groupBy` are written to the user's `settings.json` with the new
  `SettingsManager.setRoostSetting` (a nested key, merged with the file); `fullscreen`, `rowDetails`, `notify` and
  `presets` take effect. Trust (the coordinator's facts 2, then the merged `sessionTrust`): every session the hub
  starts or resumes gets `--approve`/`--no-approve` by `sessionTrust`'s rule; in the host xpi's folder its answer and
  command line, elsewhere and in `xpi roost hub` only a stored decision, otherwise `--no-approve` (`sessionTrust` takes
  `undefined` for "no answer for this folder").
- T18: `commands.ts`: the 24 `BUILTIN_SLASH_COMMANDS` as pi-roost classed them (`/import` gets the hint `<file>`), and
  the built-in extensions' commands (`commit`, `mcp`, `llama`, `workflows`, `subagents`, `agents`: picker; `relay`:
  screen; `handover`, `handback`, `subtask`, `upstream`, `review`: reply). `test/roost-commands.test.ts` also scans
  the built-in extensions' `registerCommand` literals and built-in workflow names, so a new one fails until classed;
  `/bg`, `/background`, `/bg-fork` are foreground only (not in a session the daemon runs).
- T19: `foreground.ts` loads light in every foreground session (only `xpi-roost/session`, xpi-tui and the lazy
  loaders in `hub.lazy.ts`); the client and launch (`handoff.ts`) and the hub load when used. The scratch session of
  the hand-off is `<agent dir>/xpi-roost/scratch/`, never locked. Not ported: the quit offer (BG-9), the footer hint
  and its 10 s daemon poll (BG-11), `defaultToAgentsView` (decision 6), peers (decision 5). `setJobEventBus` is set
  when a hub opens (the footer poll that also observed jobs is not ported). The `--bg` hint names the bound
  `app.suspend` keys (coordinator's fact 3).
- After the review of PR 4 (#68): the hub reads xpi's commands and event bus from the runtime that loaded
  `builtin:roost` last (`view-state.ts` `setHubApi`, set on every load), so a hub `/bg` opens after the session switch
  never calls the stale API; a failing `commands()` gives none instead of throwing into the hub's keys. `/agents` in a
  session the daemon runs takes `selfId` from `ROOST_JOB_ID` (a process started in that session's terminal inherits it:
  its row is the same terminal), marks the row and refuses attach, Ctrl+X, `/stop`, `/rm`, `/respawn`, `/attach` and
  xpi's commands on it. `/bg` and `/bg-fork` dispatch with `requestOnce` (`handoff.ts` `dispatchHandoff`); a lost
  answer is checked against the daemon's list by session file: running, no fallback; nothing running, back to the
  conversation; no list either, no fallback and a warning. The hub's settings reads (`launchDefaultModel`,
  `xpi roost hub`'s theme and session directory, `standaloneSettings`) pass the trust the sessions get; new sessions
  and `/resume` use the host's session directory; a preset or grouping that cannot be written is said in the hub.


## PR 5: docs and release (branch `roost-docs`)

- [x] T20 `roost.md` complete; README files; `docs/xin-pi.md`; `packages/xpi-roost/docs/porting.md` cut to phase 1;
      the inventory updated; what was left out and by which decision
- [ ] T21 pi-roost: the README notice merged; the repository archived when the owner says so
- [ ] Release (patch or minor, by what changed for users), Node smoke test including `xpi roost`

Notes (PR 5):

- T20: `porting.md` is pi-roost's Chinese `docs/porting.md` (v0.1.21) rewritten in English for phase 1, checked against
  the code on main: the architecture, what the host agent must have, what to copy and rewrite, the eight steps phase 1
  keeps (M1 to M8 with M20 to M28, M36, M48, M51, M53, M61, M79), the settings, constants, build, tests, known limits,
  and "Left out of phase 1": every cut feature with the spec's decision and the Grill item of `decisions.md`. Its op
  appendix is `protocol.md`. `roost.md` checked line by line against the code; corrected: `xpi roost ls` lists pinned
  sessions first, `respawn` also restarts a running session (and `--all`), the state files (`roster.json` is the
  running hosts, not the list's order), the version warning comes from `xpi roost` and `xpi --bg` (the hub does not
  give one), node-pty's absence is also said by `/bg`, `/bg-fork` and an attach that starts a session, `/bg` on an
  idle conversation; added: the hub's movement keys, folding, Tab, Ctrl+J, Shift+Ctrl+P, the peek's 1 to 9, closing an
  overlay, `/exit`, a section on how sessions end (DM-5 restarts, shell rows, a machine restart), and "Not in this
  version" in place of "Not there yet". The inventory's "later" class is gone (`fixtures/ask-extension.ts` is cut:
  only pi-roost's manual M2 check used it) and it gains a Docs section. No code changed.

## After phase 1

- [ ] Phase 2 spec: schedules and resume after an interruption
- [ ] Agent teams spec (messages between sessions, watches), with the owner
