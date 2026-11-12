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
  aborts every pending call: a normal end, a throw, `exit()`, the deadline (one `setTimeout` armed at start), and an
  abort. The codemode description says "Calls still running when the script ends are cancelled".
- **An aborted `Agent` call.** The runner sends rpc `abort`, then SIGTERM and SIGKILL (`ca/extensions/subagent/
  runner.ts`). The exchange marks the agent `stopped`, and the call throws (`exchange.ts`). The session stays on disk.
- **Detaching today.**
  - Only `run_in_background: true`, and only at call start. The agent runs on its own `AbortController` stored by
    `registry.detach`. The call returns `status: "running"`.
  - When the agent ends, main gets `agentEndMessage`, sent as a steer that triggers a turn (`agent-tool.ts`).
- **Script backgrounding.**
  - A script moves to the background on its first awaited-style `Agent` call (`run_in_background` omitted), on
    `run_in_background: true` on the codemode call, or on ctrl+b. Main gets one end message when the script ends
    (`background.ts`, `scripts.ts`).
  - The deadline is unchanged by backgrounding.
- **Agents in a script.** `Agent`, `SendMessage` (which continues an agent through `Agent`'s execute) and `Workflow`
  all have `exposure: "codemode"`. Nested call ids carry the script's id as a prefix (`scripts.owner`).
- **Runner events.** The runner sees every child event. The registry has `startedAt`, `turns` and `lastTool`, but no
  last-activity time and no stall detection.
- **The panel.** It shows script rows with their agents, and detached agents, with state, elapsed time and the
  current tool (`panel.ts`).
- **The delegation eval.** `npm run eval:delegation` (`xpi-coding-agent/test/delegation/`) records wall time, usage
  and cost per model, subagents and pass. It counts neither wakes nor `timeout_ms`.

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

### Releasing agents when a script ends (decisions 1, 4)

- **Runtime hook.** `xpi-codemode`'s sandbox takes `release?(pending: { id, toolName }[], reason: "end" | "timeout" |
  "error" | "exit"): Set<id>`.
  - `finish()` calls it before aborting pending calls.
  - The calls whose ids it returns are not aborted. Their records get the status `released`, and their promises are
    dropped (the script has ended).
  - An abort (`reason` would be `"aborted"`: Esc on a foreground script, `x` on a script row, the session ending) does
    not call it, so everything stops as today.
- **What the subagent extension releases.** It answers with the pending `Agent` calls and the `Agent` calls inside
  pending `Workflow` and `SendMessage`-continue calls.
  - Each agent call from a script runs on its own `AbortController`, linked to its `callSignal` by a listener.
  - To release, the extension removes that listener and calls `registry.detach` with the agent's controller.
  - The agent keeps running as a detached agent. Its panel row moves from under the script row into the group's rows.
- **Pending `Workflow` calls.** A released `Workflow` call releases its running agents. The workflow script itself
  ends.
- **`SendMessage`.** A `SendMessage` steer to a running agent returns at once, so nothing is left pending to release.
- **The script's result.** It lists the released agents (`id`, type, description) and says they will report together
  when they all end.
- **The timeout result.** It says the same, after `Script timed out: …`.

### Groups and the single wake (decision 2)

- **Membership.** One group per codemode call. Its members are the agents the script released, plus the agents it
  started with `run_in_background: true`, unless a call says `wake: "each"`.
- **The wake.** When the last member ends, main gets one message, sent as a steer that triggers a turn (the path end
  messages use today):
  - a line per agent: id, type, description, state, cost, duration, and stalls if any;
  - each agent's output, cut to 2 KB with the rest in a file in the parent session's `subagents/<id>/` directory;
  - the total cost and time;
  - if the script was in the background, its own end message (return value, error) as the first part.
- **A background script.** It sends no separate end message while its group still runs, so main wakes once in all.
- **A foreground script.** Its result arrives in main's turn, as today, and the group wakes main once later.
- **Failures.** A failed or stopped member does not wake main early; it is reported in the group message. The user sees
  it in the panel at once.
- **`wake: "each"`.** A new optional `Agent` argument (`"group"` by default). With `"each"`, that agent's end sends its
  own message, as `run_in_background` agents do today. It is meant for a race, where the first result may let main
  stop the others.
- **The session ending.** Agents are stopped as today. No group message is sent.
- **Print mode** has no background: scripts wait for their agents, as today.

### Waiting without LLM turns (decision 3)

- **Progress.** The panel shows each group (`group of S3 · 2/4 done · 4m12s`) with its agents' rows: state, current
  tool, elapsed time, and `stalled Nm`.
- **A user message during the wait.**
  - When the user sends main a message while groups are running, the turn gets one extra line before the message:
    `[agents still running: <id> <type> "<description>" <elapsed>; …]`.
  - It is added as a custom message, so it does not change the system prompt or the cached prefix.
  - Main then knows not to start the same work again.
- **Stall detection.**
  - The runner records `lastActivityAt` on every child event.
  - A 30 s timer marks an agent stalled after `subagent.stallMs` without activity (default 600000; `0` turns the
    check off). The next activity clears the mark.
  - A stall is shown on the agent's row and notified to the user (`ctx.ui.notify`), not to main.
  - The group message names the agents that stalled and for how long.
  - A quiet child tool, such as a long `bash` with no output, can look stalled; the row shows `lastTool`.
  - Nothing is stopped automatically, and `maxTurns` still applies.

### Descriptions (decision 1)

- **Codemode.** The line "Calls still running when the script ends are cancelled" becomes, with the subagent extension
  loaded: "`Agent` calls still running when the script ends keep running and report to you together when they all
  end; other calls are cancelled."
- **`Agent`.** `BACKGROUND_RULES` gets one or two lines: "To delegate, start the agents (`tools.Agent(...)` without
  `await`) and end the script; they report together when all are done, so do not wait, sleep, poll, or set
  `timeout_ms` for them. `await` an agent only when this script must use its result."
- **`wake: "each"`.** It is described in one line.
- **Print mode.** `PRINT_RULES` is unchanged.
- **Cache.** The child's prompt does not change. The by-hand suites run again because main's prompt does.

### Measuring (decision 5)

- **New long cases.** `eval:delegation` gets two cases in `long-tasks.ts`, each needing three or more agents that work
  for minutes.
- **New metrics per row:**
  - `wakes`: main's turns started by agent or script messages;
  - `timeoutMsSet`: codemode calls whose source sets `timeout_ms`;
  - `agentsStoppedByDeadline`;
  - `released`.
- **Runs.** Before (main before the first PR) and after (the second PR's head), Haiku and Opus, `--runs 3`, within the
  existing `EVAL_BUDGET`.
- **Report.** The numbers go in the second PR's description. Results are not committed.

## Out of scope

- Pausing the deadline.
- A per-call deadline for agents.
- Stopping stalled agents automatically.
- Grouping teammates' notices (asked before agent teams' PR 1).
- Changes to Esc, `x`, or script backgrounding itself.

## Testing

- **Offline (fake model).**
  - Release:
    - a script that starts two agents without `await` and returns: the script ends, the agents run on, and main
      gets one group message;
    - the same with `throw` and `exit()`;
    - a deadline with agents pending;
    - an abort (Esc, `x`, session end) still stops them.
  - Groups:
    - `run_in_background: true` members;
    - `wake: "each"`;
    - a failed member;
    - a background script whose end message joins the group message;
    - a foreground script;
    - output cut to 2 KB with the file.
  - A released `Workflow` call.
  - The status line on a user message during the wait, and its absence when nothing runs.
  - Stall: marked, notified, cleared, `stallMs: 0`, and reported in the group message.
  - The descriptions with and without the subagent extension, and in print mode.
  - Each new guard checked to fail when removed.
- **`xpi-codemode` unit tests** for `release`, including that an abort skips it.
- **By hand (Haiku).** `test:subagent:real` and `test:subagent:parent` run again.
- **Real check.** A Haiku main session asked to have three agents each audit a package. It is checked to:
  - end the script without awaiting and set no `timeout_ms`;
  - stay idle;
  - wake once with all three results.

## PRs (after approval)

1. **Release and groups.**
   - Code: `release` in `xpi-codemode`; the agent controller link and release; groups, the single wake and
     `wake: "each"`; the panel group rows; the descriptions.
   - Docs: `codemode.md`, `subagent.md` (background work), and the porting menu's codemode and subagents entries (the
     `release` hook is a host requirement).
2. **Waiting and the eval.**
   - Code: the status line on a user message; stall detection and `subagent.stallMs`; the eval cases and metrics with
     the before/after numbers.
   - Docs: `subagent.md`, `settings.md`.
