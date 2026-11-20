# Spec 01: a model run cut off by a crash, recovered by the core

Status: draft for the owner's approval. Grill R1 (Q1–Q6) and R2 (Q7–Q12) accepted as recommended on 2026-11-20; one
new choice found while writing (D1, section 5) is put to the owner with this PR; see `decisions.md`.

This is step 2 of the three steps that borrow ideas from upstream's `pi-durable` (step 1 was xpi-graph spec 03,
command nodes that survive a crash; step 3, waits that do not hold a process, is not in this spec). No code is ported.

## Problem

When the process dies during a model run (`kill -9`, a closed laptop, an OOM, roost restarting a worker), the session
on disk ends wherever the last `message_end` left it:

- an assistant message with tool calls and none, or some, of their results (tool results are written one by one, and
  in parallel mode not necessarily in call order);
- a user message, a tool result or a custom message, when the process died while a reply streamed (half-streamed
  replies are never written);
- a complete assistant reply, when it died after the reply but before the run ended.

Nothing in the core notices. `xpi -c` only loads the session. A dangling tool call gets a synthetic "No result
provided" result only when a provider request is built (`xpi-ai/src/api/transform-messages.ts`), never written, so the
model never learns that a call may have run in part. `agent.continue()` refuses an assistant tail, so the only way on
is a new user message. Roost works around this by restarting a crashed worker with the user text "Continue where you
left off." (`xpi-roost/src/daemon/main.ts`, DM-5), which puts a message the user never wrote into the transcript.

## Goal

The core knows that the last run was cut off, says so when the session is opened, and at the user's next action
repairs the branch (real "interrupted" results for the dangling calls, a short note to the model) and goes on: with
the user's message, or with the new `/continue`, which continues without one. No tool is run again by the core. Roost
uses `/continue`.

## Design

### 1. Run markers (Q7)

`AgentSession._startRun` is the single entry of every model run (a prompt, a custom message that triggers a turn,
and inside it follow-ups, steering, retries, overflow recovery and the pre-settle boundary). It writes two hidden
entries:

```
custom  customType "xpi.run"  data { phase: "start", id, at }
custom  customType "xpi.run"  data { phase: "end", id, at, outcome }
```

- `start` is written at the top of `_startRun`, after any recovery (section 3) and before `_prepareRun`.
- `end` is written when the run ends, before `agent_settled` is emitted: in the `finally`, and also on the path where
  `_prepareRun` throws (today that catch skips the `finally`). `outcome` is `completed`, `aborted` (Esc, `abort()`),
  `error` (the last assistant message has `stopReason: "error"`, or the run threw), or `recovered` (section 3).
- `id` is a fresh random id; `end` names the `start` it closes.

Custom entries never enter the model's context and are hidden in the default tree view, like `usage` entries. Older xpi
reads them as unknown custom entries and ignores them. A session written before this change has no markers and is never
treated as cut off.

**Cut off** means: walking the current branch back from the leaf, the last `xpi.run` entry is a `start`. Only the
branch counts: after `/tree` to a point before the run, nothing is cut off; a fork of a cut-off session is cut off too
(it holds the same state). This process can never see its own run as cut off, since recovery is only checked when no
run is active.

The session file is written lazily (`SessionManager._persist`, on the first user or assistant message). A process that
dies before that leaves nothing on disk, and nothing needs recovering.

### 2. When the session is opened (Q1)

Nothing is written at open: the process that opens a session may only be looking (the roost hub, a viewer, `/resume`
to read). `AgentSession.interruptedRun()` returns `{ startedAt, danglingToolCalls }` or `undefined`, and the modes tell:

- interactive: a warning line after the session loads: `The last run stopped before it finished (the process ended).
  Send a message to go on, or /continue to go on without one.`
- print mode: the same line on stderr.
- RPC: `get_state` gains `interruptedRun: boolean`.

### 3. Recovery at the next action (Q3, Q4, Q8)

When a run is about to start (`_startRun`) or `/continue` runs, and the branch is cut off, the core writes, in order:

1. For each tool call of the last assistant message of the cut-off run that has no tool result on the branch, a tool
   result message: `isError: true`, `details: { interrupted: true }`, content `[xpi] Interrupted: the process ended
   while this tool call ran. It may have run in full, in part or not at all; check its effects before running it
   again.` Results are written in call order. The core runs no tool again (Q3); a codemode script's nested calls are
   not replayed either (Q5).
   - Each one goes through the `tool_result` extension event, so an extension may add to it (section 4). This is the
     only time the event fires for a tool that did not run in this process; `docs/extensions.md` says so.
2. A custom message the model sees (`custom_message`, customType `xpi.interrupted`, displayed): `[xpi] The previous run
   stopped before it finished (the process ended). Check the state of what you were doing, such as half-edited files,
   before going on.`
3. The `end` marker of the cut-off run with `outcome: "recovered"`.

Then the new run starts as usual: with the user's message, or, for `/continue`, with no new message
(`agent.continue()`; the tail is now a tool result or the custom message, which it accepts).

If the cut-off run's last message is a complete assistant reply with no tool calls (the process died after the reply),
nothing was lost: only step 3 is written, with no note, and `/continue` then has nothing to continue.

The end marker is written last, so a crash during recovery leaves the run cut off and the next action repairs what is
still missing (tool calls that already got a result are skipped; the note may then appear twice).

Half-streamed replies stay lost (Q4): they were never written.

