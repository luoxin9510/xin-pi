# 02: xpi-roost, phase 2: schedules

Status: approved by the owner on 2026-11-12, after four rounds of independent review (PR #74). Decisions: Grills 4
and 5 of `decisions.md`.

## Goal

The daemon starts a background session on a schedule: "every weekday at 9, review yesterday's commits", "every 2
hours, check the deploy". Each run is a new session in the hub, like one started with `xpi --bg`. This is Claude
Code's local scheduled tasks (the Desktop app's, which start a new session per run) and pi-roost's M39, kept to what a
person needs on one machine.

## Terms

- **Schedule**: a name, a time rule, a task (the first prompt), and the launch it runs with (directory, model,
  thinking, trust decision, extension flags). The daemon owns them.
- **Run**: one background session a schedule started.
- **Slot**: a time the rule says a run is due.

## Facts this builds on

Checked on main (5f2cf66e1, v1.9.0) and pi-roost's main.

- Phase 1 already handles an interrupted session the way Claude Code does: a crashed worker restarts up to three times
  with "Continue where you left off." (DM-5, `packages/xpi-roost/src/daemon/main.ts`); after a machine restart a
  session that was working in the last 48 hours is failed with "reply or press Enter twice to resume", older ones are
  stopped (DM-7); a reply saved while a session could not take it is sent at its next start. Claude Code documents the
  same and that it never sends "continue" by itself after a restart. pi-roost's M38 (`autoResume`, restarting
  sessions within 6 h of a machine restart) goes further than Claude Code.
- pi-roost's schedules (M39): `lib/schedule.ts` (rule parsing and next-slot arithmetic, 247 lines), `lib/schedules.ts`
  (the store with an injected clock, 260 lines), `hub/overlays/schedules.ts` (57 lines), about 100 lines of wiring in
  the daemon, view, CLI and schema; tests `schedule.test.ts`, `schedules.test.ts`, `schedules-overlay.test.ts` and
  daemon blocks. Rules: `every Nm|h|d`, `daily HH:MM`, `weekdays HH:MM`, `cron "<5 fields>"`, local time, at least a
  minute. A tick every 15 s; `nextAt` set before a run starts; `every` anchored at creation so a gap never bursts; a
  due run while the previous one is working, starting or waiting to restart is skipped and recorded (`lastSkip`);
  `catchUp` (default on) runs a missed schedule once at daemon start, however old. A run is a new `dispatch` named after
  the schedule (`name`, `name (2)`), its session file a fresh `{{run}}.jsonl`, and it auto-closes when done through the
  subagent auto-close that phase 1 cut. Ops `schedules`, `schedule-add`, `schedule-rm`, `schedule-pause`,
  `schedule-run`, person-only; `schedules.json` in the state directory, one writer, durable atomic writes; at most 100
  schedules; names `^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$`. Adding a schedule was possible only in the hub.
- Parts of M39/M40 depend on what phase 1 cut: profiles and `!` commands as scheduled tasks, agent-definition launches,
  worktree templates (refused anyway), subagent auto-close.
- Claude Code's local scheduled tasks (Desktop): presets (hourly, daily, weekdays, weekly, manual) or a cron rule in
  local time, at most hourly; a new session per run; on start or wake it runs a missed task once, only the latest slot
  and only within the last 7 days, and says so; each task has a run history with skip reasons; run now, pause,
  resume, edit, delete. `/loop` (a timer inside one session) and cloud routines are other features.
