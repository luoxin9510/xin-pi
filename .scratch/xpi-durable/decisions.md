# Decisions: xpi-durable

Step 2 of the ideas borrowed from upstream's `pi-durable`: the core recovers a model run cut off by a crash. Step 1
was xpi-graph spec 03 (`.scratch/xpi-graph/03-replay.md`).

## Facts found before the grill (research, 2026-11-20)

- Messages are written only at `message_end`. An assistant message with tool calls is written before its tools run;
  each tool result is written when it finishes (in parallel mode, in finishing order).
- A dangling tool call gets a synthetic "No result provided" result only when a provider request is built
  (`xpi-ai/src/api/transform-messages.ts`); it is never written.
- `xpi -c` only loads the session. `agent.continue()` accepts only a tail that converts to a user or tool result
  message.
- Roost DM-5 restarts a crashed worker with the user text "Continue where you left off.", at most 3 times (1 s, 5 s,
  15 s).
- A codemode script killed mid-run loses its nested record and its store writes; replay exists only for workflows.
- An RPC child exits when its stdin ends, so a subagent ends with its parent.

## Grill R1 (2026-11-20). Accepted by the owner ("全部按照你的推荐")

1. Recover only at the next action; at open, only tell.
2. The recovery is in the core; roost switches to it.
3. Dangling tool calls get real, written "interrupted" results; nothing is run again automatically.
4. Half-streamed replies are not written (they stay lost).
5. No codemode replay in this step.
6. Children exit on their own (already true through stdin end; a test pins it); the interrupted Agent result carries
   the agentId.

## Grill R2 (2026-11-20). Accepted by the owner ("全是")

7. Hidden run start and end markers written by the core; a start without an end means the process died. Not the
   shape of the branch's end: `terminate`, Esc and provider errors leave odd ends too.
8. At the next action: interrupted tool results (the Agent result with the agentId), then a short model-visible note,
   then the user's message, or `/continue` through `agent.continue()`.
9. A `/continue` command, also as `xpi -p -c "/continue"`; with nothing to continue it says so.
10. Roost keeps DM-5's automatic restart, with `/continue` instead of "Continue where you left off.". Not against 1:
    putting a job in roost is choosing to have it go on unattended.
11. No graph change beyond tests.
12. A spec PR first; then milestones (branch, PR, CI, an independent Opus review, merge); by-hand `kill -9` runs on
    Haiku 5.5 in a sandbox; no release.

## Facts found while writing the spec (author)

- `_startRun` (`agent-session.ts`) is the one entry of every model run; follow-ups, steering, retries and the
  pre-settle boundary run inside its loop, so one marker pair covers them. Its catch for a throwing `_prepareRun`
  skips the `finally`, so the end marker needs that path too.
- Built-in slash commands are handled only by interactive mode's submit handler; print mode and RPC call
  `session.prompt`, which knows only extension commands. `/continue` is therefore handled in `prompt()` itself.
- Roost does not talk RPC to restart: it starts a new process with the prompt as the positional message. It sends
  "Continue where you left off." in three places (DM-5, a restart while working, a resume of a failed row).
- The subagent meta file has no tool call id; a script's nested calls carry `parentToolCallId`, so the meta can
  record the model-issued call.
- Print mode exits 1 when the run ended on an error, and roost treats any non-zero exit as a crash. Hence D1.

## Spec review 1 (independent Opus, at eee662e8d): 3 blocking, 7 should-fix, 4 nits, all taken

- B1 `/continue` had no way into `_startRun`: a new `{ messageType: "continue" }` trigger, `agent.continue()` when
  there is no starting message; today's `before_agent_start` handlers do not read the trigger (checked).
- B2 D1 as written could not run: the final error message stays in the agent's messages; it is omitted first, as a
  retry does.
- B3 print mode exits 1 after an aborted tail, which roost would read as a crash: one `continueRun()` with a result;
  print mode exits 0 when it does not run; RPC returns the result.
