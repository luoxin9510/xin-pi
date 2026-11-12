# Tickets: spec 02, xpi-roost phase 2 (schedules)

Spec: `.scratch/xpi-roost/02-schedules.md` (approved 2026-11-12). Each PR: independent Opus review, green CI, a real
Haiku check when it changes what a session does, and the user docs for what it adds.

## PR 1: schedules in the daemon and the command line (branch `roost-schedules`)

- [x] S1 `lib/schedule.ts`: pi-roost's rule parser and slot arithmetic ported, plus `weekly <day> HH:MM` and `manual`;
      the 5-minute floor on `every` and on a cron rule's times of day; names `^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$`
      (decision 3, 11); a task up to 64 KiB
      Done: `src/lib/schedule.ts` (rules incl. `weekly mon|monday HH:MM` and `manual`; `closestMinutes` for the cron floor across hours and midnight; `latestSlot` for catch-up; `TASK_MAX_BYTES` counted in UTF-8 bytes; `scheduleRow`). Tests: `test/schedule.test.ts` (14).
- [x] S2 `lib/schedules.ts`: the store with an injected clock; `schedules.json` (daemon only, atomic, durable); at most
      50; a launch stored as `buildLaunch` returns it, environment included (decisions 9, 11, 12)
      Done: `src/lib/schedules.ts` with ports (jobs, store, record, log, isDir, exists, clock); `SCHEDULES_MAX` 50 (a file with more keeps 50); the launch stored as given, env included; the daemon writes `<roost home>/schedules.json` with `writeJsonAtomic` (0600, durable). Tests: `test/schedules.test.ts` (35, manual clock).
- [x] S3 the daemon: the 15 s tick (`ROOST_SCHEDULE_TICK_MS`), due runs, catch-up within 7 days searched from
      `max(nextAt, now - 7 d)` and marked as a catch-up in the schedule's record, skips while the previous run works, a
      missing directory or executable, a failed start recorded; `add` refuses a missing directory (decisions 4, 7, 9)
      Done: tick chained on the Clock, `ROOST_SCHEDULE_TICK_MS`; `start()` ticks at once, so missed slots at daemon start and after a sleep take the same path (late by more than 2 ticks: `latestSlot` from `max(nextAt, now - 7 d)`, `lastRunWhy: "catch-up"`); skips record `lastSkip` and a `schedule` event with `why: "skip"`; missing directory, executable or entry (`command[0..1]`) skip; a failed dispatch is recorded and logged; `add` refuses a missing directory. Daemon tests in `test/daemon.test.ts` ("phase 2").
- [x] S4 runs: named after the schedule, a `schedule` field on the record and row, a fresh session file per run,
      retention of 3 ended unpinned runs; `xpi roost ls` shows the schedule's name (decision 6)
      Done: `dispatch(a, {schedule})` stores `schedule` on `JobRecord`, `rowOf` adds `schedule`; a run gets `name`/`name (2)` from the daemon's usual dedup and a fresh `<time>_<uuid>.jsonl`; retention via the `runs()`/`remove()` ports each tick (ended = done/failed/stopped, not working/starting/restarting, no replies waiting; checked again before `removeRecord`); `ls` shows `name ← schedule`.
- [x] S5 ops `schedules`, `schedule-add`, `schedule-edit`, `schedule-rm`, `schedule-pause`, `schedule-run`;
      person-only in `callers.ts`; the `"schedule"` event kind; `docs/protocol.md`; version stays 1 (decision 13)
      Done: six ops in `protocol-schema.ts` (`ScheduleRow` shared shape, `launch` loose and checked by `checkTemplate`), personOnly in `callers.ts`, `"schedule"` event kind and `eventLine`; schedule runs record a `schedule` event instead of `dispatch`; `docs/protocol.md` regenerated plus a Schedules section; `PROTOCOL_VERSION` still 1; callers matrix snapshot updated.
- [x] S6 `xpi roost schedule list|add|run|pause|resume|edit|rm`: the launch built through the extension's wrapper
      (`sessionTrust(dir, [], undefined, agentDir)`, model and thinking from the flags or the `roost` settings);
      `list` without starting the daemon; `add|edit|run` refused inside a roost session; run-now and edit rules
      (decision 8)
      Done: `xpi roost schedule list|add|run|pause|resume|edit|rm` in `src/cli.ts` (`list` uses `DaemonClient.connect()` and falls back to the file with a note on stderr); the wrapper's `scheduleLaunch` (`buildLaunch`, `sessionTrust(dir, [], undefined, agentDir)`, `launchSettings`, session dir from the env, else settings, else default, `argv` = executable and entry only); add/edit/run refuse with `ROOST_JOB_ID`; edit fetches the stored task/model/thinking and rebuilds the launch.
