# 04: roost — a waiting session lets go of its process (spec 02, milestone 2)

Spec: `.scratch/xpi-durable/02-waits.md` section 6. After ticket 03.

- [ ] R.1 Worker: `waitingFor: "wake"`, report field `wake`, the summaries; protocol schema and protocol doc
      (additive, `PROTOCOL_VERSION` stays 1).
- [ ] R.2 Daemon: on a wait report (no check, or `every` ≥ 2m, no terminal attached) store `wakeAt` in state and end
      the worker as a reap does; with a terminal attached or a short `every`, leave it.
- [ ] R.3 Daemon wake timers: rebuilt from state at start, overdue fires at once; respawn with no prompt; a check that
      is not yet passes reports the next `wakeAt` and is let go again; `stop` cancels the timer.
- [ ] R.4 A reply to a waiting row ends the wait with `user`; hub shows the row (state, summary).
- [ ] R.5 Tests (daemon, worker wiring, tracker); docs `roost.md`, `wait.md` (roost part), `porting.md`.
- [ ] R.6 By hand, Haiku 5.5, sandbox roost: a 3-minute wait (worker gone, row shows it, woken on time); a check-based
      wait; a daemon restart during a wait; a reply during a wait. Results in `decisions.md`.
