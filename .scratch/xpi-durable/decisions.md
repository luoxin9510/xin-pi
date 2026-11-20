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

## New choice for the owner (with the spec PR)

- **D1**: `/continue` after a run that ended on a provider error asks the model again from the same context.
  Recommended: yes; otherwise roost's restart after an error exit stops retrying, which it does today.
