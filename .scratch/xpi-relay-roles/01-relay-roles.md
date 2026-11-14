# Spec 01: relay roles, codemode-only hand tools, and a state machine

Status: approved by the owner on 2026-11-15 (Grills 1-3 in `decisions.md`, all as recommended).

## Problem

With `relay/auto` a model sometimes mixes up its role after a handover or a hand back and stops. Both models read a
system prompt that says "You are the lead"; both see both hand tools; a wrong-role call fails and the model ends its
turn. Relay's control flow is spread over `nextState()`, the tools' `execute`, `agent_before_settle` and three
commands, so the cases where two of them meet (a `/model` switch in a worker phase, `/handback` against a worker's
`handback`, two calls in one turn) have no single answer.

## Goal

Each model always knows its role from its own prompt; it can only reach its own hand tool, and only from codemode;
mistakes are repaired by hooks without spending a request where possible; and one transition table decides every
phase change.

Not in this spec: more than one worker, configurable graphs, changes to the hand-back record or to the lead's
decision facts (only where they are shown changes).

## Design

### 1. The transition table (decision 13)

New `extensions/relay/machine.ts`, a pure module:

```ts
type Phase = "lead" | "worker" | "verifying" | "paused";
interface RelayState { phase: Phase; round: number; mixups: number; stalls: number; pausedFrom?: "worker" }
type RelayEvent =
  | { type: "handover"; byUser: boolean }          // tool call, or /handover
  | { type: "handback"; status: "done" | "blocked"; byUser: boolean }
  | { type: "run_end"; afterRelayError: boolean }    // a worker run settles; whether it ended right after a relay tool error
  | { type: "acceptance"; passed: boolean; attempt: number }
  | { type: "model_away" } | { type: "model_back" }
  | { type: "wrong_role"; tool: "handover" | "handback" }
  | { type: "repeat"; tool: "handover" | "handback" };
function transition(state: RelayState, event: RelayEvent, config): { next: RelayState; effects: Effect[] };
```

`Effect`s are data (`write_marker`, `run_acceptance`, `compact_record`, `continue_with`, `reply`, `notify`), executed
by `index.ts`. Rows (every other pair is "no change, `reply` refusal" and has a test too):

| State | Event | Next | Effects |
|---|---|---|---|
| lead | handover | worker, round+1, mixups 0, stalls 0 | write handover marker; stop the script |
| worker | handback / run_end | verifying | — (acceptance runs at settle) |
| worker | handback byUser (`/handback`) | verifying, skip acceptance | steer the worker to report |
| verifying | acceptance passed, or status blocked, or skipped | lead | compact to the record; write hand-back marker |
| verifying | acceptance failed, attempt < maxRounds | worker | continue with the failure output |
| worker | wrong_role (handover) | worker, mixups+1 | reply correction; at mixups = 2: handback blocked "roles mixed up" |
| lead | wrong_role (handback) | lead, mixups+1 | reply correction (the lead has no automatic hand back: at 2 nothing more happens than the correction) |
| any | repeat | same | reply "already handed over/back" (not counted) |
| worker | run_end afterRelayError, stalls < 2 | worker, stalls+1 | continue with a role reminder |
| lead | run_end afterRelayError, stalls < 2 | lead, stalls+1 | continue with a role reminder |
| worker | model_away | paused (pausedFrom worker) | notify |
| paused | model_back | worker | notify `relay paused (worker phase, round N)` resumed |
| lead / verifying | model_away / model_back | same | — |

`verifying` is internal to one `agent_before_settle` call; it is never the stored state between requests (an abort
during acceptance leaves `worker`, as today).

### 2. Where the state lives (decisions 2, 12)

- The router state stays the virtual model's state on the session branch (fork and `/tree` follow it). The router
  (`route()`) reads phase changes from markers in the messages, as `nextState()` does today, but no longer from a tool
  result named `handover`: a successful `handover` (tool or `/handover`) persists a custom message with a handover
  marker, `<relay-handover round="N"/>`, delivered before the next request (`pi.sendMessage(..., { deliverAs:
  "steer" })` or the equivalent that lands in the transcript before the next request; the implementer verifies which).
  The record's `RECORD_MARKER` stays the hand-back signal.
- The marker message is the only thing inserted at a handover (decision 8): it carries the round and no role text.
- `mixups`, `stalls` and `pausedFrom` live in custom entries on the branch (like `relay.handover` today), read back
  with `readPhase`.
- Decision 12: the marker is written in the tool's `execute`, i.e. only when the tool result exists. An abort before
  that writes nothing.

### 3. Role prompts (decisions 1, 7, 8)

- A `context_with_system` handler, active only while `relay/auto` is selected, computes the role of the coming request
  with the same function the router uses, and sets one named section `relay` of the leading system message:
  - lead: one line (`You are the lead in relay mode; the worker is <model>. To give the work away call
    tools.handover({...}) from codemode.`), then the usage of `handover` (its parameters) and the decision facts that
    are `leadFacts()` today.
  - worker: one line (`You are the worker in relay mode: carry out the plan of the last handover in this
    conversation. When done or stuck, call tools.handback({...}) from codemode.`), then the duties now in
    `workerBrief()` (no `handover`, report contents, blocked, acceptance commands of the current handover).
