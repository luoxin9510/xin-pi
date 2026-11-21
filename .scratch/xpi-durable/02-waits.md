# Spec 02: waits that do not hold a process

Status: draft for the owner's approval. Grill W1–W7 ("全是") and W8–W14 ("全部是") accepted as recommended on
2026-11-21. Two new choices found while writing (D1, D2, section 9) wait for the owner.

This is step 3 of the three steps that borrow ideas from upstream's `pi-durable` (step 1: xpi-graph spec 03, command
nodes that survive a crash; step 2: spec 01, a model run cut off by a crash). No code is ported; the idea taken is
pi-durable's "a wait is data (a deadline and what to do then), committed before the process lets go; something
outside wakes it" (`sleepUntil`, `onWake`/`wake()`).

## Problem

A session that has to wait holds a live process for the whole wait, and pays for it in model turns:

- the model runs `sleep 600` or a polling loop in bash (`gh pr checks --watch`, `until curl ...; do sleep 10; done`);
  the turn, the xpi process and a shell stay up, and a crash loses the wait (the orphaned `sleep` runs on; after
  `/continue` the model has to work out what it was waiting for);
- in roost, only an idle session is reaped (`reapIdle`, `daemon/main.ts`), and the only thing that wakes a reaped one
  is a reply. A session cannot say "wake me at 14:20" or "wake me when CI is green".

## Goal

A model can end its turn with a wait: until a time, or until a shell check passes (with a deadline). The wait is
written into the session before the turn ends. In roost the worker process exits and the daemon wakes the session
when the wait is due; outside roost the process keeps a timer. When the wait ends, the model is told why and a run
starts, with no user message made up. A crash, a reap, a daemon restart or a sleeping laptop loses nothing: the wait
is in the session file and in roost's state.

Not in this spec: graph approval nodes and command nodes that wait (they keep their process), waits in subagents,
waits for events other than time and a shell check (a webhook, a file watch).

## 1. The tool

A new tool `wait`, called from codemode: `tools.wait({ after?, at?, reason, check?, every? })`.

- `after` (a duration: `"90s"`, `"20m"`, `"2h"`, `"3d"`) or `at` (an ISO time, or `"HH:MM"` meaning the next such
  local time): exactly one. With a `check`, this is the deadline. The wait is at most 7 days (W2); a longer one is
  refused with that limit in the error.
- `reason`: required, one line; shown on the row and in the note at the end.
- `check` (optional): a shell command, run in the session's cwd. Exit code 0 means the condition holds. Each run is
  limited to 2 minutes (W8); a run that times out counts as "not yet".
- `every` (optional, only with `check`): how often the check runs; default `"2m"`, at least `"30s"` (W9). The first
  run is one interval after the call.

The call is accepted only from a tool call of the branch's latest assistant message (as graph's `next`); a background
script's call is refused (W10). A second call in the same run replaces the first (one pending wait per session). The
tool is not given to subagents (W11): the subagent extension leaves it out of a child's tools.

The result says the wait is recorded and asks to end the run: the tool result sets `terminate` (see D1 for what
happens to the rest of the script), so no further model request follows.

## 2. Entries

- `xpi.wait` (custom entry, hidden): `{ id, at, wakeAt, reason, check?: { command, everyMs, timeoutMs } }`. `at` and
  `wakeAt` are epoch ms. With a check, `wakeAt` is the deadline.
- `xpi.wake` (custom entry, hidden): `{ id, at, why, output? }`, `why` one of `due` (time reached, no check), `check`
  (the check passed), `deadline` (the check never passed), `user` (a user message came in), `continue` (`/continue`),
  `cancel` (`/wait cancel`), `blocked` (the check was refused by a protection; see section 4).