### 4. Subagents (Q6)

- A child agent runs as its own process over RPC and exits when its stdin closes (`rpc-mode.ts`, on input end →
  shutdown), so it ends when the parent dies. This is already true; a test pins it.
- The subagent extension's meta file (`registry.ts`) gains `callId`: the model-issued tool call the agent was started
  under (the Agent call itself, or the codemode call whose script started it, from the nested call's
  `parentToolCallId`).
- The extension adds a `tool_result` handler: for an interrupted result (`details.interrupted`), it appends one line
  per agent whose meta `callId` is that call: `Agent <type> (<description>) agentId <id> was running. Pass resume:
  "<id>" to continue it.` and marks those records stopped.

Background agents started in earlier turns are not changed by this spec.

### 5. `/continue` (Q9, D1)

A built-in command, handled in `AgentSession.prompt()` before extension commands, so it works the same in interactive
mode, in print mode (`xpi -p -c "/continue"`) and over RPC (`prompt` with `/continue`). It is added to
`BUILTIN_SLASH_COMMANDS` (autocomplete, the name-clash check of extension commands and subagent names).

- The branch is cut off: recovery (section 3), then a run with no new message.
- **D1 (new, recommended):** the last run ended with `outcome: "error"` (a provider error after any retries): a run
  with no new message, so the model is asked again from the same context (the error message is already left out of
  provider requests). Without this, roost's restart after an error exit (print mode exits 1) would stop retrying,
  which "Continue where you left off." does today.
- Otherwise (the last run completed or was aborted with Esc, or the session has no run): it says `Nothing to continue:
  the last run finished.` (`... was stopped.` after Esc) and starts no run. Print mode writes that on stderr and exits
  0.
- While a run is active it is refused (`A run is in progress.`), not queued as a steering message.
- With arguments (`/continue now`) it is refused: `/continue takes no arguments.`

### 6. Roost (Q10)

Roost keeps DM-5 (a crashed worker restarts at most 3 times, after 1 s, 5 s and 15 s) and its other restarts, but
the prompt it gives the restarted worker is `/continue` instead of `Continue where you left off.`: the crash restart
(`main.ts` DM-5 timer), the restart of a worker that was working (`respawn`), and a resume of a failed row
(`lib/resume.ts`). The constant is kept in one place. A restart of a session that was never written still reuses the
original command, as now.

A row whose `/continue` finds nothing to continue ends as done (exit 0); the docs say so.

### 7. Graphs (Q11)

No graph change. Tests only:

- a model node's run killed during a tool call, then `/continue`: the turn continues in that node on its model
  (`graph/auto` routes by the branch, which recovery does not change);
- `next` called before the crash: the pending move is entered at the next run, as now;
- a command node's recovery (spec 03) and the core's recovery in the same next action: the core's entries come first,
  then the graph's `before_agent_start`.

## Docs (in the same PRs)

- `docs/session-format.md`: `xpi.run`, `xpi.interrupted`, interrupted tool results.
- `docs/rpc.md`: `get_state.interruptedRun`, `/continue` through `prompt`.
- The docs listing built-in commands, and the README where it lists them: `/continue`.
- `docs/extensions.md`: `tool_result` for an interrupted result.
- `docs/sdk.md` (or where `AgentSession` is described): `interruptedRun()`.
- `docs/subagent.md`: the agentId in an interrupted result; children end with the parent.
- `docs/graph.md`: a model node cut off by a crash.
- Roost's docs where DM-5 is described: `/continue`.
- `docs/porting.md`: the core's run markers and recovery, `/continue`, roost's restart prompt.

## Testing

- Core (fake provider, sessions built on disk):
  - markers: `start`/`end` around a completed run, an aborted run, a provider error, a run whose `_prepareRun` throws;
    a run with follow-ups and a retry has one pair;
  - `interruptedRun()` for each crash shape (assistant with no results, with some results in parallel order, tool
    results complete, user tail, custom tail, complete reply), after `/tree` to before the run, for a session without
    markers;
  - recovery at a prompt and at `/continue`: entries in order, the provider request has the interrupted results and
    the note, no tool is executed; a complete-reply crash writes only the marker; a crash during recovery (a branch
    with the note and no end) is repaired once more;
  - `/continue`: nothing to continue, after Esc, after an error (D1), during a run, with arguments; in print mode
    (`-p -c "/continue"`, stderr and exit code) and over RPC;
  - the notice in interactive and print mode; `get_state.interruptedRun`.
- Subagent: a parent killed while an Agent call runs (a test RPC child): the child exits; the interrupted result
  names the agentId, also for an agent started by a codemode script.
- Roost: the restart prompt is `/continue` in all three places.
- Graph: the three cases of section 7.
- By hand (recorded in `decisions.md`), Haiku 5.5 only, in a sandbox (`XPI_CODING_AGENT_DIR`, a copy of the auth with
  its expiry checked first): `kill -9` during a `sleep 30` in a script, reopen, `/continue`; `kill -9` while a reply
  streams, reopen, a message; `kill -9` during an Agent call; one roost worker killed and restarted.

## Milestones

1. **Core** (`issues/01-core.md`): sections 1–5, docs and tests, the by-hand runs without roost.
2. **Roost and graphs** (`issues/02-roost-graph.md`): sections 6–7, docs and tests, the by-hand roost run.

Each: a branch, a PR, green CI, an independent Opus review, then merged. No release, no npm.