- The section is the same text for every request of a role in a round (the worker's acceptance list changes only at a
  handover), so each model's cached prefix is stable. The `handover` tool no longer has `promptGuidelines` and both
  tools' descriptions are role-neutral.
- Later system messages in the transcript that mention relay tools (`toolsAdded`) are left as they are; the tools are
  codemode-only, so they are not in `toolsAdded` any more (only the fallback of 3 adds them).
- When `relay/auto` is not selected (paused, or never selected) the handler removes the `relay` section; the other
  model sees no relay text (decision 9).

### 4. Codemode-only tools (decisions 2, 3, 7, 10)

- Both tools: `exposure: "codemode"`, `effect: "write"`.
- **Core seam A (listing):** a tool definition can stay out of codemode's own tool listing while remaining callable
  (`codemodeListed: false`, or the implementer's equivalent in `getCodemodeCallableTools` / the listing code in
  `extensions/codemode/tool.ts`). Relay sets it, so each role learns only its own tool from its prompt (decision 7).
  `searchTools()` does not list them either.
- **Core seam B (nested terminate):** in `extensions/codemode/execute.ts`, a nested outcome whose result has
  `terminate: true` ends the script like `exit()` (later statements do not run; calls already started settle as
  today) and the codemode result gets `terminate: true`. A test with a stub tool. Docs in `codemode.md`.
- `handover` returns `terminate: true` too (decision 10): the lead's script and turn end; the worker answers the next
  request. Other calls of the same response finish, as the loop does today.
- Fallback (decision 3): when `codemode` is not an active tool, relay registers the two tools as `direct` (as today)
  and `/relay` says `codemode is off: the hand tools are direct tools`. The prompt section then says `call
  handover(...)` without `tools.`.

### 5. Repairs (decisions 4, 5, 6, 11)

- **Core seam C (direct call of a codemode-only tool):** in the agent loop, a call whose name is not a declared tool
  but is a codemode-callable tool of the session is run through the same pipeline as a nested call (validation,
  `tool_call`/`tool_result` hooks, permissions, `terminate`), and its result text gets a last line `(Call <name> from
  codemode next time: await tools.<name>(...).)`. Unknown names still fail "not found". The session gives the loop
  the codemode-callable tools; the implementer picks the seam (`AgentLoopConfig` option or `prepareToolCall` fallback)
  and documents it in `docs/extensions.md` and `codemode.md`. Tests in `agent-loop.test.ts` and a suite test.
- **Wrong role (decision 5):** the tools' `execute` asks the machine (`wrong_role`): the reply is one line
  (`You are the worker now: finish the plan, then call tools.handback(...)` or the lead's equivalent) returned as an
  error result; at the second mix-up in a worker phase the machine hands back `blocked` with the report `The worker
  mixed up its role twice; last message: <text>`.
- **Repeat (decision 11):** a second hand call in the same turn returns a plain result "already handed over/back",
  not an error. `/handback` sets the user flag; a worker `handback` in the same phase uses its own report and the flag
  skips the acceptance commands.
- **Stall (decision 6):** at `agent_before_settle`, when the run's last tool result was a relay tool error (wrong role)
  and the assistant then ended with no tool call, the machine's `run_end afterRelayError` continues the run with a
  role reminder (`continue: true` and a custom message), at most twice per phase; then the worker case hands back
  `blocked` and the lead case settles.

### 6. Model switch (decision 9)

`model_select` away from `relay/auto` in a worker phase writes a `paused` entry and notifies; selecting `relay/auto`
again writes `resumed` and the worker answers the next request. The tools are removed from and restored to the active
set as `syncTools` does today (only matters for the direct fallback).

## Tests

- `test/relay-machine.test.ts`: every (state, event) pair of the table, including the refusals.
- `test/suite/relay.test.ts` (faux provider), extended: handover and handback from a codemode script; a direct
  `handover(...)` call repaired by seam C; a worker's `tools.handover` gets the correction, the second hands back
  blocked; a stall after a wrong-role error is continued, then handed back; two `handover` calls in one script (the
  second never runs, because the first ends the script) and in two parallel codemode calls (the second answers
  "already"); `/model` away and back in a worker phase; `/handback` racing a worker `handback`; the lead's and the
  worker's requests carry their own `relay` section and the other role's tool is not in codemode's listing; codemode
  off falls back to direct tools.
- Codemode: nested `terminate` (seam B); unlisted tools (seam A).
- Agent loop: seam C.
- `npm run test:relay:real` (Haiku both roles) passes; the lead runs it by hand before merge, plus a session where
  Haiku is the lead, to see that neither role stops after a handover or a hand back.

## Docs

`docs/relay.md` (the tools are called from codemode, the role prompts, the table as a diagram, repairs, pause),
`docs/codemode.md` (nested terminate, unlisted tools, direct-call repair), `docs/extensions.md` (seams A and C),
`docs/porting.md` (relay row: the new host requirements), `docs/xin-pi.md`, both READMEs if they describe relay.