- What phase 1 left for this: the daemon's intervals (`watcher`, `shellWatcher`, `reaper`) next to which a schedule
  tick goes; the 18 ops and `callers.ts`; the `"roost"` settings the daemon reads from the user's file; the hub's
  slash commands (`packages/xpi-roost/src/hub/agent-view.ts`) and its launch options and presets
  (`packages/xpi-coding-agent/src/extensions/roost/hub-options.ts`); `buildLaunch`
  (`packages/xpi-roost/src/lib/dispatch.ts`) with `trusted`; `sessionTrust`/`trustFor` (the trust rule, in the
  extension: the daemon cannot read xpi's trust store); idle reaping (`reapIdleMinutes`); hub notifications (`notify`);
  `rm` deletes a record and keeps the session file, which `/resume` still finds.
- The daemon starts only when a client needs it (`xpi roost`, the hub, `xpi --bg`: `connectOrStart` in
  `packages/xpi-roost/src/lib/client.ts`); nothing starts it at login, and `xpi roost daemon stop` stops it.
- "Waiting for an answer" is a heuristic: a run whose last reply ends in a question (`worker-state.ts`,
  `heuristics.ts`). A reaped run keeps `state: "blocked"` with `waitingFor` cleared. pi-roost treats a scheduled run
  that ends on a question as done (M40).
- The caller check (`callers.ts`) treats every connection that does not say it is an agent as a person. A session's
  environment carries `ROOST_*`, so a command the model runs with bash (`xpi roost ...`) reaches the daemon as a
  person; this is so for `dispatch` in phase 1 too.
- `xpi roost` is `runRoostCli` in xpi-roost, which cannot import xpi's trust store or settings; the extension's
  wrapper (`packages/xpi-coding-agent/src/extensions/roost/cli.ts`) passes it what it needs, as it does for `hub`.
  The hub's `launch` uses `trustFor`, which takes the hub xpi's own answer in its directory.
- The protocol version is `PROTOCOL_VERSION = 1` (`packages/xpi-roost/src/lib/protocol.ts`); an older daemon answers
  an op it does not know with `bad_request: unknown op`, and `xpi roost` warns when the daemon's version differs.
- A session's environment is computed in the client: `buildLaunch` filters the caller's `process.env` by the `roost`
  settings (`workerEnv`), the dispatch carries it, the daemon writes it into the job's record (`store.ts`, files 0600
  in 0700 directories) and the host starts the session with it. The daemon never computes a session's environment.
- The daemon starts hosts with `detached: true`, which escapes launchd's process-group cleanup but not a systemd
  unit's cgroup.
- `xpi roost` commands other than `daemon ...` connect with `connectOrStart`, so they start the daemon.

## Decisions

1. **Resume after an interruption is not added.** Phase 1's behaviour is Claude Code's (facts above); M38 is not
   ported and there is no `autoResume` setting. Phase 2 is schedules only. Spec 01's decision 6 (which put resume in
   phase 2) and `porting.md`'s "Left out" table say so, with the reason: restarting unattended after a machine restart
   can repeat half-done work.
2. **Daemon schedules only.** A schedule starts new background sessions. A timer inside one session (`/loop`) is a
   core xpi feature (it needs tools for the model) and gets its own spec if wanted.
3. **Time rules.** Local time zone. `every <n>m|h|d`, `daily HH:MM`, `weekdays HH:MM`, `weekly <mon..sun> HH:MM`,
   `cron "<5 fields>"` (lists, ranges, steps; Sunday 0 or 7; day of month and day of week match as either), and
   `manual` (runs only when asked). Only a cron rule is quoted. No one-shot schedules. pi-roost's parser and slot
   arithmetic (DST, at least 1 s ahead) are ported.
   - The floor is 5 minutes and does not depend on when it is checked: `every` under 5 m is refused; a cron rule is
     refused when two of its times of day (its minute and hour fields, the last of a day followed by the first of the
     next) are under 5 minutes apart. Day fields only make slots further apart, so this is the closest two slots can
     be. On the day clocks go forward, two slots around the skipped hour can be closer; that is accepted.
   - `every` is anchored when the schedule is made, resumed or its rule edited, so a gap never bursts.
4. **Missed slots.** On each tick the daemon compares a schedule's `nextAt` with now. When `nextAt` has passed by more
   than two ticks (the daemon was off or the machine slept), it finds the latest slot at or before now, searching from
   the later of `nextAt` and seven days ago: if there is one, the schedule runs once, marked as a catch-up in its
   record and the hub's log; older ones are dropped. A catch-up follows decision 7 like any run (skipped while the
   previous run is working). Either way `nextAt` moves to the first slot after now. No `catchUp` option.
