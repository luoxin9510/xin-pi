# 09: Start agents and let the script end

Status: draft for the owner's approval (Grill 7 in `decisions.md`, 2026-11-12)

## Problem

- **Guessed deadlines.** A script that starts agents cannot know how long they will take, so models guess
  `// @options: {"timeout_ms": …}`. The deadline is wall time for the whole script, including the wait for agents.
  When it passes, the pending calls are aborted, which stops the agents, and their work is lost to the script.
- **One wake per agent.** The way around waiting today, `run_in_background: true`, wakes main once per agent: each end
  message triggers a turn. Five agents mean five LLM turns, each reading the whole context. Main may also act on the
  first result before the others arrive.
- **What the owner wants.** A script that only starts agents and ends. Main stays idle while the agents work and
  wakes once, when the work is done.

## Facts this builds on

Paths are under `packages/` (`cm` = `xpi-codemode`, `ca` = `xpi-coding-agent/src`).

- **Pending calls end with the script.** `cm/src/runtime/execution.ts` keeps pending tool calls in a map, each with
  an `AbortController` whose signal is the tool's `callSignal`. Every way a script ends goes through `finish()`, which
  aborts every pending call: a normal end, a throw, `exit()` (sent like a normal end), the deadline (one `setTimeout`,
  armed only when `timeout_ms` is set), a sandbox failure, and an abort. The codemode description says "Calls still running when the script ends are cancelled".
- **An aborted `Agent` call.** The runner sends rpc `abort`, then SIGTERM and SIGKILL (`ca/extensions/subagent/
  runner.ts`). The exchange marks the agent `stopped`, and the call throws (`exchange.ts`). The session stays on disk.
- **Detaching today.**
  - Only `run_in_background: true`, and only at call start. The agent runs on its own `AbortController` stored by
    `registry.detach`. The call returns `status: "running"`.
  - When the agent ends, main gets `agentEndMessage`, sent as a steer that triggers a turn (`agent-tool.ts`).
- **Script backgrounding.**
  - A script moves to the background on any `Agent` call with `run_in_background` omitted (awaited or not), on
    `run_in_background: true` on the codemode call, or on ctrl+b. Main gets one end message when the script ends
    (`background.ts`, `scripts.ts`).
  - The deadline is unchanged by backgrounding.
