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
