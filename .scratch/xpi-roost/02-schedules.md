# 02: xpi-roost, phase 2: schedules

Status: draft for the owner's approval. Decisions: Grill 4 of `decisions.md` (2026-11-12).

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
  schedules; names `[A-Za-z0-9._-]{1,40}`. Adding a schedule was possible only in the hub.
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

## Decisions

1. **Resume after an interruption is not added.** Phase 1's behaviour is Claude Code's (facts above); M38 is not
   ported and there is no `autoResume` setting. Phase 2 is schedules only. Spec 01's decision 5 and `porting.md`'s
   "Left out" table say so, with the reason: restarting unattended after a machine restart can repeat half-done work.
2. **Daemon schedules only.** A schedule starts new background sessions. A timer inside one session (`/loop`) is a
   core xpi feature (it needs tools for the model) and gets its own spec if wanted.
3. **Time rules.** Local time zone. `every <n>m|h|d`, `daily HH:MM`, `weekdays HH:MM`, `weekly <mon..sun> HH:MM`,
   `cron "<5 fields>"` (lists, ranges, steps; Sunday 0 or 7; day of month and day of week match as either), and
   `manual` (runs only when asked). Nothing runs more often than every 5 minutes: an `every` under 5 m and a cron rule
   whose next two slots are under 5 minutes apart are refused with that reason. No one-shot schedules. pi-roost's
   parser and slot arithmetic (DST, at least 1 s ahead, `every` anchored at creation or resume) are ported.
4. **Missed slots.** When the daemon starts, or finds on a tick that a slot passed while the machine slept, a schedule
   whose latest missed slot is within the last 7 days runs once; older ones are dropped. No `catchUp` option. The run
   is marked as a catch-up in the schedule's record and in the hub's log.
5. **A run.** A new background session, never a reply into an earlier one, with a fresh session file in the launch's
   session directory. It is named after the schedule (`nightly`, `nightly (2)`) and its record carries the schedule's
   name; the hub and `xpi roost ls` show it with the schedule's name. When a schedule has more than 3 runs that have
   ended, the daemon removes the older ones' records (as `rm` does: the session file stays and `/resume` finds it).
   Runs use the idle reaping every session gets; no auto-close.
6. **Overlap.** A slot that comes while the schedule's previous run is working, starting, waiting to restart, or
   waiting for an answer is skipped. The schedule records the time and reason ("previous run still working",
   "previous run waiting for input"), shown in its list. Nothing queues, nothing runs in parallel.
7. **Where schedules are made and managed.**
   - Hub: `/schedule <name> <when> <task>` adds one; `/schedule` alone opens the list (name, rule, next run, last run
     with its result or skip, paused) with run now, pause, resume, edit the rule, remove. The `<when>` of a rule with
     spaces is quoted.
   - Command line: `xpi roost schedule list|add|run|pause|resume|edit|rm`. `add <name> <when> <task>` takes `--cwd`,
     `--model`, `--thinking`; `edit <name>` takes `--when`, `--task`, `--model`, `--thinking`.
   - Not in an ordinary xpi session: `/schedule` there is not registered, so that a later `/loop` is not confused with
     it.
   - Schedule ops are person-only (the hub, the CLI), as in pi-roost; a session cannot add or run schedules.
8. **A run's launch.** Fixed when the schedule is made, by the xpi process that makes it (the hub or the CLI), with
   `buildLaunch` as for any new session: the directory (where the hub or CLI is, or `--cwd`), the model and thinking
   (the hub's for new sessions, or the flags), and the trust decision from `sessionTrust` for that directory with no
   answer from the person (only a stored decision counts, else `--no-approve`), so a run never waits at the trust
   question. The daemon stores the launch and starts it per run. `edit` builds the launch again. A run whose
   directory is gone is skipped with that reason.
9. **Notifications.** A run that finishes or needs input notifies as any session does (`notify`). A catch-up run, a
   skipped slot and a missing directory are logged in the hub's log and the schedule's record, without a notification.
10. **Limits.** At most 50 schedules, paused ones included. Names `[A-Za-z0-9._-]{1,40}`, unique. A task up to the
    length a dispatch accepts.
11. **State.** `<agent dir>/xpi-roost/schedules.json`, written by the daemon only, atomically and durably, as the
    other state files. The schedule tick runs every 15 s next to the daemon's other intervals.
12. **Protocol.** New ops `schedules`, `schedule-add`, `schedule-edit`, `schedule-rm`, `schedule-pause`,
    `schedule-run`, person-only in `callers.ts`; a `schedule` field on a job's record and row; a `"schedule"` event
    kind. `docs/protocol.md` documents them. The protocol version moves as phase 1's rules for a new op say.
13. **Not ported from M39/M40.** Profiles and `!` commands as scheduled tasks, agent-definition launches, the worktree
    check, subagent auto-close, the `PI_ROOST_SCHEDULE_TICK_MS` variable (a `ROOST_SCHEDULE_TICK_MS` test override is
    allowed if the tests need it, as with other `ROOST_*` overrides).
14. **Tests and checks.** pi-roost's schedule tests ported with an injected clock; daemon tests for due, skipped,
    catch-up (within and beyond 7 days), retention of 3 ended runs, a missing directory, the 5-minute floor, the 50
    limit, person-only ops; hub tests for `/schedule` and the list; CLI tests. Before each merge that changes what a
    session does, a real Haiku check: a `manual` schedule run now from the CLI and from the hub, a short `every 5m`
    schedule seen to fire and skip while its run is busy, a catch-up after a daemon restart.
15. **How it is built.** After the owner approves this spec, the PRs below are built without stopping to ask, each
    with an independent Opus review and green CI before merge; stop only for a fact that contradicts a decision.

## The PRs

1. **Schedules in the daemon and the command line.** The rule parser and slot arithmetic, the store, the tick, the
   ops, runs and their retention, skips and catch-up, `xpi roost schedule ...` with `add`, the protocol doc.
2. **Schedules in the hub.** `/schedule` and the list, the run marker in rows, the log entries, notifications.
3. **Docs and release.** `roost.md`, `porting.md` (phase 2 and the decision on resume), `port-inventory.md`, spec 01's
   decision 5 note, README files, a release.

## Out of scope

`/loop` and other timers inside a session; one-shot schedules; cloud or always-on runs while the machine is off;
running a schedule as a shell command or an agent definition; automatic resume after a machine restart.
