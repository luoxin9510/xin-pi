# 02: Workflows (saved, rerunnable orchestration scripts)

Status: ready-for-agent (owner approved Grill 1 on 2026-11-10; the two open facts were verified the same day, see Verified facts)

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

## Verified facts (2026-11-10)

### A script can be started from a command, with two small core changes

Prototype: `prototype-run-from-command.patch` (throwaway, on main 67c519ab4). A command `/wfproto <file>` ran a script
file through `executeCodemode` with a made-up call id, in print mode, in an empty agent dir with no login and no
model request. Result: the script started (`onStart S1`), was moved to the background (`onBackground`, early return
with `details.background: true`), ran three nested tool calls (two `bash`, one `read`, two of them in parallel) and
ended in the background with their real outputs in its return value.

What stands in the way today, and what the prototype did about it:

1. `executeCodemode` needs an `ExtensionToolContext` (`tools`, `executeTool`, `detachNestedCalls`). Only
   `ExtensionRunner.createToolContext(toolCallId, signal)` makes one, and a command handler cannot reach it. The
   prototype exposed it on the command context. To build: a typed `createToolContext(id, signal?)` on
   `ExtensionCommandContext`.
2. A nested call needs the assistant message that issued it: with none in the session (a fresh session, the usual
   case for `/name` as the first input) every nested call returns the error `No assistant message issued this call`
   (`agent-session.ts`, `_getNestedToolCalls`, measured without the change). The prototype passed an empty assistant
   message. To build: when a scope was created by a command, its origin is an empty assistant message made for it.
3. The scope must be detached before the first nested call (`ctx.detachNestedCalls()`): an undetached scope is
   dropped at the next `agent_end`. `releaseNestedCalls()` at the end then writes the scope's usage to the session
   (`appendUsage("nested_tool_calls", ...)`), so the cost of a workflow's agents is counted.

Also seen: the sandbox has no `setTimeout`; print mode reads stdin unless it is closed.

### Claude Code's script API, as far as its docs state it

Read from `code.claude.com/docs/en/workflows.md`. The page has one full script:

```js
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}

const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})

const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)

return audits.filter(Boolean)
```

- Saved file: `.js`; `export const meta = { name, description }` must be the first statement and a plain literal; an
  optional `phases` list in `meta` must match the `phase()` titles. Locations `.claude/workflows/`, `~/.claude/workflows/`.
- `agent(prompt, opts)`: documented `opts` keys are `schema`, `label` and `stallMs`. With `schema` it returns the JSON
  value. A schema failure after 5 attempts fails the call. Awaited directly, a failed agent ends the run with the error;
  inside `pipeline()` or `parallel()` it is `null`.
- `pipeline(items, fn)`: results in item order, `null` for failed items (the example filters them out).
- The script ends with a top-level `return`. `import()` fails before the run. `Date.now()`, `Math.random()` and
  `new Date()` without arguments throw. No filesystem or shell from the script.
- `args`: a global, `undefined` when nothing was passed; the model passes structured data.
- Not documented on the page: the arguments of `parallel()`, `phase()` and `log()`, other `opts` keys (model, agent
  type), and how text after `/name` becomes `args`. The full reference is a skill bundled with Claude Code
  (`/workflow-authoring`), which has no public URL. Where the page is silent, this spec decides.

## Solution

### Helpers, in every codemode script

Available whenever the subagent extension is on (so a script main wrote can be saved unchanged), built on `tools.Agent`:

| Helper | Meaning |
|---|---|
| `agent(prompt, opts?)` | One subagent. `opts`: `schema`, `label` (description; default: the prompt's first words), as in Claude Code; xpi's own: `type` (subagent_type), `model`, `effort`, `isolation`. `stallMs` is accepted and unused. Resolves to the value when `schema` is given, else to the output text. Rejects when the agent failed. |
| `parallel(tasks)` | An array of functions returning promises, or of promises; all run at once; resolves to their results in order, `null` for one that rejected. |
| `pipeline(items, fn)` | `fn(item, index)` for every item, at once (the `maxConcurrent` limit queues them); results in order, `null` for a failed one. At most 4096 items. |
| `phase(title, fn?)` | Names the agents started from here (or inside `fn`) for the panel. |
| `log(text)` | A progress line on the script's row and screen. |
| `args` | The run's input: what followed `/name`, or the `args` of a `Workflow` call. `undefined` in an ad hoc script. |

The documented part of Claude Code's API (see Verified facts) is matched exactly, so its documented example runs
unchanged. `tools.Agent` stays as it is for scripts that want the full result. Not copied: `Date.now()`,
`Math.random()` and `new Date()` keep working here (Claude Code makes them throw so a relaunch can replay a run; this
spec has no replay).

### Saved workflows

- Files: `<name>.js` in `.pi/workflows/` (cwd up to the repo root, closest wins) and `~/.pi/agent/workflows/`. Claude
  Code's format: the first statement is `export const meta = { name, description, phases? }`, a plain literal, and the
  rest is the script body. The loader reads `meta` without running the file and removes that statement before the
  script goes to the sandbox (a codemode script is a function body, where `export` is a syntax error). `meta.name` must
  equal the file name; names are `[a-z0-9][a-z0-9-]*`. A file with a missing or malformed `meta`, or with `import`,
  is skipped with a warning.
- Run by the user: `/name some text` starts it as a background script directly, with no model turn and no tokens for
  starting it (Verified facts). `args` is the text after the name (parsed as JSON when it is valid JSON, else the
  string; `undefined` when empty). The end message goes to main like any background script's.
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
- Reading `.claude/workflows/`: the file format is the same, but the undocumented parts of Claude Code's API
  (`parallel`, `phase`, `log`, other `opts`) may differ from this spec's; revisit once its reference is known.
- A size warning before large runs.

## Testing

- Offline (fake children): each helper including the `null` results; `args` from a command and from `Workflow`;
  discovery order, name rules, clash with a command; save from the panel (pty test) and overwrite prompt; the agent cap;
  print mode; untrusted project.
- Real, by hand (haiku): a saved workflow that fans out 3 Explore agents with a schema over a temp repo, run by `/name`
  and by the model through `Workflow`.
- Evals: main is asked for a task that fits a saved workflow and should call `Workflow` instead of writing a new script.

## Tickets (after approval)

1. Tracer: the two core changes from Verified facts (typed `createToolContext` on the command context; an empty assistant message as the origin of a command-started scope), with tests; one saved workflow (with `meta`) runs by `/name` and its end message reaches main.
2. Helpers (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`) and the agent cap.
3. Discovery, `/workflows`, the `Workflow` tool, trust, print mode.
4. Save from the panel; panel grouping by phase, log line, workflow name.
5. Docs, evals, real run.
