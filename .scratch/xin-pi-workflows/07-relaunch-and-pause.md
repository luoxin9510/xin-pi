# 07: Relaunch with saved results, pause and resume

Status: done (2026-11-10, `issues/07-relaunch-and-pause.md`, PR #22); checked on real Haiku before merge. The owner asked for both features and ruled
`/deep-research` out.

## Problem

A workflow run that stops halfway is lost work. Twenty agents done, the twenty-first fails or the user stops the run,
and the only way on is to run everything again and pay for the first twenty twice. And a run that is going wrong, or
that should wait while something else is sorted out, can only be stopped, not held.

## Claude Code's behaviour (docs read verbatim on 2026-11-10, `code.claude.com/docs/en/workflows.md`)

Relaunch:

- "For a run you stopped, ask Claude to relaunch the workflow with the same script. If agents from the stopped run
  haven't exited yet, Claude Code refuses the relaunch until they have."
- "**Completed**: returns its saved result. The first agent whose prompt differs from the previous run, because you
  edited the script or an earlier agent returned something different, runs again, and so does every agent after it,
  even ones that completed."
- "**Still running when you stopped**: starts over."
- "**Failed**: runs again, and so does every agent the script starts after it, even ones that completed."
- "If a script starts A, B, C, and D in that order and B is **Failed**, relaunching returns A from cache and runs B,
  C, and D again."
- "Claude Code keeps the run's saved results under that session's directory". Without them: "the relaunch fails with a
  `nothing to resume` error".
- "Claude Code makes `Date.now()`, `Math.random()`, and a no-argument `new Date()` throw inside the script, so that a
  relaunched run repeats the same `agent()` calls."

Pause:

- "`p` | Pause or resume the run". "Resume a paused run from `/workflows` by selecting it and pressing `p`."
- What happens to agents that are running when a run is paused is not documented.
- Separately, a run that hits a usage limit pauses by itself and waits for the reset.

## Facts this builds on (xpi)

- Every `Agent` call of a script has the id `<script call id>/<n>`, with `n` counting calls in the order the script
  makes them. For the same script and the same earlier results that order is the same in every run (JavaScript is
  deterministic; `pipeline()` and `parallel()` start their tasks in list order).
- A script's run is known to the subagent extension from start to end (`background.ts`, `ScriptRecord`): its workflow
  name, its agents, how it ended.
- A subagent's result and its session are kept in the parent session's `subagents/` directory, so an agent of an
  earlier run can still be continued by id.
- Each child is its own process. Nothing can hold a model request that is under way; an agent can only be let finish,
  or stopped.

## Solution (proposed)

### Saved results

- Every run of a saved workflow writes a run file as it goes: `subagents/<session id>/runs/<run id>.json` with the
  workflow's name, its args, and one entry per `Agent` call in call order (what was asked, and the result once it has
  one). In-memory sessions keep it in memory, for the life of the process. Ad hoc scripts (not saved) are not
  recorded: save the script first (`s`).
- Run ids are `R1`, `R2`, ... per session, shown on the script row and in the end message:
  `Background script S3 (workflow audit, run R2) stopped.`

### Relaunch

- By the user: `/workflows`, select a run that ended stopped or failed, `Enter` relaunches it (same workflow file as
  it is now, same args). By the model: `Workflow({ name, relaunch: "R2" })`; the end message of a stopped or failed
  run says so.
- The relaunched run executes the script from the top. For each `Agent` call, in order:
  - If every call before it was answered from the saved run, and the saved run's call at this position asked the same
    thing (prompt, agent type, model, effort, schema, isolation) and completed, the call returns the saved result at
    once. No child starts, nothing is spent. The agent is the old one: its id and session are the old ones, so it can
    still be continued.
  - Otherwise this call runs, and so does every call after it. This covers Claude Code's cases: a failed agent, one
    still running when the run stopped, a prompt that changed because the script was edited or an earlier result
    differs.
- The relaunch is itself a run with its own run file (`R3`, "relaunch of R2"), so it can be relaunched in turn.
- Refused, with the reason: while agents of the run to relaunch are still running; a run that completed; a run id
  with no saved results ("nothing to resume").
- `Date.now()`, `Math.random()` and `new Date()` keep working. A script whose prompts depend on them simply reruns
  from the first prompt that differs; nothing breaks. The docs say so.
- Calls with `run_in_background: true` are never answered from saved results (their result is not part of the script's
  flow) and do not count as a difference.
- A rerun call that carries a `name` an agent of the relaunched run holds takes the name over (the old agent keeps
  its id and loses the name), so a relaunch never fails on "name already used".
- The panel's script row shows how many calls were answered from saved results: `12 from saved results`.

### Pause and resume

- `p` on a running script's row in the panel pauses it; `p` again resumes. `/workflows` lists paused runs and `p`
  works there too.
- Paused means: the script starts no new agent. Each `Agent` call it makes waits until the run is resumed. Agents
  already running finish their work, and their results are kept (and saved), but the script does not go on to start
  the next ones.
- The row shows `paused`. A paused run can be stopped (`x`). When the session ends, a paused run is stopped like any
  other, and can then be relaunched: finished agents come from saved results.
- Any script can be paused, saved workflow or not (pausing needs no saved results).

## Not in this spec

- **Pausing by itself on a usage limit.** It needs the provider's reset time and a timer that survives the session;
  worth its own spec once manual pause has been used.
- **Relaunching ad hoc scripts.** They have no name to relaunch by; saving one takes a keypress.
- **`/deep-research`** (ruled out by the owner on 2026-11-10) and the size warning.

## Testing

- Offline (fake children): the run file's contents; relaunch returns saved results without starting children, then
  runs from the first failed call, from the first changed prompt, and from a call that was running; a relaunch of a
  relaunch; the refusals; the name takeover; `run_in_background: true` calls; in-memory sessions; pause holds new
  Agent calls and lets running ones finish, resume releases them in order, stop while paused; the panel keys and the
  row text.
- Real, by hand (haiku): a workflow of four agents where the third fails the first time (a file it needs is missing);
  after the file is added, a relaunch answers one and two from saved results and runs three and four. A real run
  paused and resumed in a terminal (pty test).
- Docs in the same PR: `docs/subagent.md` (Workflows: runs, relaunch, pause; panel keys; `/workflows`),
  `docs/subagent-porting.md`, `docs/slash-commands.md` if `/workflows` changes.

## Tickets (after approval)

1. Run files: record each run of a saved workflow; run ids on the row and in the end message.
2. Relaunch: answering from saved results, `/workflows` and `Workflow({ relaunch })`, refusals, name takeover.
3. Pause and resume.
4. Docs, real run, pty test.
