# 02: Workflows (saved, rerunnable orchestration scripts)

Status: draft, waiting for Grill 1 (decisions 4-8)

## Problem

A codemode script that orchestrates subagents already runs in the background, in parallel, and hands main a filtered
result. But it is written once by the model and thrown away. Claude Code's dynamic workflows add what is missing here:
the script can be saved and rerun with arguments as `/<name>`, it has small helpers for fan-out (`pipeline`,
`parallel`, `phase`, `log`, `args`), a failed agent in a batch does not sink the batch, and a run has size limits.

## Facts this builds on

- Background scripts: `codemode/scripts.ts` (`beginCodemodeScript`, move, stop, end events) and
  `subagent/background.ts` (rows in the panel, the end message to main). A script is tied to a codemode tool call id;
  its nested calls have ids `<call id>/<n>`.
- Commands: extensions register slash commands with `pi.registerCommand` (`/subagents` does).
- The codemode sandbox is QuickJS with `tools.*`, top-level `await` and `return`; no filesystem, shell or `import`.
- Not verified yet (ticket 1 pins them): whether a script can be started from a command without a model tool call (a
  synthetic call id through `executeCodemode`), and the exact signatures of Claude Code's helpers and its saved-file
  format.

## Solution

### Helpers, in every codemode script

Available whenever the subagent extension is on (so a script main wrote can be saved unchanged), built on `tools.Agent`:

| Helper | Meaning |
|---|---|
| `agent(prompt, opts?)` | One subagent. `opts`: `type` (subagent_type), `model`, `effort`, `schema`, `isolation`, `label` (description; default: the prompt's first words). Resolves to `structured` when `schema` is given, else `output`. Rejects when the agent failed. |
| `parallel(tasks)` | Runs an array of functions returning promises at once; resolves to their results in order, `null` for one that rejected. |
| `pipeline(items, fn)` | `fn(item, index)` for every item, at once (the `maxConcurrent` limit queues them); results in order, `null` for a failed one. |
| `phase(title, fn?)` | Names the agents started from here (or inside `fn`) for the panel. |
| `log(text)` | A progress line on the script's row and screen. |
| `args` | The run's input: what followed `/name`, or the `args` of a `Workflow` call. `undefined` in an ad hoc script. |

Names and semantics follow Claude Code's; where its documented signature differs from this table, Claude Code's wins
(ticket 1). `tools.Agent` stays as it is for scripts that want the full result.

### Saved workflows

- Files: `<name>.js` in `.pi/workflows/` (cwd up to the repo root, closest wins) and `~/.pi/agent/workflows/`. The file
  is the script body. A first-line comment `// description: ...` is shown in lists. `name`: `[a-z0-9][a-z0-9-]*`.
- Run by the user: `/name some text` starts it as a background script directly, with no model turn and no tokens for
  starting it. `args` is the text after the name (parsed as JSON when it is valid JSON, else the string). The end
  message goes to main like any background script's.
- Run by the model: a `Workflow({ name, args? })` tool (codemode exposure), which starts the same run and returns
  its script id at once. The tool description lists the saved workflows.
- Save: `s` on a script row in the panel asks for a name and where (project or user) and writes the script's source.
  Overwriting asks first. The model can also be asked to write the file; it is an ordinary file.
- List: `/workflows` shows saved workflows (name, description, source) and running or recent runs; Enter runs or opens.
- A workflow name that is also a command or prompt template is skipped with a warning; the existing command wins.
- Print mode: `xpi -p "/name args"` runs the workflow in the foreground and prints its return value.
- Project workflows run only in a trusted project, like project agents.

### Run limits

- At most 1000 agents per script run (ad hoc scripts too): the next `Agent` call throws. `subagent.maxAgentsPerScript`.
- Concurrency stays `subagent.maxConcurrent` (default 20).

### Panel

A script row shows its workflow name when it has one, its last `log` line, and its agents grouped under `phase`
titles.

## Out of scope for this spec (each a later one)

- Pause and resume of a run; restarting one agent of a run.
- Relaunching a stopped run with completed agents answered from saved results.
- Bundled workflows (`/deep-research`).
- Reading `.claude/workflows/` (after the file format is confirmed compatible).
- A size warning before large runs.

## Testing

- Offline (fake children): each helper including the `null` results; `args` from a command and from `Workflow`;
  discovery order, name rules, clash with a command; save from the panel (pty test) and overwrite prompt; the agent cap;
  print mode; untrusted project.
- Real, by hand (haiku): a saved workflow that fans out 3 Explore agents with a schema over a temp repo, run by `/name`
  and by the model through `Workflow`.
- Evals: main is asked for a task that fits a saved workflow and should call `Workflow` instead of writing a new script.

## Tickets (after approval)

1. Tracer and facts: start a script from a command without a model call; pin Claude Code's helper signatures and saved-file format; record both in Comments. One saved workflow runs by `/name`.
2. Helpers (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`) and the agent cap.
3. Discovery, `/workflows`, the `Workflow` tool, trust, print mode.
4. Save from the panel; panel grouping by phase, log line, workflow name.
5. Docs, evals, real run.
