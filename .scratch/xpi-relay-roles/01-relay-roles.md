# Spec 01: relay roles, codemode-only hand tools, and a state machine

Status: approved by the owner on 2026-11-15 (Grills 1-3 in `decisions.md`, all as recommended).

## Problem

With `relay/auto` a model sometimes mixes up its role after a handover or a hand back and stops. Both models read a
system prompt that says "You are the lead"; both see both hand tools; a wrong-role call fails and the model ends its
turn. Relay's control flow is spread over `nextState()`, the tools' `execute`, `agent_before_settle` and three
commands, so the cases where two of them meet (a `/model` switch in a worker phase, `/handback` against a worker's
`handback`, two calls in one turn) have no single answer.

## Purpose (owner, 2026-11-15)

Relay exists for transparency, observability and saving money. Orchestrating several agents belongs to workflows,
not to relay. Every choice below is checked against that: the user can see what happened, can look it up afterwards,
and the strong model's tokens go down, not up.

Both roles work in one session, so the lead's and the worker's work both stay on record. The session file is
append-only: the hand-back compaction only changes what the lead's later requests read; the worker's steps stay in
the session, in the scrollback and in `/tree`. Nothing in this spec moves work out of the session (no child process,
no second session), and every transition and repair is an entry in it (see 6).

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
type Phase = "lead" | "worker" | "paused";
interface RelayState { phase: Phase; round: number; mixups: number; stalls: number }
type RelayEvent =
  | { type: "handover"; byUser: boolean }                       // tool call, or /handover
  | { type: "handback"; status: "done" | "blocked"; byUser: boolean }
  | { type: "run_end"; afterRelayError: boolean }                // a run settles
  | { type: "acceptance"; passed: boolean; attempt: number }
  | { type: "model_away" } | { type: "model_back" }
  | { type: "wrong_role"; tool: "handover" | "handback" };