- S1 roost has two more sites (the hub's `continue` command: now sends `/continue`; `/bg`: keeps its text, since its
  run ends `aborted` on purpose). S2 roost's command table needs the new built-in. S3 `/continue` is refused while
  compacting and runs inside the preflight reservation. S4 the agent's messages are rebuilt after recovery. S5 any
  exit mid-run counts (SIGTERM, `/quit`, stdin end), children included. S6 a second process can recover a live
  session: documented as a known limit (spec 03's one-process assumption; roost's lock warns). S7 docs list.
- N1 wording on hidden entries; N2 the note is not written twice; N3 what `tool_result` carries for a call not run
  here; N4 tests for an `agent_settled`-started run and `/continue` during compaction.

## Spec review 2 (same reviewer, the diff at ddc41605b): no blocking; 2 should-fix and 2 nits, all taken

- New-1 the hub's `continue` nudges a running or idle worker; `/continue` would refuse or do nothing there, so it
  keeps its text (listed under "Not changed" with `/bg`).
- New-2 a thrown `busy` would end interactive mode (the editor callback does not catch): `prompt()` never throws for
  `/continue`; the result is a notice, and `continueRun()` returns it.
- New-3 `docs/extensions.md` says the exported `BeforeAgentStartEvent` union gains a variant.
- New-4 where each recovery path keeps the branch still: the prompt path after `_isAgentRunActive` is set.

## Approval (2026-11-20)

The owner approved PR #151 ("批准"). D1 was not answered on its own; it is taken as recommended (the spec states it
so), and the owner may still change it.

## New choice for the owner (with the spec PR)

- **D1**: `/continue` after a run that ended on a provider error asks the model again from the same context.
  Recommended: yes; otherwise roost's restart after an error exit stops retrying, which it does today.

## Found while implementing milestone 1 (author)

- **"The branch's last marker is a start" is not enough.** The start is written before the run's user message, so a
  leaf moved by `/tree` to any point inside a finished run, or a fork made from a user message, shows a start with no
  end on the branch. The suite test of #8724 (an in-memory fork during a run) caught it. Now: cut off only when that
  run has no `end` anywhere in the session file, and `createBranchedSession` (fork, clone) appends an `aborted` end
  for each run its path leaves open. `forkFrom` copies the whole file, so it needs nothing. A crashed session cloned
  from its leaf therefore reads as stopped, not cut off, in the clone; the original keeps its recovery.
- Interactive mode queues input typed during a compaction unless it is an extension command; `/continue` is now
  counted with them, so it reaches `prompt()` and is refused as busy instead of being queued.
- The core shows `/continue`'s result through `ctx.ui.notify`, the same channel extension commands use, so
  interactive mode and RPC show it and print mode (no UI) does not; print mode calls `continueRun()` itself.
- Review 1 of PR #152 (independent Opus, at 79f1167ba): no blocking; 3 should-fix and 3 nits.
  - Taken: an attempt a retry left out of the context (`context_edit` with no replacement) and a failed or aborted
    reply no longer count as where the run stands (no results for their calls; a failed tail is cut off, not
    complete); D1 runs only when the branch really ends with a provider error (read from the branch, so it works in
    a session just reopened), not after a run that failed to start; `interruptedRun()` is undefined while this
    process runs; the docs' `callId` format (`<id>/Agent/<n>`) and the `continue` trigger wording.
  - Left: SendMessage (`talk.ts`) does not pass the call's id, so an interrupted SendMessage call does not name its
    agent (the meta keeps the id of the call that started it, which already has a result, so nothing wrong is named);
    `/continue` during `agent_settled` answers busy where a prompt would be deferred.
