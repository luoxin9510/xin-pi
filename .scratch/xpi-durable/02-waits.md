# Spec 02: waits that do not hold a process

Status: draft for the owner's approval. Grill W1–W7 ("全是") and W8–W14 ("全部是") accepted as recommended on
2026-11-21. Reviewed twice by an independent Opus (round 1: 3 blocking, 8 should-fix, 3 nits; round 2: 2 should-fix,
3 nits; all taken; see `decisions.md`).
Three new choices found while writing and reviewing (D1, D2, D3, section 10) wait for the owner.

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

A model can end its run with a wait: until a time, or until a shell check passes (with a deadline). The wait is written
into the session when the run ends. In roost the worker process exits and the daemon wakes the session when the wait
is due; outside roost the process keeps a timer. When the wait ends, the model is told why and a run starts, with no
user message made up. A crash, a reap, a daemon restart or a sleeping laptop loses nothing: the wait is in the session
file and in roost's state.

Not in this spec: graph approval nodes and command nodes that wait (they keep their process), waits in subagents,
waits for events other than time and a shell check (a webhook, a file watch).

## 1. The tool

A new tool `wait`, called from codemode: `tools.wait({ after?, at?, reason, check?, every? })`.

- `after` (a duration: `"90s"`, `"20m"`, `"2h"`, `"3d"`) or `at`: exactly one. `at` is an ISO time (one without an
  offset is local time) or `"HH:MM"` (the next such local time). "Local" is the time zone of the process that runs
  the tool; the wait is stored in epoch ms, so the daemon's time zone does not matter. A local time that does not
  exist (a DST gap) moves forward to the first one that does; a repeated one takes the first. With a `check`, this is
  the deadline. The wait is at most 7 days (W2); a longer one is refused with that limit in the error.
- `reason`: required, one line; shown on the row and in the note at the end.
- `check` (optional): a shell command, run in the session's cwd. Exit code 0 means the condition holds. Each run is
  limited to 2 minutes (W8); a run that times out counts as "not yet".
- `every` (optional, only with `check`): how often the check runs; default `"2m"`, at least `"30s"` (W9). Checks run
  at `at + k × every` (k = 1, 2, …) up to the deadline.

The call is accepted only from a codemode script of the branch's latest assistant message (graph's
`calledByLatestRequest` rule, `extensions/graph/index.ts`); a background script's call or a direct call is refused
(W10). A second call in the same run replaces the first. The tool is not given to subagents (W11): the subagent
extension leaves it out of a child's tools.

The result says the wait is recorded and asks to end the run: it sets `terminate`, which ends the codemode script at
the call (D1) and the run if every result of the tool batch terminates. The tool description says to call `wait`
alone, as the last thing a script does.

