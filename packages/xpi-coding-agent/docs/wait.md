# Waits

A model that has to wait (for CI, a deploy, a time of day) can end its run with a wait instead of `sleep` or a
polling loop in bash. The wait is written into the session; when it ends, the model gets a note saying why, and a run
starts. Nothing is spent while it waits, and a crash or a closed laptop loses nothing: the wait is in the session file.

The built-in `wait` extension does this. Disable it with `-builtin:wait`. Subagents do not get it.

## The tool

From codemode:

```js
await tools.wait({ after: "20m", reason: "wait for the deploy" });
await tools.wait({ at: "14:20", reason: "the meeting ends" });
await tools.wait({ after: "1h", check: "gh pr checks 155", every: "2m", reason: "wait for CI" });
```

- `after` (a duration: `"90s"`, `"20m"`, `"2h"`, `"3d"`, `"1h30m"`) or `at` (`"HH:MM"`, the next such local time, or
  an ISO time; one without an offset is local time): exactly one. With a `check` it is the deadline. At most 7 days.
- `reason`: one line, shown in `/wait` and in the note.
- `check`: a shell command, run in the session's directory. Exit code 0 ends the wait. Each run of it is limited to 2
  minutes; one that times out counts as "not yet".
- `every`: how often the check runs, default `"2m"`, at least `"30s"`. Checks run at fixed steps from the time the wait
  was written.

Call it alone, as the last thing a script does: the script stops at the call and the run ends. Only a script of the
current request may wait; a background script's call is refused. A second call in the same run replaces the first.

The wait is written when the run ends (with the run's other end-of-run entries). A run stopped with Esc writes none,
and a run cut off by the end of the process writes none either: the model, told its call was interrupted, can wait
again. A message you send in the same run (a steer) drops the wait.

## What ends a wait

| What happens | The note says | A run starts |
|---|---|---|
| its time comes (no check) | its time came | yes |
| the check exits 0 | the check passed, with its output (last 50 lines) | yes |
| the deadline comes, the check never passed | the deadline came, with the last output | yes |
| you send a message | a user message came in (the note comes before your message); a wait with no check whose time has already come says its time came | your run |
| `/continue` | you woke it early (no check runs) | yes |
| `/wait cancel` | (nothing; a notice says it was cancelled) | no |
| a protection blocks the check | the check was blocked, and why | yes |
| the session has no bash tool | the check was blocked: no bash tool to run it | yes |

"A message" is anything that reaches the session as a prompt: typed, over RPC, or an extension's
`pi.sendUserMessage()`. The wait ends when the message arrives, even if another extension's `input` handler then
handles it without a run.

A run started by something else while the session waits (a background script's result, a subagent's report) does not
end the wait. A wake that comes due during such a run, or during a compaction, waits for it to end (it is tried again
every few seconds); it is never put into a run.

A wake found late (the session was closed, the laptop asleep) happens as soon as the session is open again, however
late; the note says when it was planned and when it woke. A wait with a check runs one check at once instead.

## The check and the protections

The check runs as the bash tool would run it, through the session's tool hooks (`ctx.runTool`): protect, a graph
node's `deny` and any extension's `tool_call` handler can refuse it. A refused check ends the wait as blocked. A check
makes no model request and writes nothing to the transcript; only the end of the wait is written.

## `/wait`

`/wait` shows the pending wait: until when, the check and its interval, the last check's output. `/wait cancel` ends it
without starting a run.

## Where it waits

- **An open session** (interactive, RPC) keeps a timer while it waits. Reopening a session with a pending wait shows a
  line (`Waiting until 14:20: ... (/wait cancel to stop, /continue to wake now).`) and arms the timer again; one that is
  due wakes at once.
- **Print mode** (`xpi -p`) ends at the wait: it prints the pending wait on stderr and exits 0. It does not stay up.
  Your next message to that session (`xpi -p -c "..."`) ends the wait, the note first: as its time came when it was
  due, else as a user message. `xpi -p -c /continue` wakes it as `/continue`.
- **Roost** (a background session) lets go of the worker process while the session waits (unless a terminal is
  attached, or the check runs more often than every 2 minutes), and the daemon starts it again when it is due: see
  [A session that waits](roost.md#a-session-that-waits). The wait extension says when it next looks at a wait on
  `pi.events` (`WAIT_EVENT`, `{ id, next }` and `{ id, ended: true }`); roost's worker reports it.

## Graphs

A model node may wait: its turn ending with a wait is not "ended without leaving" (no reminder, no halt), and when the
wait ends the node is still current, on its model. See [Graph](graph.md).

## The entries

See [Session File Format](session-format.md#waits): `xpi.wait`, `xpi.wake` and the `xpi.woke` note. A fork does not
take a pending wait with it: the copy gets a `cancel` wake.

## Implementation

`src/extensions/wait/` (the tool, the timer, the check, waking), `src/core/waits.ts` (the entries, the pending rule,
shared with forks), and two core hooks: `ctx.runTool()` and the `continue_request` event
([Extensions](extensions.md)). Tests: `test/suite/wait.test.ts`, and a graph case in `test/suite/graph-controls.test.ts`.
