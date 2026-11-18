# Checks after edits

After the model changes something, xpi can run your project's own check commands once and show the model the errors
that are new since the last check, before its next request. The model then fixes them in its next turn instead of
finding out later, or never. Off until you name commands.

Not part of it: a language server, a check per edit, fixing errors automatically, checks for turns that only read.

## Turning it on

Name the commands in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "checks": {
    "commands": ["npx tsc --noEmit", "npx biome check --reporter=github"],
    "timeoutMs": 60000,
    "maxErrors": 20
  }
}
```

| Setting | Default | Description |
|---|---|---|
| `checks.commands` | none | Shell commands run in the session's working directory, in order. None: the feature does nothing (no baseline, no process). |
| `checks.timeoutMs` | `60000` | Per command. A command that runs longer is killed and skipped for that check. |
| `checks.maxErrors` | `20` | Most errors listed in one message to the model. |

Settings are read at each check, so a change applies at the next one. A project's `.pi/settings.json` is loaded only
when the project is trusted, so a repository you did not trust cannot make xpi run its commands. A subagent inherits the
parent's trust decision. Turn the extension off with `-builtin:checks` in `extensions`.

## When it runs

- A turn counts when a tool that can change things ran in it: `edit`, `write`, `bash`, `codemode` (and the calls a
  script made), `Agent`, `Workflow`, and any tool that does not declare itself read-only. A turn that only read files
  runs nothing. A call another extension blocked did not run and does not count. A turn that starts a read-only
  subagent still counts, because the subagent may have changed files.
- The check runs at the end of the turn, once, and the next request waits for it. While it runs the status line shows
  `checks: running <command>…`.
- Nothing runs when the turn's tool results all ended the run (there is no next request for the message to reach), when
  the turn was aborted (Escape also kills a running check, without a message), or when the session ends.

## What counts as new

Before the first change of the session, xpi runs each command once in the background to take a baseline (the first
tool call that can change things waits for it, bounded by the sum of the timeouts). After each check, its result is the
new baseline, so an error the model does not fix is reported once, not every turn.

An error is identified by its command, file and message, not by its line: an edit above an old error moves it and does
not make it new. Two identical messages in one file where there was one count as one new error. Fixed errors are not
announced. A command with no baseline (it timed out, or the wait for it was cut short) reports nothing at its next
check; that result only becomes its baseline.

## Reading the output

Each output line (stdout and stderr) is matched against these formats, in order:

- `path(line,col): error TSnnnn: message` (tsc)
- `::error file=path,line=n,col=n::message` (GitHub annotations: `biome check --reporter=github` and others;
  `::warning` is ignored)
- `path:line: error: message` (mypy)
- `path:line:col: message` (ruff `--output-format=concise`, eslint `-f unix`, gcc-like tools)

Absolute paths inside the working directory are shown relative to it. If no line matched but the command exited
non-zero (or was killed by a signal xpi did not send, such as an out-of-memory kill), it counts as one error holding the last 20 lines of its output, identified by its exit code (or "signal"). In the `path:line:col` and mypy formats, a line whose message starts with `warning` or `note`, or contains eslint's `[Warning/`, is skipped; in the GitHub format only `::error` counts. Stdout and stderr are interleaved as they arrive. Output is capped
at 1 MiB per command, and a command is killed with its whole process group on timeout, on abort and at shutdown.

## What you and the model see

The model gets one message after the turn:

```text
Checks after this turn: 2 new errors.
src/a.ts:3:7 TS2322: Type 'string' is not assignable to type 'number'. (npx tsc --noEmit)
src/b.ts:9:1 TS2304: Cannot find name 'x'. (npx tsc --noEmit)
```

with `and N more` after `maxErrors` lines, and `<command>: timed out after 60 s (skipped)` for a timed-out
command. Nothing is sent when nothing is new and nothing timed out. In the TUI the message is one collapsed line,
`checks: 2 new errors`; expand it for the list. Steering and queued messages come after it.

## Subagents

The extension loads in subagents too, with the same settings, in the subagent's working directory (its worktree when
isolated). A subagent's baseline is its own. Two overlaps are accepted:

- a subagent that is not isolated changes the parent's tree, so the parent checks again after its `Agent` turn and may
  report errors the subagent already saw (they are new to the parent);
- an isolated worktree without dependencies (`node_modules`) makes a command fail with output nobody can parse; that is
  in its baseline, so it is reported only if its exit code changes.

## Development

Source: `src/extensions/checks/` (`runner.ts`, `parse.ts`, `render.ts`, `index.ts`). The runner is shared with
[graph](graph.md) command nodes; its `onOutput` option gets the output as it arrives (the graph's live view), past the
1 MiB the result keeps. Tests, run singly from
`packages/xpi-coding-agent`: `test/checks-runner.test.ts`, `test/checks-parse.test.ts`, `test/suite/checks.test.ts`
(fake runner, faux provider), `test/suite/checks-tsc.test.ts` (the repo's own `tsc` in a temp project). Porting:
[checks in the porting menu](porting.md#checks).