- `xpi.woke` (custom message, shown): the note the model reads, e.g.
  `[xpi] The wait you asked for ended: the check passed (gh pr checks 155). Reason: wait for CI. Waited 14:02–14:20
  (planned until 15:00). Last output: ...` With `deadline` it says the check never passed; with `user` or
  `continue` that the user ended it early. When the wake is later than planned (W13) it says
  `planned 14:20, woke 18:05`. `output` is the last 50 lines of the last check run (W8).

A wait is **pending** when the branch's last `xpi.wait` has no `xpi.wake` with its id anywhere in the session (the
same rule as run markers, so a fork or `/tree` does not revive it; `createBranchedSession` writes a `cancel` wake for a
pending wait it copies, as it closes open runs).

## 3. Waking

What ends a pending wait, and what happens:

| Event | Wake `why` | Run |
|---|---|---|
| `wakeAt` reached, no check | `due` | a run starts with the `xpi.woke` note |
| a check run exits 0 | `check` | a run starts with the note (output included) |
| `wakeAt` reached, check never passed | `deadline` | a run starts with the note (last output) |
| a user message (typed, a roost reply) | `user` | the user's run; the note goes before the message (W6) |
| `/continue` | `continue` | a run starts with the note; no check runs (W14) |
| `/wait cancel` | `cancel` | none; the notice says the wait was cancelled |
| the check was blocked | `blocked` | a run starts with the note saying why |

A wake that starts a run sends the note with `triggerTurn` (a `custom` trigger, so `before_agent_start` sees
`messageType: "custom"`). With a user message, the note and the `xpi.wake` are written before the user's message.

When the wake is found late (the process was gone, the daemon down, the laptop asleep), it happens the moment it is
found, however late (W13). For a pending wait without a check found after `wakeAt`: `due`. With a check: one check
runs at once; if it passes `check`, else `deadline`.

`/wait` shows the pending wait (reason, until, check and interval, last check result); `/wait cancel` ends it.

## 4. Where the timer and the check run

- **In the process.** While a session with a pending wait is open (interactive, print with a UI-less hold, or a roost
  worker that was not let go), the extension keeps one timer: to `wakeAt`, or to the next check. A check runs as the
  session's bash tool would run it: through the bash tool's executor (same cwd, env and shell), after a `tool_call`
  event for a synthetic `bash` call (`wait:<id>:<n>`), so protect, graph `deny` and other blockers apply. A blocked
  check ends the wait with `blocked`. No model request is made for a check.
- **Reopened.** At `session_start` (startup, resume) the extension finds a pending wait: if due, it wakes at once
  (W13); if not, it arms the timer. A reopened interactive session shows a line:
  `Waiting until 14:20: wait for CI (/wait cancel to stop, /continue to wake now).`
- **Print mode** (`xpi -p`): the run ends at the wait; the process exits as usual (exit 0) and says on stderr that a
  wait is pending. It does not stay up to wait.
- **Roost**: section 6.

## 5. The core

The wait itself lives in a built-in extension, `builtin:wait` (`src/extensions/wait/`), like graph. The core gets:

- `/continue` and a pending wait (W14): see D2.
- `createBranchedSession` closes a pending wait it copies (`cancel` wake), next to closing open runs.

Graph (`src/extensions/graph/`): a model node whose turn ended with a pending wait is waiting, not idle: no "ended
your turn without leaving it" reminder, no halt. When the wake's run starts, the node is still current, on its model
(W11).

## 6. Roost

- **Report.** The worker's tracker reports a session with a pending wait as `state: "working"`, `status: "waiting"`,
  `waitingFor: "wake"` (W12), and a new optional report field `wake: { at, every?, reason }`. The summary is
  `waits until 14:20: wait for CI`, or with a check `checks every 2m, until 15:00: wait for CI`. Adding the value and
  the field is additive: `PROTOCOL_VERSION` stays 1, and `docs/roost-protocol` (or the protocol doc the tests check)
  lists them.