- [x] S7 docs: `roost.md`, `cli.md`; tests per decision 15
      Done: `roost.md` (Schedules section, state file, "Not in this version"), `cli.md` (schedule rows, which commands start the daemon), `packages/xpi-roost/docs/protocol.md`. Tests per decision 15 except the real Haiku check and the hub/service ones (later PRs); new tests checked to fail with each guard removed.
      Review round 1 (PR #76): runs that ended on a question count as ended once they have no process (not the latest);
      runs matched by `scheduleId`; old runs with a live idle worker wait for reaping; an unreadable `schedules.json` is
      moved to `.bad-<time>`, unknown entries kept; a cron rule that never matches refused; resume of a running schedule
      a no-op; a slot during a starting run-now recorded as a skip; task and launch kept consistent; `--model default`
      / `--thinking default`; rule errors print the message and a one-line hint; DST notes in roost.md.

## PR 2: schedules in the hub (branch `roost-schedules-hub`)

- [x] S8 `/schedule <name> <when> <task>` and `/schedule` (the list overlay: run now, pause, resume, edit, remove), the
      launch built as the CLI does; works in a hub opened inside a roost session; not registered in an ordinary xpi
      session (decisions 2, 8)
      Done: `src/hub/overlays/schedules.ts` (list: rule, next run, last run with catch-up, task, directory, last skip; Enter run now, `p` pause/resume, `e` edit the rule in place (checked, launch rebuilt with the stored task/model/thinking in its directory), `x` twice remove, `r` reload; what an action answered is drawn above its keys); `/schedule <name> <when> <task>` and `/schedule` in `agent-view.ts`, offered only when the host gives `scheduleLaunch`; the hub options build it with the CLI wrapper's `scheduleLaunch` (stored trust only, the hub's `--session-dir`); the port gains `schedules`. Works with `selfId` (a hub inside a session); `roost-commands.test.ts` checks no `/schedule` command is registered in a session.
- [x] S9 the run marker in rows, log entries for catch-ups, skips and missing directories; notifications as any
      session (decision 10)
      Done: a run's row shows `↻ <schedule>` before its sentence; `/log` shows runs (catch-up marked) and skips (missing directory included) with skips as warnings; notifications unchanged (runs are jobs; schedule events are feed-only, never pushed, so they never notify).
- [x] S10 docs: `roost.md`; tests
      Done: `roost.md` (hub commands table, row marker, `/log`, notifications, `/schedule` inside a session and not in an ordinary one). Tests: `schedules-overlay.test.ts` (7), `agent-view.test.ts` phase 2 (7), `log-overlay.test.ts` (+1), `roost-hub-options.test.ts` (+1), `roost-commands.test.ts` (+1), `roost-hub-pty.test.ts` (+1: `/schedule` add, list, run now in the built hub with the fake model); 13 guards checked to fail when removed.
      Review round 1 (PR #77): the list shows the last run's result from its hub row (nothing once it is not listed);
      the rule field takes bracketed pastes and kitty-encoded keys; `/schedule ...` keeps the text until the daemon
      takes it; `x`'s second press resets when the selection moves; the last removal closes the overlay only when it
      is the one shown (+5 tests, 6 guards checked). Also from the #76 review: a file that cannot be moved aside freezes saving until restart (`schedules.test.ts` +1); the `cli.test.ts` list flake (`+ 30 * 60_000`).

## PR 3: the login service (branch `roost-service`)

- [x] S11 `xpi roost daemon install|uninstall`, `status`'s line: a launchd agent and a systemd user unit named by the
      agent directory's key, once per login, no restart, `KillMode=process` (decision 5)
      Notes: `src/lib/service.ts`. The files are pure (`launchdPlist`, `systemdUnit` from a `serviceSpec`); the label is
      `dev.xpi.roost.<key>`, the unit `xpi-roost-<key>.service`. Both run `daemonCommand(start)` (shared with
      `connectOrStart`: this Node and the daemon entry) with `daemonLocation(start)` (the four location variables only),
      working directory `/`, output appended to `<roost home>/service.log`. launchd: RunAtLoad, KeepAlive false,
      AbandonProcessGroup true; install = `bootout` of an older one (ignored) then `bootstrap gui/<uid>`; uninstall =
      `bootout` and remove. Loading starts a daemon even when one runs; that one exits 0 on the lock (as any second
      daemon). systemd: Type=simple, no Restart=, KillMode=process, WantedBy=default.target; install = `daemon-reload`,
      `enable`, and `start` only when no daemon runs (the state lock is held or the socket answers); uninstall =
      `disable` (no `--now`), remove, `daemon-reload`. The platform, home, uid and the launchctl/systemctl runner are
      `ServiceDeps`, given to the CLI as `RoostCliOptions.service` in tests. `daemon status` adds `service  installed
      (...)`, `not installed`, or "for another xpi or setup: run xpi roost daemon install again" when the file differs
      from what this xpi would write; when no daemon answers here but the state lock's holder has another runtime
      directory it prints the `other_runtime_dir` message (`daemonElsewhere`, shared with `connectOrStart`).
- [x] S12 docs: `roost.md`, `cli.md` (reinstall after moving xpi, lingering, runtime directory overrides); tests of the
      generated files
      Notes: roost.md "Start the daemon at login" under Schedules (reinstall, `service.log`, `loginctl enable-linger`,
      the runtime directory and `other_runtime_dir`), the sockets line with `ROOST_RUNTIME_DIR`; cli.md rows for
      `install`, `uninstall` and the status line. protocol.md unchanged (no protocol change). Tests:
      `test/service.test.ts` (files, shared command, install/uninstall/status with fakes on darwin, linux and win32) and
      two in `test/cli.test.ts` (install/status/uninstall through the CLI with a fake launchctl in a temporary home; the
      `other_runtime_dir` status with a daemon started under another runtime directory).
- [ ] S12a real check on macOS before merge (decision 15): `daemon install`, `status`, `uninstall`, and a Haiku run
      fired by a daemon the login service started (it finds `git` and authenticates)

## PR 4: wrap-up and release (branch `roost-phase2-docs`)

- [ ] S13 `porting.md` (phase 2; the decision on resume; the stale "Grill 5" reference), `port-inventory.md`, spec
      01's decision 6 note, README files
- [ ] S14 a release with a Node smoke test including `xpi roost schedule`