function transition(view: RelayView, event: RelayEvent, config): { next: RelayState; effects: Effect[] };
```

`RelayView` is the state the machine decides on (see 2): the stored router state plus a pending hand-off. `Effect`s
are data (`result`, `append_entry`, `run_acceptance`, `compact_record`, `continue_with`, `notify`), executed by
`index.ts`. Acceptance is a step inside one `agent_before_settle` call, not a stored phase (an abort during it leaves
`worker`, as today).

Rows. Where two rows match, the earlier one wins. Every other (state, event) pair is "no change, refusal result" and
has a test too.

| View | Event | Next | Effects |
|---|---|---|---|
| any with a pending hand-off | handover / handback | unchanged | result "already handed over/back" (not an error, not counted) |
| lead | handover | pending worker, round+1 | append `relay.handover`; result = the marker (2); `terminate` |
| worker | handback | pending hand back | append `relay.handback`; result "Handed back."; `terminate` |
| worker | wrong_role (handover), mixups = 0 | mixups 1 | append `relay.mixup`; error result with the correction |
| worker | wrong_role (handover), mixups = 1 | pending hand back, blocked | append `relay.mixup` and a `relay.handback` `blocked` "The worker mixed up its role twice"; `terminate` |
| lead | wrong_role (handback) | mixups+1 | append `relay.mixup`; error result with the correction (no automatic hand back for the lead) |
| worker | run_end afterRelayError, stalls < 2 | stalls+1 | append `relay.stall`; continue with a role reminder |
| worker | run_end afterRelayError, stalls = 2 | pending hand back, blocked | as a `blocked` hand back "The worker stopped after relay errors" |
| lead | run_end afterRelayError, stalls < 2 | stalls+1 | append `relay.stall`; continue with a role reminder |
| lead | run_end afterRelayError, stalls = 2 | unchanged | settle (the run ends; the user sees it) |
| worker | run_end (otherwise), or a pending hand back | — | acceptance, unless blocked or the user asked (`/handback`) |
| worker | acceptance failed, attempt < maxRounds | unchanged | continue with the failure output |
| worker | acceptance passed / failed at maxRounds / skipped | lead, mixups 0, stalls 0 | compact to the record (its summary starts with `RECORD_MARKER`) |
| worker | model_away | paused | append `relay.pause`; notify |
| paused | model_back | worker | append `relay.resume`; notify `relay resumed (worker phase, round N)` |
| lead | model_away / model_back | unchanged | — |

A handover resets `mixups` and `stalls` to 0 as well. A lead that stops after a relay error that is not a role
mix-up (an empty plan) is not continued: that is the lead's call.

### 2. Where the state lives (decisions 2, 12)

- **Stored state:** the virtual model's router state on the session branch (fork and `/tree` follow it). `route()`
  computes it from markers in the messages, as `nextState()` does today.
- **The marker is part of the tool result** (decision 12: it exists exactly when the result does). `handover`'s
  result text is the marker line `<relay-handover round="N"/>` and nothing else (no role text, decision 8). Seam B
  (4) appends the terminating nested call's result text as the last line of the codemode result, so the marker also
  ends a codemode result. `nextState()` accepts a handover when the **last line** of a tool result of `handover` or
  `codemode` is a handover marker whose round is the stored round + 1 (a file the worker reads that contains the
  string does not end a result with it). `/handover`, which starts a run itself, keeps sending its marker as a custom
  message, as today. The record's `RECORD_MARKER` stays the hand-back signal.
- **Pending hand-off:** the stored state changes only at the next `route()`, so within one response it is stale. The
  machine decides on a `RelayView`: the stored state, plus a pending handover or hand back when a `relay.handover` or
  `relay.handback` entry was appended after the latest router-state entry on the branch. So a second call in the same
  response, including a parallel codemode call, sees the pending hand-off and gets "already".
- `mixups`, `stalls`, pause and resume live in custom entries (`relay.mixup`, `relay.stall`, `relay.pause`,
  `relay.resume`), counted by `readPhase` since the latest handover or hand back.

### 3. Role prompts (decisions 1, 7, 8)

- A `context_with_system` handler sets one named section `relay` of the leading system message. It reads the role
  from the stored router state (`getVirtualModelState(branch)`): `route()` has already run for this request
  (`prepareRequest` runs before the context is built), so retries and the worker's first request match the router by
  construction.
  - lead: one line (`You are the lead in relay mode; the worker is <model>. To give the work away call
    tools.handover({...}) from codemode.`), then `handover`'s parameters and the decision facts that are `leadFacts()`
    today.
  - worker: one line (`You are the worker in relay mode. When done or stuck, call tools.handback({...}) from
    codemode.`), then the current handover read from its `relay.handover` entry (plan, criteria, findings, stopWhen,
    acceptance commands), then the duties now in `workerBrief()`. The plan lives here, not only in the lead's script,
    so an ordinary compaction cannot summarize it away.
- The section is the same text for every request of a role in a round, so each model's cached prefix is stable. The
  tools have no `promptGuidelines`; their descriptions are role-neutral. The `tell()` re-registration of `handover`
  at every session start and model select goes.
- When `relay/auto` is not selected the handler removes the `relay` section (decision 9).

### 4. Codemode-only tools (decisions 2, 3, 7, 9, 10)

- **Core seam A (unlisted tools):** `exposure: "deferred"` already means callable from scripts but not in codemode's
  listing. New: a definition flag (`listed: false`) that also keeps the tool out of `searchTools()`,
  `describeTool()` and `ALL_TOOLS`, while scripts can still call it by name. Relay's two tools are `deferred` and
  unlisted, so each role learns only its own tool from its prompt (decision 7).
- Deferred tools are callable whatever model is selected. Both tools refuse when `relay/auto` is not selected (as
  today), so another model neither sees nor uses them (decision 9).
- **Core seam B (nested terminate):** in `extensions/codemode/execute.ts`, a nested outcome whose result has
  `terminate: true` ends the script like `exit()` (later statements do not run; calls already started settle as
  today); the codemode result gets `terminate: true` and ends with the terminating call's result text. A test with a
  stub tool. Docs in `codemode.md`.
- `handover` and `handback` both return `terminate: true` (decision 10). Other calls of the same response finish, as
  the loop does today.
- **Fallback (decision 3):** with `codemode` not active, the two tools are registered `direct`. Exposure is fixed at
  registration, so relay checks at `session_start`, `model_select` and `before_agent_start` and re-registers only when
  codemode's state changed since the last registration. `/relay` says `codemode is off: the hand tools are direct
  tools`, and the prompt section says `call handover(...)` without `tools.`.

### 5. Repairs (decisions 4, 5, 6, 11)

- **Core seam C (direct call of a codemode-only tool):** in the agent loop, a call whose name is not a declared tool
  but is a codemode-callable tool of the session is run through the same pipeline (validation, `tool_call` /
  `tool_result` hooks, permissions, `terminate`), and its result text gets a last line `(Call <name> from codemode
  next time: await tools.<name>(...).)`. Unknown names still fail "not found". Hooks see it as a top-level call (no
  `parentToolCallId`); a `write` tool in a parallel batch keeps the loop's ordering rules. The implementer picks the
  seam (`AgentLoopConfig` option or a `prepareToolCall` fallback) and documents it in `docs/extensions.md` and
  `codemode.md`. Tests in `agent-loop.test.ts` and a suite test. For relay, the result of a repaired `handover` then
  ends with the marker line as a tool result of `handover`, which `nextState()` accepts.
- **Wrong role and repeat (decisions 5, 11):** per the table. The flag `afterRelayError` is not read from the
  transcript (inside codemode the error is a nested result): the `relay.mixup` entry carries it, and
  `agent_before_settle` asks whether one was appended in this run.
- **`/handback` (decision 11):** sets the user flag and steers the worker to report. A worker `handback` in the same
  phase uses its own report; the flag skips the acceptance commands.

### 6. Observability (purpose)

Nothing a hook repairs or decides is silent:

- Every transition the machine makes is written as one custom entry `relay.transition` on the branch
  (`{ from, to, event, round, at }`), and shown in the TUI as one dim line (`relay: lead → worker (round 2)`).
- Every repair is shown the same way and names what it did: `relay: direct handover(...) run through codemode`,
  `relay: worker called handover, corrected (1 of 2)`, `relay: worker stopped after an error, continued (1 of 2)`,
  `relay: roles mixed up twice, handed back as blocked`. In print mode they go to stderr only with `--verbose`.
- `/relay` shows, besides who has the work and the two models, this round's transitions and repairs and the
  session's per-model spend (the `spendFact()` numbers the lead already gets).
- The hand-back record gets one line per repair of the round, so the lead knows when the worker needed help.
- Repairs cost no lead tokens: a correction or a continuation goes to the model that erred.

### 7. Model switch (decision 9)

`model_select` away from `relay/auto` in a worker phase writes a `relay.pause` entry and notifies; selecting
`relay/auto` again writes `relay.resume` and the worker answers the next request. The tools are removed from and restored to the active
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
- Codemode: nested `terminate` (seam B), with the terminating result as the last line; unlisted tools (seam A),
  absent from `searchTools()`, `describeTool()` and `ALL_TOOLS` and still callable.
- Router: a handover marker is accepted only as the last line of a `handover` or `codemode` result with the next
  round; a `read` result containing the marker string changes nothing; a user steer queued during the handover does
  not delay the worker.
- Agent loop: seam C.
- Observability: each transition writes a `relay.transition` entry; each repair shows its line; `/relay` lists
  them; the record lists the round's repairs.
- `npm run test:relay:real` (Haiku both roles) passes; the lead runs it by hand before merge, plus a session where
  Haiku is the lead, to see that neither role stops after a handover or a hand back.

## Docs

`docs/relay.md` (the purpose, the tools are called from codemode, the role prompts, the table as a diagram, repairs
and how they are shown, `/relay`, pause),
`docs/codemode.md` (nested terminate, unlisted tools, direct-call repair), `docs/extensions.md` (seams A and C),
`docs/porting.md` (relay row: the new host requirements), `docs/xin-pi.md`, both READMEs if they describe relay.