**The wait is recorded when the run ends, not when the tool runs.** The tool keeps the wait in memory; at the run's
final boundary, `agent_before_settle`, the extension adds `xpi.wait` as an entry draft (the boundary appends drafts
with the run's other end-of-run entries). `builtin:wait` is loaded before `builtin:graph`, so graph's handler at the
same boundary sees the draft in `event.entries` (section 5). A run that ends aborted (Esc) does not reach that
boundary with the wait, or reaches it aborted: no wait is recorded, and at `agent_settled` the extension drops what it
kept and says so. So:

- a run cut off by the end of the process (spec 01) never leaves a half-made wait: there is no `xpi.wait` on disk, the
  core repairs the run as for any other tool call, and the model, told the call was interrupted, can wait again;
- if the run went on after the call (another tool in the same batch did not terminate, or a queued steer or follow-up
  came in): a user message in that run drops the wait (the model saw the user's message; nothing to tell); otherwise
  the wait is recorded when the run ends, as asked.

## 2. Entries

- `xpi.wait` (custom entry, hidden): `{ id, at, wakeAt, reason, check?: { command, everyMs, timeoutMs } }`. `at`
  (when the run ended) and `wakeAt` are epoch ms. With a check, `wakeAt` is the deadline and the next check is
  `at + k × everyMs`.
- `xpi.wake` (custom entry, hidden): `{ id, at, why, output? }`, `why` one of `due` (time reached, no check), `check`
  (the check passed), `deadline` (the check never passed), `user` (a user message came in), `continue` (`/continue`),
  `cancel` (`/wait cancel`, or a fork closing it), `blocked` (the check was refused by a protection; section 4).
- `xpi.woke` (custom message, shown): the note the model reads, e.g.
  `[xpi] The wait you asked for ended: the check passed (gh pr checks 155). Reason: wait for CI. Waited 14:02–14:20
  (planned until 15:00). Last output: ...` With `deadline` it says the check never passed; with `user` or `continue`
  that the user ended it early. When the wake is later than planned (W13) it says `planned 14:20, woke 18:05`.
  `output` is the last 50 lines of the last check run (W8).

A wait is **pending** when the branch's last `xpi.wait` has no `xpi.wake` with its id anywhere in the session (the
same rule as run markers, so a fork or `/tree` does not revive it). `createBranchedSession` writes a `cancel` wake for
a pending wait it copies, next to closing open runs (`session-manager.ts`).

## 3. Waking

| Event while a wait is pending | Wake `why` | Run |
|---|---|---|
| `wakeAt` reached, no check | `due` | a run starts with the `xpi.woke` note |
| a check run exits 0 | `check` | a run starts with the note (output included) |
| `wakeAt` reached, the check never passed | `deadline` | a run starts with the note (last output) |
| a user message (typed, a roost reply) | `user` | the user's run; the note goes before the message (W6) |
| `/continue` | `continue` | a run starts with the note; no check runs (W14) |
| `/wait cancel` | `cancel` | none; a notice says the wait was cancelled |
| the check was blocked | `blocked` | a run starts with the note saying why |
| a run started by something else (a background script's or a subagent's result, an extension's `triggerTurn`) | none | the run goes on; the wait stays pending |

- A wake that starts a run sends the note with `triggerTurn` (a `custom` trigger). If a run is active when the timer
  fires (the row above: something else started one), the wake waits for that run to settle; it is never steered into
  it.
- With a user message: the extension's `input` handler (fired before the user's message is written) appends the
  `xpi.wake` and the note without triggering a turn, so both come before the message (`before_agent_start` messages
  would come after it: `_prepareRun` puts handler messages after the starting message). Milestone 1 first checks that
  `input` fires for a typed message, `pi.sendUserMessage` (roost replies) and a CLI message; where it does not, a
  small core option to place a message before the starting one is added and noted in `decisions.md`. A test asserts
  the order. A check running at that moment is killed and its result ignored.
- A wake found late (the process was gone, the daemon down, the laptop asleep) happens the moment it is found, however
  late (W13). A pending wait without a check found after `wakeAt`: `due`. With a check, found after a check time: one
  check runs at once; past the deadline, if it fails: `deadline`.
- `/wait` shows the pending wait (reason, until, check and interval, next check, last result); `/wait cancel` ends it.

## 4. Where the timer and the check run

- **In the process.** While a session with a pending wait is open, the extension keeps one timer: to `wakeAt`, or to
  the next check time. A check runs as the bash tool would: through the session's bash tool, with its `tool_call` and
  `tool_result` events, so protect, graph `deny` and other blockers apply (D3). A blocked check ends the wait with
  `blocked`. No model request is made for a check, and nothing of a check is written to the transcript except, at the
  end, the wake and its note.
- **Reopened.** At `session_start` (startup, resume) the extension finds a pending wait: if due, or a check time has
  passed, it acts at once (W13); if not, it arms the timer. An interactive session shows a line:
  `Waiting until 14:20: wait for CI (/wait cancel to stop, /continue to wake now).`
- **Print mode** (`xpi -p`): the run ends at the wait; the process exits as usual (exit 0) and says on stderr that a
  wait is pending. It does not stay up to wait, and a later `xpi -p -c` with a pending wait that is due wakes it first.
- **Roost**: section 6.

## 5. The core and other extensions

The wait lives in a built-in extension, `builtin:wait` (`src/extensions/wait/`), like graph. The core gets:

1. D2: `/continue` and a pending wait (W14).
2. D3: a way for an extension to run a tool call outside a model's tool call (for the check).
3. `createBranchedSession` closes a pending wait it copies (`cancel` wake).

Graph (`src/extensions/graph/`): a model node whose run ended with a wait is waiting, not idle: no "ended your turn
without leaving it" reminder, no halt. At `agent_before_settle` the graph looks for an `xpi.wait` draft in
`event.entries` (this run's wait) or a pending one on the branch. When the
wake's run starts, the node is still current, on its model (W11).

Subagents (`src/extensions/subagent/`): `wait` is left out of a child's tools.

## 6. Roost

A row whose session has a pending wait is a **waiting row**. It is never "working" for any restart rule, though it is
reported as working (W12).

- **Report.** The worker's tracker reports a waiting row as `state: "working"`, `status: "waiting"`,
  `waitingFor: "wake"`, and a new optional report field `wake: { at, next, every?, reason }` (`next`: the next check
  or the deadline). The summary is `waits until 14:20: wait for CI`, or `checks every 2m, until 15:00: wait for CI`.
- **Protocol.** `waitingFor` is a closed enum today. Every place that reads it takes `"wake"`: the schema
  (`lib/protocol-schema.ts`), `REPORT_WAITING` and `acceptReport` in the daemon (which also accepts the `wake` field),
  `events.ts`, the hub's `view-model.ts`, and the protocol doc and its test. `PROTOCOL_VERSION` stays 1: the doc says
  a client must treat an unknown `waitingFor` as `null`; clients outside this repo (the frozen pi-roost and its SDKs)
  see an unknown value.
- **State.** A new job state field `wakeAt` (epoch ms, the report's `next`), persisted like the other state fields. It
  is not `resumeAt` (that one means a crash restart: `respawn` forces `/continue` and counts `crashRestarts` for it).
  A row with `wakeAt` is not cleaned by `cleanupDays` (`cleanable`), counts as still running for schedules
  (`runStillWorking`, `runState`), and shows its status and `waitingFor` even when its worker is gone (`toRow`).
  `wakeAt` is cleared when a worker reports without `wake` (the wait ended, the session works or is idle), and on
  `stop`; `respawn` keeps it (it clears `resumeAt`, not this). A respawn of a waiting row keeps the row's display
  (state, status, `waitingFor`, summary) until the new worker reports, as `restore` does for an idle row.
- **Letting go.** When a worker reports a wait with no check, or with `every` of 2 minutes or more, and no terminal is
  attached, the daemon ends the worker through a new path modelled on `terminateIfIdle` (the host refuses when a
  terminal attaches meanwhile; a reply that comes in meanwhile is delivered by a respawn, as for a reap). `finalize`
  for such an exit keeps the row a waiting row (`reaped: true`, state, status, `waitingFor` and summary unchanged); it
  does not mark it done.
- **Not let go** (a terminal attached, or `every` under 2 minutes): the worker's own timer works, and the daemon still
  stores `wakeAt`. If that worker ends anyway (a crash, a machine restart), `finalize` keeps the row a waiting row
  instead of `stopped`/`failed`, and the daemon's timer wakes it.
- **Restarts.** For a waiting row, `respawn` adds no prompt: not `CARRY_ON` on `restart` (`xpi roost restart`,
  `respawn --all`), not `/continue` on a crash (no DM-5 automatic restart for it; the wake timer covers it). The new
  worker finds the pending wait at `session_start` and does what section 4 says.
- **Waking.** One daemon timer per row with a `wakeAt`, rebuilt from state when the daemon starts; one found overdue
  fires at once. It respawns the worker with no prompt. A check that is not yet passing reports the next `wakeAt` and
  is let go again. If the respawn fails because another process holds the session's write lock (someone opened it),
  the daemon tries again every minute; that process's own timer handles the wait meanwhile, and whichever writes the
  `xpi.wake` first wins (the other sees it on its next look).
- **A reply** to a waiting row is delivered as now (a let-go row is respawned and the reply goes in): the wait ends with
  `user`.
- **Stop** (`stop` on the row) cancels the daemon's timer and clears `wakeAt`; the wait stays pending in the session
  file and is found again if the session is started later.

## 7. Races and limits

- One process per session is assumed (spec 01); two processes on one session can both run checks until one writes the
  wake.
- The extension acts on the wait only between runs: a timer that fires during a run waits for it to settle; a check
  in progress when a user message arrives is killed (section 3).
- A wait does not survive `/new` or `/resume` of another session in the same process (the timer belongs to the
  session; it is armed again when that session is opened).

## 8. Docs

- `docs/wait.md` (new): the tool, the check, what wakes it, `/wait`, roost.
- `docs/sessions.md`, `docs/session-format.md` (the three entries), `docs/roost.md` (a waiting row), the roost
  protocol doc, `docs/graph.md` (a node may wait), `docs/subagent.md` (not in subagents), `docs/extensions.md` (D2's
  and D3's API), `docs/porting.md` (a new entry "waits"), `docs/slash-commands.md` (`/wait`).

## 9. Milestones

1. **`builtin:wait`** (core and extension): tool, entries, recording at `agent_before_settle`, the in-process timer and
   check, waking and the note, `/wait`, D2, D3, forks, graph, subagents left out, print mode. Faux tests in
   `test/suite/wait.test.ts` (including: `wait` with another tool in the batch; a steer after the call; a timer
   firing during a background-triggered run; a user message during a check; `kill -9` before the run ends; a
   blocked check) and graph tests. By hand with Haiku 5.5 in a sandbox: a 2-minute wait in an open session; a check on
   a file another shell creates; `kill -9` during a wait, reopen.
2. **Roost**: report and protocol, state, letting go, restarts, the wake timer, a reply, the hub row. Daemon, worker
   and hub tests. By hand with Haiku 5.5 in a sandbox roost: a `--bg` session that waits 3 minutes (worker gone, row
   shows the wait, woken on time); a check-based wait; `xpi roost restart` and a daemon restart during a wait; a
   worker crash during a short-`every` wait; a reply during a wait; a wait that outlives a cleanup pass.

Each milestone: branch, PR, CI, an independent Opus review, then merge. Real-model runs on Haiku 5.5 only. No release,
no npm.

## 10. Choices found while writing and reviewing (for the owner)

**D1. The rest of the script after `wait`.** W10 said the code after `tools.wait(...)` still runs. In codemode a nested
call whose result asks to terminate ends the script at that call, like `exit()` (`extensions/codemode/execute.ts`).

- (a) `wait` ends the script where it is called: no codemode change; the description says `wait` comes last.
- (b) Keep W10: add a "terminate after the script" kind of result to codemode, used only by `wait`.

➡️ Recommended: (a). It reuses a tested mechanism, and "the script stops at `wait`" is easier for a model to predict.

**D2. How `/continue` wakes a wait.** `/continue` is handled by the core first (`AgentSession.prompt`); a session
whose last run completed returns "finished" and does nothing.

- (a) A small generic core hook: an actionable extension event `continue_request`, fired by `continueRun()` when the
  core itself has nothing to continue (finished, stopped, none). A handler that returns `{ handled: true }` has
  started the run itself; `continueRun()` returns `{ ran: true }` (no notice, no `continue_skipped`). A cut-off run
  is repaired by the core first, as now, and the event is not fired. Print mode and RPC get it too.
- (b) Wake only through `/wait` (`/wait now`); `/continue` stays as it is: W14 not met.

➡️ Recommended: (a). One event, and `/continue` stays the one way to "go on".

**D3. Running the check through the protections.** W5 says the check runs inside xpi so protect and graph `deny`
apply. Today the only way for an extension to run a tool through its hooks is `ctx.executeTool()`, which exists only
inside another tool's `execute()` and records the call under that parent call's result. Between runs there is no
parent.

- (a) A core addition: an extension can run a tool call on its own (e.g. `ctx.runTool(name, args)`), outside any
  model tool call. It goes through `tool_call` (blockers can refuse it) and `tool_result`, is not written to the
  transcript, and works with no run active. Graph `deny` and protect decide from the call's arguments and the
  session's state, so they work between runs.
- (b) Run the check with a plain child process (`pi.exec`), without the protections: W5 not met; a check could run a
  command a graph node denies.

➡️ Recommended: (a). It keeps W5, and the same addition later serves graph command nodes that want to wait.