- **Letting go.** When a worker reports a wait, no check or `every` of at least 2 minutes (W9), and no terminal is
  attached, the daemon stores `wakeAt` (the next check or the deadline) in the job's state (persisted, as `resumeAt`)
  and ends the worker as a reap does (`terminate-idle`; the row keeps its report, `reaped: true`). With a terminal
  attached, or `every` under 2 minutes, the worker stays and its own timer works.
- **Waking.** A daemon timer per job with a `wakeAt` (rebuilt from state when the daemon starts; one found overdue
  fires at once) respawns the worker from its session file with no prompt. The worker's extension finds the pending
  wait at `session_start` and does what section 4 says: runs the check (and, if it is not yet, reports the next
  `wakeAt` and is let go again) or wakes the model.
- **A reply** to a waiting session is delivered as now (a reaped row is respawned and the reply goes in): the wait ends
  with `user`.
- Stopping the row (`stop`) cancels the timer; the wait stays pending in the session file, and is found again if the
  session is started later.

## 7. Docs

- `docs/wait.md` (new): the tool, the check, what wakes it, `/wait`, roost.
- `docs/sessions.md`, `docs/session-format.md` (the three entries), `docs/roost.md` (a waiting row), the roost
  protocol doc, `docs/graph.md` (a node may wait), `docs/subagent.md` (not in subagents), `docs/extensions.md` (D2's
  hook if taken), `docs/porting.md` (a new entry "waits"), `docs/slash-commands.md` (`/wait`).

## 8. Milestones

1. **`builtin:wait`** (core and extension): tool, entries, the in-process timer and check, waking and the note,
   `/wait`, D2, forks, graph, subagents left out; print mode. Faux tests in `test/suite/wait.test.ts` and graph
   tests. By hand with Haiku 5.5 in a sandbox: a 2-minute wait in an open interactive session; a check on a file
   that another shell creates; reopening after `kill -9` during a wait.
2. **Roost**: report, letting go, the daemon's wake timer, a reply while waiting, the hub row. Daemon and worker
   tests. By hand with Haiku 5.5 in a sandbox roost: a `--bg` session that waits 3 minutes (worker gone, row shows
   the wait, woken on time); a check-based wait; a daemon restart during a wait; a reply during a wait.

Each milestone: branch, PR, CI, an independent Opus review, then merge. Real-model runs on Haiku 5.5 only. No release,
no npm.

## 9. Choices found while writing (for the owner)

**D1. The rest of the script after `wait`.** W10 said the code after `tools.wait(...)` still runs, then the run ends.
In codemode a nested call whose result asks to terminate ends the script at that call, like `exit()`
(`extensions/codemode/execute.ts`, "A nested call whose result says `terminate` ends the script"). Options:

- (a) `wait` ends the script where it is called, as any terminating call does: no core or codemode change; the tool
  description says `wait` is the last thing a script does.
- (b) Keep W10: add a "terminate after the script" kind of result to codemode, used only by `wait`.

➡️ Recommended: (a). It reuses a mechanism that already exists and is tested, and "the script stops at `wait`" is
easier for a model to predict than code that runs after the run was told to end.

**D2. How `/continue` wakes a wait.** `/continue` is handled by the core first (`AgentSession.prompt`), before any
extension command; a session whose last run completed returns "finished" and does nothing. Options:

- (a) A small generic core hook: an actionable extension event `continue_request`, fired by `continueRun()` when the
  core itself has nothing to continue (finished, stopped, none); a handler that returns `{ handled: true }` has
  started the run itself, and `continueRun()` returns `{ ran: true }` (no "Nothing to continue" notice, no
  `continue_skipped`). `builtin:wait` handles it when a wait is pending. Print mode and RPC get it too, since they
  call `continueRun()`.
- (b) Wake only through `/wait` (e.g. `/wait now`), and leave `/continue` as it is: W14 not met.

➡️ Recommended: (a). It is one event, it keeps `/continue` the one way to "go on", and roost's restart path (which
sends `/continue`) then also wakes a pending wait that is due.
