# 09: Waiting for agents in codemode

Status: draft for the owner's approval (Grill 6 in `decisions.md`, 2026-11-12)

## Problem

A script that starts agents does not know how long they will take. Models guess and set
`// @options: {"timeout_ms": …}`. The deadline is wall time for the whole script, including the time spent waiting
for agents, and it still applies after the script moved to the background. When it passes, the pending calls are
aborted, which stops the agents. The work they did is lost from the script's result, and the call throws.

Claude Code has no such deadline. A background agent reports when it ends, and the lead never waits with a timer.
xpi already has half of that: a script that starts an agent moves to the background, and main gets a message when the
script ends. The missing half is that a deadline meant for the script also kills its agents.

## Facts this builds on

Paths are under `packages/` (`cm` = `xpi-codemode`, `ca` = `xpi-coding-agent/src`).

- **Parsing.** `timeout_ms` comes from `@options` (`cm/src/source.ts`).
- **The deadline.**
  - Host side, `ca/extensions/codemode/execute.ts`: `deadline = timeoutMs ?? Infinity`. The wait for a worker slot
    counts toward it.
  - In the runtime, `cm/src/runtime/execution.ts`: one `setTimeout` armed in the `Execution` constructor and cleared
    only in `finish()`. There is no pause.
- **At the deadline.**
  - `finish({ kind: "timeout" })` aborts every pending call's controller. That controller's signal is the tool's
    `callSignal`.
  - The result is `Script timed out: Execution timed out after N ms`, with `isError`.
  - Moving a script to the background (`ca/extensions/codemode/scripts.ts`) does not change the deadline.
- **An aborted `Agent` call.** The runner sends rpc `abort`, then SIGTERM and SIGKILL after a grace period
  (`subagent/runner.ts`). The exchange marks the agent `stopped` and the call throws (`subagent/exchange.ts`). The
  child's session stays on disk and can be resumed.
- **Detaching.**
  - Only `run_in_background: true` detaches, and only at call start. It runs the agent on its own `AbortController`
    stored by `registry.detach`, returns `status: "running"`, and sends main `agentEndMessage` when the agent ends
    (`subagent/agent-tool.ts`).
  - An agent that is already running cannot be detached.