- **Agents in a script.** `Agent`, `SendMessage` (which continues an agent through `Agent`'s execute) and `Workflow`
  all have `exposure: "codemode"`. Nested call ids carry the codemode tool call id as a prefix; `scripts.owner` maps them to the script and returns
  nothing once the script has ended (`scripts.ts`). The `agent()` and `parallel()` helpers call a global
  (`__subagentAgent`), not the `Agent` tool (`script-helpers.ts`).
- **Runner events.** The runner sees every child event. The registry has `startedAt`, `turns` and `lastTool`, but no
  last-activity time and no stall detection.
- **The panel.** It shows script rows with their agents, and detached agents, with state, elapsed time and the
  current tool (`panel.ts`).
- **The delegation eval.** `npm run eval:delegation` (`xpi-coding-agent/test/delegation/`) runs `xpi -p` (print
  mode) and records wall time, usage and cost per model, subagents and pass. It counts neither wakes nor `timeout_ms`.

## Decisions (Grill 7)

1. An `Agent` call still running when its script ends is released, not cancelled: it runs on and reports to main.
   "Start and end" is the recommended pattern in the descriptions. A script awaits agents only when it must combine
   their results.
2. The agents a script leaves running form a group. Main wakes once, when the whole group has ended, with one combined
   message. `wake: "each"` on an `Agent` call opts out (a wake per agent, as today).
3. Waiting costs no LLM turns. Progress is in the panel. A user message to main during the wait carries a one-line
   status of the running agents. A stall (default 10 minutes without activity) is shown in the panel and notified to
   the user, does not wake main, and is reported in the group message.
4. A deadline that passes while agents run releases them into the group, as any script end does. The earlier idea of
   pausing the clock while waiting is dropped.
5. The delegation eval gets multi-agent long cases and counts main's wakes, `timeout_ms` use, agents stopped by a
   deadline, time and cost, before and after, with Haiku and Opus.
6. Codemode only. Whether teammates' notices are grouped the same way is asked before agent teams' PR 1 starts.

## Solution

### Where it applies

- **Where it is on.** Interactive sessions with the subagent extension's script tracking on: `ctx.hasUI` and
  `subagent.backgroundScripts` true. That is where scripts can run in the background today.
- **Where nothing changes.** In print mode, with `subagent.backgroundScripts: false`, and in codemode's host-controlled
  `start()` path: scripts wait for their agents as today, and ending a script cancels what is pending.
- **Workflows.** A `Workflow` call with a UI returns at once and runs as its own background script
  (`workflow-tool.ts`), so it follows these rules as a script of its own: its group is its own. There is no
  "released workflow call".

### The script outlives its last line until its agents end (decisions 1, 4)

The unit is the script, identified by its codemode tool call id. Individual call ids are not used, because a script
that starts agents and returns at once ends while those calls are still on their way through the host: before an
agent id, a controller or a registry record exists.

- **Sandbox option.** `xpi-codemode`'s sandbox takes `outlives?: (target: { kind: "tool" | "global"; name: string })
  => boolean`. When the script ends for any reason other than an abort, `finish()` does not abort the pending calls
  for which it returns true. Those reasons are a normal end, a throw, `exit()`, the deadline, and a sandbox failure.
  - Such a call's record gets the new status `released`. Its settlement is ignored, because the script has ended.
  - The worker slot is released as today.
  - An abort (Esc on a foreground script, `x` on a script row, the session ending) aborts everything, as today.
- **Which calls outlive the script.** The codemode host passes `outlives` from its add-ons: a new add-on field
  `outlives?(target)`. The subagent extension's add-on answers true for the tool `Agent` and for the global behind the
  `agent()` and `parallel()` helpers (`__subagentAgent`). It answers false for `SendMessage` (a steer returns at once;
  a continue is an `Agent` execute and is covered through it) and for `Workflow` (see above).
- **The script record stays.** `codemodeScripts` keeps the script's record after the sandbox ends, marked
  `ended: <reason>`, until its group ends. So `owner()`, `countScriptAgent` (`maxAgentsPerScript`), `agentStarting`,
  `addAgent` and the panel rows work for calls that reach `Agent`'s execute after the script's last line. An `Agent`
  execute whose script is marked ended runs as a group member.
- **Agents' controllers.** In a script, each agent runs on its own `AbortController`, which forwards the call's
  `callSignal` through a removable listener. When the script ends with outliving calls, the extension removes the
  forwarding listener of every member and registers the controller with `registry.detach`, so `x` on the row, stop-all
  and the session end still stop it.
- **Status names.** `released` is added to `CodemodeCallStatus` and `CodemodeNestedCallStatus`. The host stops
  turning `running` into `cancelled` for released calls (`execute.ts`). The renderer and `formatCallSummary` show it.

### Groups and the single wake (decision 2)

- **Membership.** A script's group is every `Agent` execute the script started, through `tools.Agent`, `agent()` or
  `parallel()`, by call, not by agent id. A member's status is the status of that call (its exchange). The same agent
  continued later from another script is a member of that other script's group, not this one.
  - `wake: "each"` calls are not members.
  - A script that started no agent has no group and ends as today.
- **When the group ends.** When the script has ended and every member's call promise has settled. Settled includes a
  call that failed before an agent started (an unknown `subagent_type`, a taken name, `maxAgentsPerScript`, a git
  failure). The check runs on each member's settlement and once when the script ends, so a member that settled before
  the script ended cannot leave the group waiting.
- **The group message.** When the group ends, main gets one message, sent by the existing delivery (a steer that
  triggers a turn):
  - **Script outcome.** The script's own outcome if it ran in the background: its return value or error, as the
    background end message has today. That message is deferred to here, and its state ("every agent failed" and so on)
    is computed now, not at the script's end.
  - **One line per member:** id, type, description, state, cost, duration, and stalls.
  - **Output** of every member that was still running when the script ended, cut as end messages are cut today
    (`capText`, 8000 bytes, with the rest in a file in `subagents/<session id>/`).
  - **Members that ended before the script did:** only their line, plus the error if they failed, since the script
    could read their results. An un-awaited call that failed is therefore always visible.
  - **Totals:** cost and time.
- **No group message.** A foreground script whose members all settled before it ended has no group message: its result
  carries them, as today.
- **Not early.** A failed or stopped member does not wake main early; the panel shows it at once.
- **`wake: "each"`.** A new optional `Agent` argument (`"group"` by default). With `"each"` the call is not a member,
  and its end sends its own message as `run_in_background` agents do today; it is meant for races. On an awaited call
  that ends inside the script, `wake` has no effect.
- **Other paths unchanged.** `/subtask` and agents started outside scripts keep one message per agent.
- **Cost.** At the group's end the released members' usage is added to the session's totals as one usage entry, so
  that cost after the script's end is not lost.
- **The session ending.** `/new`, resume, quit and reload stop members as today. No group message is sent.
- **Bookkeeping.** Released agents are removed from the registry's detached table when they end (`registry.forget`).

### Waiting without LLM turns (decision 3)

- **The panel.** It shows a running group as the script's row kept open (`S3 · ended · 2/4 agents done · 4m12s`) with
  its members' rows: state, current tool, elapsed, `stalled Nm`. `x` on that row stops the members.
- **A user message during the wait.**
  - The extension adds one line through `before_agent_start`, which places it after the user's message:
    `[agents still running: <id> <type> "<description>" <elapsed>; …]`.
  - It applies only to a user message that starts a turn (`messageType: "user"`), not to steers or follow-ups sent
    while main is running, and only when a group is running.
  - It is a custom message, so the cached prefix is unchanged.
- **Stalls.**
  - The runner records `lastActivityAt` on every child event. The clock starts when the child process starts, not
    while the agent waits for a concurrency slot or a stagger.
  - A 30 s timer marks an agent stalled after `subagent.stallMs` without activity (default 600000, `0` off). The next
    activity clears the mark.
  - A stall is shown on the row and notified to the user (`ctx.ui.notify`), never to main. The group message lists
    stalls.
  - A quiet child tool can look stalled; the row shows `lastTool`. Nothing stops automatically, and `maxTurns` still
    applies.
- **Status for clients.** The extension publishes running agents and groups with `ctx.ui.setStatus("subagents", …)`,
  which the TUI footer and rpc clients both receive.

### Descriptions (decision 1)

- **How the description changes.** Codemode's description is a static string today. Add-ons get a new field
  `descriptionLines?: string[]`, which codemode appends to the matching section.
- **What the subagent add-on contributes**, where it is on (see [Where it applies](#where-it-applies)):
  - for codemode, replacing "Calls still running when the script ends are cancelled": "`Agent` calls still running
    when the script ends keep running and report to you together when all have ended; other calls are cancelled";
  - in `BACKGROUND_RULES`: "To delegate, start the agents (`tools.Agent(...)` without `await`) and end the script; they
    report together when all are done, so do not wait, sleep, poll, or set `timeout_ms` for them. `await` an agent
    only when this script must use its result";
  - one line for `wake: "each"`.
- **Unchanged.** `PRINT_RULES`, and the child's prompt (so the subagent cache rules are unaffected). The by-hand suites
  run again because main's prompt changes.

### Measuring (decision 5)

- **No print mode.** `eval:delegation` runs `-p` today, where there is no background, so before and after would
  measure the same thing. The new cases run through a new rpc-mode driver in `test/delegation/`.
- **The rpc driver.**
  - It starts `xpi --mode rpc`, sends the prompt, answers no UI requests, and reads the `subagents` status.
  - A run ends when main is idle and the status shows no running agents or groups, within the 900 s cap.
- **New long cases.** Two cases in `long-tasks.ts`, each needing three or more agents that work for minutes. The
  existing cases keep the print driver.
- **Metrics, from the session file:**
  - `wakes`: turns that a delivered agent or script message started. A message delivered as a steer into a running
    turn is not a wake. It is told apart by the custom message's `triggerTurn` and the turn boundary.
  - `timeoutMsSet`: codemode call sources whose `@options` sets `timeout_ms`, parsed with `parseCodemodeSource`.
  - `agentsStoppedByDeadline` and `released`.
  - Time and cost as today.
- **Runs.** Before (main before PR 1) and after (PR 2's head), Haiku and Opus, `--runs 3`, within `EVAL_BUDGET`. The
  numbers go in PR 2's description, and results are not committed.

## Out of scope

- Pausing the deadline.
- A per-call deadline for agents.
- Stopping stalled agents automatically.
- Grouping teammates' notices (asked before agent teams' PR 1).
- Changes to Esc, `x`, or script backgrounding itself.

## Testing

- **Offline (fake model).**
  - **Start and end:**
    - a script that starts two agents without `await` and returns at once, before either call reaches `Agent`'s
      execute: both run, appear in the panel, count toward `maxAgentsPerScript`, and wake main once;
    - the same through `agent()` and `parallel()`;
    - the same after `throw`, `exit()`, a deadline, and a sandbox failure;
    - an abort (Esc, `x`, the session end) still stops them.
  - **Groups:**
    - a member that settles before the script ends;
    - an un-awaited member that fails to start (unknown type): it is in the group message and the group ends;
    - `wake: "each"`;
    - `run_in_background: true` members;
    - a background script whose end message joins the group message, with its state computed at the group's end;
    - a foreground script whose agents all settled (no group message);
    - output cut at 8000 bytes with the file;
    - usage added at the group's end;
    - a member continued later from another script;
    - stop-all during a group;
    - `/new` and resume during a group (no message).
  - **Where it is off:** `backgroundScripts: false`, print mode, `start()` (cancelled as today).
  - **Workflows:** a workflow's agents form its own group.
  - **Status line:** on a user message during a group; not on a steer; not when nothing runs.
  - **Stalls:** the clock starts at the child's start; marked, notified, cleared; `stallMs: 0`; in the group message.
  - **Descriptions** with and without the subagent extension, in print mode, and with `backgroundScripts: false`.
  - Each new guard checked to fail when removed.
- **`xpi-codemode` unit tests** for `outlives` on each end reason, abort excluded, and the `released` status.
- **By hand (Haiku).** `test:subagent:real` and `test:subagent:parent` run again.
- **Real check.** Through the rpc driver: a Haiku main session asked to have three agents each audit a package. It is
  checked to end the script without awaiting, set no `timeout_ms`, stay idle, and wake once with all three results.

## PRs (after approval)

1. **Release and groups.**
   - Code: `outlives` in `xpi-codemode` and the add-on fields; the kept script record; agents' controllers; groups,
     the single wake, `wake: "each"` and the usage entry; the panel; the descriptions.
   - Docs:
     - `codemode.md` and `packages/xpi-codemode/README.md` (calls that outlive the script, `released`);
     - `subagent.md` (background work);
     - the porting menu's codemode and subagents entries (`outlives`, the add-on fields and the kept script record
       are host requirements).
2. **Waiting and the eval.**
   - Code: the status line on a user message; stall detection and `subagent.stallMs`; the `subagents` status; the rpc
     eval driver, cases and metrics with the before/after numbers.
   - Docs: `subagent.md`, `settings.md`.
