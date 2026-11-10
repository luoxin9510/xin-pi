# 03: Agent names and `SendMessage`

Status: draft, waiting for Grill 1 (decisions 9-10)

## Problem

Main can continue a finished subagent only by its id (`resume`), and cannot reach a running one at all: only the user
can, by typing on the subagent's screen. `name` on an `Agent` call is ignored with a warning. Claude Code lets the
model name an agent and send it messages with `SendMessage`.

## Facts this builds on

- `exchange.ts`: one process per subagent; a second exchange queues behind the running one. `talk.ts` and the rpc
  `steer` command already deliver the user's text to a running child.
- `registry.ts` and the meta files hold each subagent's id, type, description and status per parent session.

## Solution

- `name` on an `Agent` call: `[A-Za-z0-9_-]{1,64}`. It is stored in the meta file and shown in the panel and on the
  screen header (`type(name)`, the description after it). A name already used by another subagent of this session
  throws, naming that agent's id. On a `resume` call `name` may be omitted or equal; a different one throws.
- `resume` accepts a name as well as an id.
- New codemode tool `SendMessage({ to, message, summary? })`, `to` an id or a name:

| The agent is | Effect | Returns |
|---|---|---|
| running | `message` is delivered as a steer; the agent takes it after its current step | at once: `{ status: "running", agentId, delivered: "steer" }` |
| completed, partial, failed or stopped | continued from its session with `message`, exactly like `Agent({ resume, prompt: message })`, including the background rules | the `Agent` result |
| unknown | throws, listing the session's agent names and ids | |

  `summary` is accepted and unused. A steer sent by main is not echoed back to main as a note (the note exists for what
  the user said).
- A steer cannot carry a `schema`; a continue through `SendMessage` has none either (use `Agent` with `resume` for that).
- Children get neither `Agent` nor `SendMessage`: nesting stays one level and agents do not message each other.
- In-memory parent sessions (`--no-session`): names work while the process lives; nothing can be resumed, as today.

## Out of scope

Agent-to-agent messages, teams, messages to other sessions, broadcast.

## Testing

- Offline (fake children): name validation, duplicate, resume by name, resume with another name; `SendMessage` to a
  running child arrives as a steer and returns at once; to a finished one continues it; unknown target; no note to main;
  panel and header text (pty test).
- Real, by hand (haiku): main starts a named background agent, steers it with `SendMessage`, then continues it by name.
- Evals: main is told to "ask the reviewer agent one more thing" and uses `SendMessage` with the name.

## Tickets (after approval)

1. `name`: validation, storage, panel and header, resume by name.
2. `SendMessage`: steer and continue paths, tool description, docs, eval case, real run.