5. **When schedules run.** Only while the agent directory's daemon runs. The daemon does not start at login by
   default; any `xpi roost` command (other than `daemon ...`), the hub and `xpi --bg` start it, and
   `xpi roost daemon stop` stops schedules with it.
   - `xpi roost daemon install` registers it as a per-user login service; `daemon uninstall` removes it;
     `daemon status` says whether it is installed. macOS: a launchd agent in `~/Library/LaunchAgents`; Linux: a
     systemd user unit. The label or unit name carries the agent directory's key, so two agent directories do not
     collide.
   - The service runs what `connectOrStart` would: the installing xpi's `process.execPath` with the daemon entry, and
     the environment `daemonEnv` gives (`ROOST_AGENT_DIR`, `ROOST_HOME`, `ROOST_RUNTIME_DIR`, `ROOST_HOST_ENTRY`). It
     starts the daemon once per login: no `KeepAlive`, no `Restart=`, so `daemon stop` is not undone. The systemd unit
     has `KillMode=process`, so stopping the daemon (also `daemon stop --keep-workers`) does not kill the sessions in
     its cgroup.
   - The service's own environment is a login service's (a short `PATH`, no shell rc), which is why runs do not take
     it (decision 9). The docs say: reinstall after moving or upgrading xpi to another path; on Linux the user
     instance stops at logout unless lingering is on, and the sessions with it; a runtime directory override in the
     shell (`ROOST_RUNTIME_DIR`, `ROOST_HOME`) or a missing `XDG_RUNTIME_DIR` makes clients look elsewhere than the
     service's daemon (the state lock refuses a second daemon with `other_runtime_dir`, and `daemon status` says so).
   - `xpi roost schedule list` connects without starting the daemon, as `daemon status` does: when it is not running,
     it prints the schedules from `schedules.json` and says nothing runs until the daemon does.
6. **A run.** A new background session, never a reply into an earlier one, with a fresh session file in the launch's
   session directory. It is named after the schedule (`nightly`, `nightly (2)`) and its record carries the schedule's
   name; the hub and `xpi roost ls` show it with the schedule's name.
   - Retention: when a schedule has more than 3 runs that have ended and are not pinned, the daemon removes the older
     ones' records (as `rm` does: the session file stays and `/resume` finds it, unless the schedule's session
     directory is not the default one, which the docs say). A run a reply starts again counts as running until it ends
     again. A run the person removed simply no longer counts.
   - Runs use the idle reaping every session gets; no auto-close.
7. **Overlap.** A slot is skipped only while the schedule's previous run (its last one, `lastJob`) is working,
   starting, or waiting to restart after a crash. A previous run that is waiting for an answer does not hold the
   schedule back: the new run starts, the old one stays in the list as Needs input and notifies. A skip records its
   time and "previous run still working", shown in the schedule's list.
8. **Where schedules are made and managed.**
   - Hub: `/schedule <name> <when> <task>` adds one; `/schedule` alone opens the list (name, rule, next run, last run
     with its result or skip, paused) with run now, pause, resume, edit the rule, remove.
   - Command line: `xpi roost schedule list|add|run|pause|resume|edit|rm`. `add <name> <when> <task>` takes `--cwd`,
     `--model`, `--thinking`; `edit <name>` takes `--when`, `--task`, `--model`, `--thinking`. `list` prints a table
     like `ls` (and `--json`); `add` prints the schedule's next run.
   - Run now (`schedule-run`): starts a run at once, also for a paused or `manual` schedule, without moving `nextAt`;
     while the previous run is working it is refused as busy (and recorded as a skip).
   - Edit: every `edit`, also `edit <name>` with no flags and the hub list's "edit", builds the launch again in the
     editing process (decision 9: environment, executable and entry, session directory, trust decision; the directory
     stays) with any new task, model or thinking; what is not given keeps its stored value. A new rule also sets the anchor to now and `nextAt` to its first slot
     after now; otherwise `nextAt` is kept.
   - Not in an ordinary xpi session: `/schedule` there is not registered, so that a later `/loop` is not confused with
     it.
   - Inside a session the daemon runs (its environment has `ROOST_JOB_ID`), `xpi roost schedule add|edit|run` refuse,
     saying why; `list` works. This stops a model from adding schedules by accident, not on purpose (it can clear the
     variable), which the docs say. The hub opened with `/agents` in such a session keeps `/schedule`: the person is
     the one typing there. The schedule ops are person-only in `callers.ts`, which keeps agents out.
   - The directory cannot be edited: remove the schedule and add it again there.
9. **A run's launch.** Built when the schedule is made or edited, by the xpi process that does it (the hub, or the CLI
   through the extension's wrapper), with `buildLaunch` as for any new session:
   - the directory (where the hub or CLI is, or `--cwd`); a missing directory is refused at `add`, and a run whose
     directory is gone later is skipped with that reason;
   - the model and thinking: the flags, else the hub's for new sessions, else the `roost` settings' `dispatchModel` and
     `dispatchThinking`, as for `xpi --bg`;
   - the trust decision from `sessionTrust(dir, [], undefined, agentDir)`: only a decision stored for that directory
     counts, else `--no-approve` (not the hub's `trustFor`, which would take the hub xpi's own answer); so a run never
     waits at the trust question;
   - the session directory xpi would use there (`--session-dir` of the hub xpi or the settings), into which each run
     gets a new file;
   - the xpi executable and entry (`execPath`, the CLI path) of the xpi that made it. A run whose executable or entry
     no longer exists (xpi moved or upgraded elsewhere) is skipped with "run `xpi roost schedule edit <name>` to
     update it".
   - the environment, as `buildLaunch` computes it for any new session: the making process's environment filtered by
     the `roost` settings (`inheritEnv`, the allow and deny lists, `workspaceEnv`). It is stored with the schedule as a
     job's record stores it (0600 file in a 0700 directory) and every run starts with it, so a run has the `PATH`, keys
     and variables of the terminal or hub that made or last edited the schedule, not those of whoever started the
     daemon (a login service has almost none). `edit` takes the editing process's environment; the docs say to edit
     a schedule after changing a key it needs.
   - A run that fails to start is recorded in the schedule (`lastSkip` with the error) and logged.