- By hand (C1.8), 2026-11-20, Haiku 5.5, sandbox (`XPI_CODING_AGENT_DIR`, a copy of the auth with 475 min left,
  deleted afterwards), the bundle built from 0bac47ecb, print mode:
  1. `sleep 30 && echo slept > slept.txt` through bash, `kill -9` 1.5 s after the tool call was written. Reopened with
     `-p -c "/continue"`: the notice on stderr; an interrupted result for the call, the note, the `recovered` end, then
     a new run. Haiku first checked for `slept.txt` (absent), then ran the command again and finished. Exit 0.
  2. A 700-word essay, `kill -9` while it streamed (before any reply was written). Reopened with a message: the note,
     no half reply; Haiku answered the new message (and remarked that nothing needed checking, a side effect of the
     note).
  3. An `Agent` call from a codemode script (`sleep 25 && ls | wc -l`), `kill -9` 4 s after the call. No child process
     was left. The meta file had `callId: <script call id>/1`; the interrupted result named the agent ("agentId
     5zcmnapd3x1i was running. Pass resume: ..."). `/continue`: Haiku resumed that agent instead of starting a new
     one and reported 2. Exit 0.
  - Found: the child does not die as a crash. Its stdin ends, its RPC shutdown aborts the run, and its session has an
    `aborted` end; `resume:` goes on from there (the bash call it ran got the usual aborted result). The spec said its
    session would be cut off; `docs/subagent.md` now says what happens. The nested id is `<script call id>/<n>`, as first
    written (review 1's `/Agent/` was wrong; matching is by prefix either way).
- Not covered by an automated test: `/continue` during a compaction (the harness cannot hold a compaction open);
  the code path is the `busy` check, which the test during a run covers.

## Found while implementing milestone 2 (author)

- **Roost's restart of a working session keeps its text.** `xpi roost restart` / `respawn --all` (restart onto a new
  build) asks the host to terminate the worker; xpi's shutdown aborts the run (as Esc does), so its session has an
  `aborted` end and `/continue` would say "Nothing to continue". That path keeps "Continue where you left off."
  (`CARRY_ON`), like `/bg`. `/continue` (`CONTINUE`) is used where the process ended without ending its run: the DM-5
  crash restart, a start by other means while that restart waits, and the resume of a failed row. Both constants are
  in `xpi-roost/src/lib/resume.ts` (a file of their own would put the package's entry points over their file budget).
  The hub's `continue` command is unchanged. A session file with no `xpi.run` entry (written before #152, e.g. a row
  that failed before an upgrade) is restarted with `CARRY_ON`: `/continue` would find nothing (review 1 of #153).
- **A move made before the crash is kept** (spec section 7 holds). `next` writes `graph.move` at once; the script's
  result and the next node come after. A crash between them leaves a pending move, which the graph enters in
  `before_agent_start` of the `/continue` run: a command node then runs once, and that run is answered by the model
  selected before the graph. A crash before `next` was reached leaves the node current, and the model moves again. (A
  first draft of the test snapshotted at the tool call, before `next` ran, and wrongly concluded the move was lost;
  review 1 of #153 caught it. The test now snapshots at the moment `graph.move` is appended.)
- The graph tests "kill" the first process by copying its session entries at that moment: the first harness lives on
  in memory and would otherwise keep writing into the session the second one opens.
- By hand (R2.4), 2026-11-20, Haiku 5.5, sandbox roost (its own daemon: `XPI_CODING_AGENT_DIR` names its own roost
  home and socket directory), the bundle built from this branch: `xpi --bg "Run the shell command: sleep 30 && echo
  roost > roost.txt. Then say done."`, then `kill -9` of the worker's xpi while bash ran. The daemon logged "restarts
  by itself (crash): worker killed by SIGKILL; continuing in 1 s (automatic restart 1 of 3)"; the new worker got
  `/continue` (no user message in the transcript); recovery wrote the interrupted result, the note and the
  `recovered` end. Haiku found no `roost.txt`, saw with `ps` that the old `sleep 30` was still running (the killed xpi's
  child), waited for it instead of running it again, and finished ("done" row). The sandbox daemon was stopped and
  the auth copy deleted.

## Review 1 of #153 (independent Opus, fresh context)

No blocking. Should-fix, both fixed: (1) a session with no run markers got `/continue` and stopped at "Nothing to
continue" → `marksRuns` falls back to `CARRY_ON`; (2) the move test snapshotted before `next` ran → it now snapshots as
`graph.move` is appended, which showed the move is kept (above). Nits: the third graph test now sends `/continue` (what
roost sends); a safe command node cut off after its turn ended runs again at the next message, not at `/continue`
(`docs/graph.md` says so). Left as is: after a `/continue` that runs nothing, a respawned row shows `working` until
the first-prompt timeout marks it done (the notice goes to `notify`, which a background worker shows to no one); a
small follow-up, not this milestone.

## Follow-up: a row after a /continue that ran nothing (2026-11-21)

The owner asked for the follow-up above to be fixed. The core now fires a notification-only extension event,
`continue_skipped` (`reason`: finished, stopped, none, busy, arguments; `message`: the notice text), when `/continue`
sent as a prompt starts no run; `continueRun()` itself (print mode, RPC) returns the reason and does not fire it. The
roost worker settles its row as `done` at once with the message as its summary (`WorkerTracker.commandNote`); `busy`
changes nothing (the run in progress settles the row), and so does a row already settled (a question waiting for someone who attached and typed `/continue`; review 1 of #154). Before: the row showed `working` for `FIRST_PROMPT_MS` (5 s),
then `done` with no summary, and the reason went only to `notify`, which no one sees in a background worker.

## Step 3: waits that do not hold a process (spec 02, 2026-11-21)

The owner said "好呢可以先发，然后继续后面的开发" after v1.17.0. Facts gathered first (a Sonnet subagent, read-only):
pi-durable waits are data (`sleepUntil` commits `{status: "sleeping", until, checkpoint}`; child waits commit
`{status: "waiting", on}`), the process lets go, and `onWake`/`wake()` let a host arm its own alarm; there is no
human-input or signal wait. In xin-pi a working session always holds its process; roost reaps only idle ones and wakes
only on a reply; model `sleep`/polling and graph command nodes that wait for CI hold the process; codemode has no
wait helper; schedules start new sessions, they do not wake one.

Grill round 1, all as recommended ("全是"):
- W1 First version: a session's own "wake me later" (model tool); graph waits and subagent waits later.
- W2 `tools.wait({ after | at, reason })`, writes an `xpi.wait` entry, the turn ends; at most 7 days.
- W3 In roost the worker exits and the daemon wakes it (persisted like `resumeAt`); outside roost an in-process timer;
  no new background service.
- W4 On waking: an `[xpi]` note (why, from–to) and a run starts; no made-up user message.
- W5 `check` (a shell command, exit 0 = done) with an interval, run by the extension without a model call, inside xpi
  so protections apply; in the first version.
- W6 A user message wakes it and ends the wait (the model is told); `/wait` shows, `/wait cancel` cancels.
- W7 Delivery as usual: spec PR for approval, milestones, CI, independent Opus review, Haiku only, no release.

Grill round 2, all as recommended ("全部是"):
- W8 Each check limited to 2 minutes; exit 0 wakes; `after`/`at` is the deadline; at the deadline wake anyway saying
  the check never passed; the last 50 lines of output go into the note.
- W9 `every` default 2m, at least 30s; in roost the worker exits between checks only when `every` is 2m or more.
- W10 The rest of the script runs, then the run ends; the last call in a run wins; only the latest assistant
  message's calls, background scripts refused. (See D1: the code does not do this today.)
- W11 Allowed in graph model nodes (wakes in the same node, same model); not given to subagents.
- W12 Roost row: state working, status waiting, new waitingFor `wake`; summary "waits until 14:20: ..." or "checks
  every 2m, until 15:00: ..."; never blocked.
- W13 A wake found late happens at once, however late; the note says planned vs actual.
- W14 `/continue` during a wait wakes now, no check. (See D2: needs a core hook.)

Found while writing the spec (section 9): D1 (a terminating nested call ends a codemode script at once, so W10's
"rest of the script runs" needs a codemode change; recommended: let `wait` end the script) and D2 (`/continue` is
handled by the core before extensions; recommended: a `continue_request` event). Also: graph's "ended your turn
without leaving it" reminder would fire after a wait; the spec makes graph treat a pending wait as waiting.

## Spec 02 review 1 (independent Opus, fresh context)

3 blocking, 8 should-fix, 3 nits; all taken into the spec:
- B1 An extension cannot run a tool through its hooks between runs (`ctx.executeTool` needs a parent tool call) →
  new choice D3 (a core `ctx.runTool`), listed as a core change.
- B2 Roost restart paths would wake a wait with a made-up prompt (`CARRY_ON` on restart of a "working" row; `/continue`
  on a crash) → a waiting row is never "working" for restart rules; respawn adds no prompt; no DM-5 restart for it.
  D2 no longer says "a due wait": `/continue` wakes any pending wait (W14).
- B3 Reusing `resumeAt` would force `/continue`; a new `wakeAt` must be known to `cleanable`, `runStillWorking`,
  `runState`, `finalize` (a let-go waiting row stays waiting, not done) and `toRow` → named in section 6.
- S1 `terminate` ends a run only when the whole batch terminates; queued steers go on → the wait is recorded at
  `agent_settled`; a user message in the same run drops it.
- S2 Runs started by something else (background results, subagent reports) → the wait stays pending; a timer that
  fires during a run waits for it to settle (never steered in).
- S3 Crash between writing the wait and the run's end → recording at `agent_settled` means no half-made wait on disk.
- S4 The next check time → `at + k × every`, recomputed on reopen; one found past runs at once.
- S5 A worker not let go has no persisted wake → the daemon stores `wakeAt` anyway and `finalize` keeps the row waiting.
- S6 Closed `waitingFor` enum (`REPORT_WAITING`, `acceptReport`, `events.ts`, `view-model.ts`) → all named; the
  protocol doc says unknown values are `null`.
- S7 A user message during a check → the check is killed, its result ignored; the note via `before_agent_start`.
- S8 Two processes → the daemon retries a locked respawn every minute; first wake written wins.
- Nits: time zones and DST for `at`/`"HH:MM"`; the print-mode contradiction; the by-hand plan now covers restart,
  crash, a batch with another tool, a background result during a wait, cleanup.

Round 2 (same reviewer, the revision): round 1 fixed; 2 should-fix and 3 nits from the new text, all taken:
- graph's reminder runs at `agent_before_settle`, before `agent_settled` → the wait is a draft entry at that boundary
  (`builtin:wait` loads before graph; graph reads `event.entries`); an aborted run records none.
- `before_agent_start` messages come after the user's message → the note and wake are appended in `input`; M1
  checks `input` fires for typed, `sendUserMessage` and CLI messages, else a small core option.
- `wakeAt` is cleared on a report without `wake` and on `stop`, kept by `respawn`; a respawned waiting row keeps
  its display until the new worker reports; the status line's W ranges.

Round 3 (same reviewer): approve. Two nits taken into section 1: a queued user message after the boundary ends a
recorded wait with `user` (decided in `input`); `docs/extensions.md` will say boundary handlers keep `event.entries`.

Approval (2026-11-21): the owner answered "全部推荐": the spec is approved and D1 (a), D2 (a), D3 (a) are taken.

## Found while implementing spec 02 milestone 1

- `input` fires for every prompt source (typed, `pi.sendUserMessage`, RPC, CLI messages: all go through
  `AgentSession.prompt` → `_preparePrompt`) before the user's message is written, so the note and wake go in there; no
  core option was needed. Extension commands (`/wait`) and `/continue` are handled before `input`, so they do not end a
  wait as `user`.
- Subagents: built-in extensions that must not run in a child return early on `XPI_SUBAGENT_DEPTH` (commit, roost,
  relay); `builtin:wait` does the same, so a child has no `wait` and no `/wait`.
- A blocked call and a failed one looked the same to a caller of `runToolCall` (both `isError` with a text). The
  agent-core outcome now carries `blocked: true` for a call a `beforeToolCall` hook blocked, which `ctx.runTool` passes
  on; the check uses it for `blocked`.
- An Esc during the run's end boundary (after the wait's draft was given) still appends the drafts; `agent_settled`
  then sees `aborted` and writes a `cancel` wake for the wait written in that run, with a notice. So "a run stopped
  with Esc leaves no pending wait" holds in both windows.
- `exposure: "codemode"`: in the first by-hand run Haiku first called `wait` as a direct tool (refused: it must come
  from a script), then from codemode. The tool is now codemode-only (listed in codemode's description, not declared
  directly), as the spec meant.
- `ctx.runTool` became a required member of `ExtensionContext`; test fakes that build a full context add it (one did:
  `test/trigger-compact-extension.test.ts`).

By hand (W.6), 2026-11-21, Haiku 5.5, sandbox agent dir (an auth copy taken through `copyUserAuth`, 63 min before
expiry; deleted after), the bundle of this branch, `xpi --mode rpc` driven by `.e2e-tmp/waitdrive.mjs` (an open
session, so timers run):
1. "Wait 2 minutes ... reply WOKE": the wait was recorded, the run ended; 120 s later a run started with
   `[xpi] The wait you asked for ended: its time came ...`; Haiku replied WOKE. (Before `exposure: "codemode"`, its
   first call was a refused direct call.)
2. A check (`test -f ready.txt`, every 30s, deadline 10m), the file created by the driver at +45 s: the check at +30 s
   failed, the one at +60 s passed; the note said the check passed; Haiku read the file's first line.
3. A 1-minute wait, `kill -9` at +10 s, reopened (`--continue`, no prompt) at +140 s: the wait woke at once at
   `session_start`, the note said `planned 18:03, woke 18:04`; Haiku replied BACK.

## Review of #157 (independent Opus, fresh context, two rounds)

Round 1: no blocking. Four should-fix items, all fixed:
1. Timers matched the context object by identity. Each event hands a new one, so a check that ended after any settle was dropped. They now key on a session generation.
2. A wake that was deferred during a manual compaction was lost, because a compaction has no settle. It is now retried every 5 s.
3. The deferred wake at the settle could be steered into a run that another extension had started. It now goes through `fire`.
4. Print mode ended a due wait as `user`. A message to a due wait with no check now ends it as `due`.

Also from that round: no bash tool now ends a check wait as `blocked`, and the `continue_request` docs are corrected.

Round 2: no blocking and no should-fix. Two nits were fixed:
- A timer now takes the generation when it is set.
- A wake that was found while the session was busy keeps its reason over a user message.

The first CI failure was a test-timing problem, not a bug in the code: the clock moved on while a real-shell check was still running. The test now waits for each check to end.

## Found while implementing spec 02 milestone 2

- **The worker cannot compute `next` alone.** A session reopened after a check time has a first check that is already due. `nextCheckAt` would give the following step, which is in the future, so the daemon would let go before the check ran. The wait extension therefore says when it next looks at a wait on `pi.events` (`WAIT_EVENT` in `core/waits.ts`: `{ id, next }` when it arms, `{ id, ended: true }` when it wakes). The worker reports that value. Until the extension speaks, the worker reports the first check time, or the wait's time when there is no check. A time that has already passed means "acting now", and the daemon does not let go of a worker whose `next` has passed.
- **`wakeAt` is a durable state key.** It is written only when it changes, so other reports stay non-durable writes.
- **One `finalize` branch covers every ending.** It turns any end of a waiting row's process into a waiting row: let go, crash, host gone, machine restart at daemon start, and a restart whose new start failed. Only a stop is excluded, and a stop clears `wakeAt` before ending the process. There is no DM-5 crash restart for a waiting row.
- **A respawn shows the wait until the worker reports.** A respawn with no prompt and no replies for a waiting row (the wake timer, a restart) keeps it shown as `working` / `waiting` / `wake` with its summary. A reply's respawn shows it working as usual. `wakeAt` stays until the new worker reports without a wait.
- **Entering a wait is a feed event** (`state` with `waitingFor: "wake"` and the row's summary), shown as "<name> waits until …".