- **The tools.** `Agent`, `SendMessage` (which continues an agent through `Agent`'s execute) and `Workflow`. All three
  have `exposure: "codemode"`.
- **Runner events.** The runner sees every child event (`message_update` deltas, `tool_execution_start`/`_end`,
  `turn_end`, `agent_settled`). The registry keeps `startedAt`, `turns` and `lastTool`. There is no last-activity time
  and no stall detection.
- **The descriptions.**
  - Codemode's description (`codemode/tool.ts`) shows `timeout_ms` in its `@options` example.
  - The `Agent` description has `BACKGROUND_RULES` / `DETACHED_RULES` / `PRINT_RULES` variants (`agent-tool.ts`).
- **The delegation eval.** `npm run eval:delegation` (`ca/../test/delegation/`) records wall time, per-model usage and
  cost, subagent count and pass. It does not count `timeout_ms`.

## Decisions (Grill 6)

1. The deadline counts only the script's own time; waiting for agents pauses it, in the background too.
2. A deadline that passes while agents run releases them instead of stopping them: they finish and report as detached
   agents do.
3. Stuck agents are found by lack of progress (`subagent.stallMs`, default 10 minutes), and main is told; nothing is
   stopped automatically.
4. A few lines in the codemode and `Agent` descriptions say not to set deadlines, sleep or poll for agents.
5. The delegation eval gets multi-agent long cases and counts `timeout_ms` and agents stopped by a deadline. It is run
   before and after with Haiku and Opus.
6. This spec is built before agent teams' PR 1, in two PRs.

## Solution

### The deadline counts the script's own time (decision 1)

- **Runtime API.** `xpi-codemode`'s sandbox takes an option `waitsForAgents?: (toolName: string) => boolean`.
- **When the clock stops.** The `Execution` timer stops while at least one tool call is pending and every pending call
  is one for which `waitsForAgents` returns true. It restarts with the remaining time as soon as that stops holding: a
  call for another tool starts, or the last agent call settles.
  - The script cannot run JavaScript while it awaits, so "only agent calls pending" means it is waiting for agents.
  - A script that awaits an agent and a slow `bash` together keeps its clock running, because the `bash` is its own
    work.
- **What counts.** The subagent extension answers true for `Agent`, `SendMessage` and `Workflow`. Without the
  extension nothing changes.
- **The worker wait.** Waiting for a worker slot still counts, as today.
- **Background.** The rule is the same in the foreground and the background.
- **Wording.** `Script timed out: …` says the time is the script's own time ("after N ms of script time, not counting
  M s waiting for agents").

### A deadline releases agents instead of stopping them (decision 2)

- **The decision is made at the deadline.** Every `Agent` call made from a script (also the continue inside
  `SendMessage`, and the agents of a `Workflow`) runs on its own `AbortController`, linked to the call's `callSignal`.
- **The runtime hook.** When the deadline passes, before aborting pending calls, the runtime calls a new hook
  `onDeadline?(pending: { id, toolName }[]): Set<id>`. The ids it returns are released: their call promise rejects
  inside the script with `released at the deadline`, but their `callSignal` is not aborted. The other calls are aborted
  as today.
- **Releasing agents.** For the agent calls, the subagent extension cuts the link between the call's signal and the
  agent's controller and calls `registry.detach` with that controller. From then on each agent is a detached agent:
  - it keeps running;
  - main gets `agentEndMessage` when it ends;
  - its panel row moves out from under the script row.
- **Workflows.** A released `Workflow` call releases its running agents the same way. The workflow's own script still
  ends.
- **The script's result.** The timeout result lists the released agents (`id`, type, description) with the note that
  each will report to main when it ends.
- **Other ways a script ends.** An abort (Esc on a foreground script, `x` on a script row, the session ending) still
  stops the agents. Only the deadline releases them.

### Stalled agents (decision 3)

- **Activity.** The runner records `lastActivityAt` on every child event (any rpc event) and keeps it in the registry
  record.
- **The check.** A 30 s timer in the parent process looks at running agents: foreground, script and detached.
- **The notice.**
  - An agent whose `lastActivityAt` is older than `subagent.stallMs` is marked stalled once. Main gets a message by
    the background end-message path (a steer that triggers a turn): `Agent <id> <type> (<description>) has shown no
    activity for <N> min (last: <lastTool or "thinking">). It is still running. Stop it from the panel (x), or with
    …, or keep waiting.`
  - The next activity clears the mark. A later stall is announced again.
  - The panel row shows `stalled <N>m`.
- **No automatic stop.** Nothing is stopped automatically. `maxTurns` still applies.
- **Silent tools.** A child tool that runs long without output (a quiet `bash`) can trigger the notice. The notice
  names `lastTool` so main can tell.
- **Setting.** `subagent.stallMs`, default 600000. `0` turns the check off. The settings schema and validation cover
  it.

### Descriptions (decision 4)

- **Codemode.** The `@options` line keeps `timeout_ms` and adds, only when the subagent extension is loaded: "it limits
  the script's own work; waiting for agents does not count".
- **`Agent`.** `BACKGROUND_RULES` and `DETACHED_RULES` get one line: "Agents report when they end: do not set
  `timeout_ms`, sleep or poll to wait for them; start independent agents together with `Promise.allSettled`."
  `PRINT_RULES` gets the part about `Promise.allSettled` only.
- **Cache.** The child's prompt does not change, so the subagent cache rules are unaffected. The by-hand suites run
  again because the main prompt changes.

### Measuring (decision 5)

- **New long cases.** `eval:delegation` gets two cases in `long-tasks.ts`, each needing three or more agents that work
  for minutes (for example, auditing several packages and fixing a seeded bug in each).
- **New metrics per row:**
  - `timeoutMsSet`: codemode calls whose source has `@options` with `timeout_ms`, read from the session file;
  - `agentsStoppedByDeadline`: agent calls that ended cancelled by a timeout before this change, or released after;
  - `released`.
- **Runs.** Before (main before the first PR) and after (the second PR's head), with Haiku and Opus, `--runs 3`, under
  the existing `EVAL_BUDGET`.
- **Report.** The numbers go in the second PR's description, as with earlier eval PRs. Results are not committed.

## Out of scope

- A per-call deadline for agents.
- Stopping stalled agents automatically.
- Changes to `run_in_background` or to script backgrounding.
- Esc and `x` semantics.
- Agent teams (spec `.scratch/agent-teams/01-agent-teams.md`), which reuse the stall check for teammates.

## Testing

- **Offline (fake model).**
  - The clock pauses while only agent calls are pending and runs while a non-agent call is pending alongside. A
    script awaiting a 3 s fake agent with `timeout_ms: 1000` completes.
  - The timeout message names script time and agent wait.
  - Deadline with agents pending:
    - the agents keep running and end with an end message to main;
    - the script's result lists them;
    - their panel rows move.
  - Esc, `x` and the session end still stop agents.
  - A released `Workflow` call.
  - Stall detection with a fake clock:
    - marked once, cleared by activity, announced again;
    - `stallMs: 0`;
    - foreground, script and detached agents.
  - Description text with and without the subagent extension, and in print mode.
  - Each new guard checked to fail when removed.
- **`xpi-codemode` unit tests** for `waitsForAgents` and `onDeadline`.
- **By hand (Haiku).** The subagent real suites (`test:subagent:real`, `test:subagent:parent`) run again.
- **Real check.** A main session on Haiku asked to run two agents that each take a few minutes. It is checked to set no
  `timeout_ms`, wait without polling, and get both results.

## PRs (after approval)

1. **The deadline and release.**
   - Code: `waitsForAgents` and `onDeadline` in `xpi-codemode`; the agent controller link and release in the subagent
     extension; the timeout wording; the descriptions.
   - Docs: `codemode.md` (`timeout_ms`), `subagent.md` (background work), and the porting menu's codemode and
     subagents entries (the two runtime hooks are host requirements).
2. **Stalls and the eval.**
   - Code: `lastActivityAt`, the check, the notice and panel state, `subagent.stallMs`; the eval cases and metrics with
     the before/after numbers.
   - Docs: `subagent.md`, `settings.md`.