10. **Notifications.** A run that finishes or needs input notifies as any session does (`notify`). A catch-up run, a
    skipped slot and a missing directory are logged in the hub's log and the schedule's record, without a
    notification.
11. **Limits.** At most 50 schedules, paused ones included. Names as pi-roost's: a letter or digit, then up to 39 of
    `[A-Za-z0-9_.-]`, unique. A task up to 64 KiB.
12. **State.** `<agent dir>/xpi-roost/schedules.json`, written by the daemon only, atomically and durably, as the
    other state files. The schedule tick runs every 15 s next to the daemon's other intervals; `ROOST_SCHEDULE_TICK_MS`
    overrides it in tests, as other `ROOST_*` overrides do.
13. **Protocol.** New ops `schedules`, `schedule-add`, `schedule-edit`, `schedule-rm`, `schedule-pause`,
    `schedule-run`, person-only in `callers.ts`; a `schedule` field on a job's record and row; a `"schedule"` event
    kind. `docs/protocol.md` documents them. `PROTOCOL_VERSION` stays 1: an older daemon answers the new ops with
    `unknown op`, and `xpi roost` already warns when the daemon's version differs and says how to restart it.
14. **Not ported from M39/M40.** Profiles and `!` commands as scheduled tasks, agent-definition launches, the worktree
    check, subagent auto-close, `catchUp`, the `PI_ROOST_SCHEDULE_TICK_MS` variable.
15. **Tests and checks.** pi-roost's schedule tests ported with an injected clock; tests for the 5-minute floor
    (including rules whose closest times are across an hour or midnight), due, skipped, run-now while busy, catch-up
    within and beyond 7 days and after a sleep, retention (pinned and restarted runs), a missing directory and
    executable, the 50 limit, person-only ops, the refusal inside a session, the launch built with a stored trust
    decision only and with the environment filtered by the `roost` settings, stored, used by every run and rebuilt
    by any `edit`; the service files generated for launchd and systemd (not installed by
    the tests); hub tests for `/schedule` and the list; CLI tests. Before each merge that changes what a session does,
    a real Haiku check: a `manual` schedule run now from the CLI and from the hub, an `every 5m` schedule seen to fire
    and to skip while its run is busy, a catch-up after a daemon restart; `daemon install`, `status` and `uninstall`
    on macOS, and a run fired by a daemon the login service started (it must find `git` and authenticate).
16. **How it is built.** After the owner approves this spec, the PRs below are built without stopping to ask, each
    with an independent Opus review and green CI before merge; stop only for a fact that contradicts a decision. Each
    PR updates the user docs for what it adds (AGENTS.md).

## The PRs

1. **Schedules in the daemon and the command line.** The rule parser, slot arithmetic and the floor, the store, the
   tick, the ops, runs and their retention, skips and catch-up, `xpi roost schedule ...` with the launch built
   through the extension's wrapper, the refusal inside a session, the protocol doc; `roost.md` and `cli.md` for the
   commands.
2. **Schedules in the hub.** `/schedule` and the list, the run marker in rows, the log entries, notifications;
   `roost.md` for the hub.
3. **The login service.** `xpi roost daemon install|uninstall` and `status`'s line, for launchd and systemd; `roost.md`
   and `cli.md`.
4. **Wrap-up and release.** `porting.md` (phase 2 and the decision on resume; its stale "Grill 5" reference),
   `port-inventory.md`, spec 01's decision 6 note, README files, a release.

## Out of scope

`/loop` and other timers inside a session; one-shot schedules; cloud or always-on runs while the machine is off;
running a schedule as a shell command or an agent definition; automatic resume after a machine restart; starting the
daemon at login unless `daemon install` is run.
