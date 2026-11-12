# Subagents

The `subagent` built-in extension of xpi gives codemode scripts a Claude Code-compatible `Agent` tool. Each call runs
an agent definition in its own `xpi` subprocess and returns a structured result, so a script can run agents in parallel
and filter what reaches the model. Next to it: `SendMessage` to steer or continue an agent
([Names and SendMessage](#names-and-sendmessage)), a [fork](#fork) that starts with the whole conversation, and saved, rerunnable
scripts with fan-out helpers, run as `/name` or through the `Workflow` tool ([Workflows](#workflows)). In interactive xpi you can watch the subagents in a panel below the editor, open one in
a full-screen view, and talk to it (see [Watching and talking](#watching-and-talking-to-subagents)).

It started as the separate extension pi-pipipi and was merged into xin-pi; see [xin-pi.md](../../../docs/xin-pi.md) for
the files that changed in the core, and [subagent-porting.md](subagent-porting.md) for the contracts it relies on.

```js
// inside a codemode script
const [a, b] = await Promise.all([
  tools.Agent({ description: "find auth code", prompt: "Where is login handled? medium", subagent_type: "Explore" }),
  tools.Agent({ description: "find session store", prompt: "Where are sessions stored? quick", subagent_type: "Explore" }),
]);
return [a.output, b.output].join("\n---\n");
```

## Contents

- Setting up: [Enabling](#enabling), [Agent definitions](#agent-definitions), [Model selection](#model-selection)
- Calling agents: [The Agent tool](#the-agent-tool), [Background work](#background-work) (agents that outlive their
  script, waiting for agents), [Structured output](#structured-output), [Names and SendMessage](#names-and-sendmessage), [Agent teams](#agent-teams) (experimental), [Fork](#fork)
- Per-agent options: [Worktree isolation](#worktree-isolation), [Agent memory](#agent-memory), [MCP](#mcp),
  [Permission mode plan](#permission-mode-plan), [Extensions as hooks](#extensions-as-hooks),
  [Codemode-only children](#codemode-only-children)
- Scripts: [Workflows](#workflows) (saved workflows, runs and relaunch, pause and resume)
- Interactive xpi: [Watching and talking to subagents](#watching-and-talking-to-subagents) (the panel, the subagent screen,
  the script screen)
- Reference: [Config](#config), [Cost, caching and limits](#cost-caching-and-limits), [Development](#development),
  [Porting to another pi-based agent](#porting-to-another-pi-based-agent)

## Enabling

The extension is built in (source: `src/extensions/subagent/`) and on by default; `-builtin:subagent` turns it off. The
tool has `codemode` exposure: the model reaches it only through the `codemode` tool, which is a default tool
(unless `--tools` or `defaultTools` removes it).

## Agent definitions

Existing Claude Code agent files work unchanged. Sources, highest priority first (the directories are scanned
recursively for `*.md`):

1. `--agents` on the command line (see [Agents on the command line](#agents-on-the-command-line))
2. `.pi/agents/` (cwd up to the repo root, closest wins)
3. `.claude/agents/` (same walk)
4. `~/.pi/agent/agents/`
5. `~/.claude/agents/`
6. Built-in: `Explore`, `Plan`, `general-purpose`, `reviewer`

`reviewer` is a read-only code reviewer (tools `Read`, `Grep`, `Glob`, `LS`, `Bash`; no `Write` or `Edit`; model
`sonnet`). It looks for bugs a change introduced that the author would want fixed before merge: each finding needs a
provable impact, must be actionable and must come from the change itself. It traces new values to where they are used,
also outside the diff, ignores style, naming and docs, and uses `Bash` only for read-only `git diff`, `git show`,
`git log`, `git blame` and `gh pr diff`. The built-in [`/review`](#built-in-workflows) workflow runs it; you can also call
it with `subagent_type: "reviewer"`. An agent file named `reviewer` in a source above hides it.

The project walk never includes your home directory (`~/.pi/agent/agents` and `~/.claude/agents` are user sources only).
Scans skip dot directories and `node_modules`, go at most 6 levels deep and read at most 5000 entries per source.

Definitions are re-read on every call, so edits apply at once. The agent list in the tool's description is built at
session start: a new agent can be called right away but shows up in the description only after `/reload`.
Invalid files are skipped with a warning: a notification in the TUI, a line on stderr in print mode, and the reason in
the error of an `Agent` call for that agent. A top-level value on one line that holds `: ` without quotes (`description: Use when: ...`)
is not valid YAML; like Claude Code, xpi reads the rest of the line (a `#` included) as one string instead of skipping
the file. A value like that
continued on indented lines is still invalid: quote it or use a `|` block.

| Field | Handling |
|---|---|
| `name`, `description`, body | Same as Claude Code. The body replaces pi's default system prompt: the child gets a one-line preamble, the project context, then the body in an `<instructions>` section at the end. |
| `tools`, `disallowedTools` | Without `tools` the agent gets your normal pi tools (`defaultTools`) and every installed extension. Otherwise mapped to `--tools` / `--exclude-tools`. `Read→read`, `Write→write`, `Edit→edit`, `Bash→bash`, `Grep→grep`, `Glob→find`, `LS→ls`, `mcp__*` unchanged. A `tools` list without `mcp__` entries also excludes all MCP tools. A `Bash(...)` deny rule removes the whole tool. Tools with no pi equivalent are dropped with a warning. |
| `codemode` | `false` keeps this agent on direct tools. Default: children see only the `codemode` tool and call their allowed tools from scripts. See [Codemode-only children](#codemode-only-children). |
| `model` | See [Model selection](#model-selection). |
| `effort` | `--thinking` |
| `maxTurns` | The child is stopped after that many turns; the result is `partial`. |
| `skills` | Full `SKILL.md` text preloaded into the system prompt. Searched (recursively) in `.pi/skills`, `.agents/skills`, `.claude/skills` from cwd up to the repo root, then `~/.pi/agent/skills`, `~/.agents/skills`, `~/.claude/skills`. Skill paths from settings or pi packages are not searched. |
| `omitClaudeMd` | `--no-context-files` |
| `color` | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink` or `cyan` tints the agent's label in the panel and on its screen header (fixed 256-colour escapes; the status icon and text keep their status colours). Any other value warns once and is ignored. |
| `isolation` | `worktree` runs every call of this agent in its own git worktree; the call's `isolation` wins. See [Worktree isolation](#worktree-isolation). |
| `memory` | `user`, `project` or `local` gives the agent a persistent directory. See [Agent memory](#agent-memory). |
| `mcpServers` | MCP servers for this agent: names of servers configured in `mcp.json`, inline definitions (a mapping with the server name as key, in `mcp.json`'s shape), or a list mixing both. The agent gets those servers' tools and no other server's; `[]` means no MCP. An unknown name warns in the result. See [MCP](#mcp). |
| `background` | `true`: a call for this agent without `run_in_background` returns at once with `status: "running"`, and the result arrives as a message. The call's own `run_in_background` wins; print mode waits. |
| `permissionMode` | `plan` makes the agent read-only; see [Permission mode plan](#permission-mode-plan). Claude Code's other values (`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`) are accepted and change nothing: xpi never asks for permission, so they run as `bypassPermissions` (one warning at discovery). Any other value skips the file. |
| `extensions` | xpi's own field: extensions loaded only into this agent's child, a list or a comma-separated string. This is how an agent gets hooks. See [Extensions as hooks](#extensions-as-hooks). |
| `autoCompactWindow`, `hooks`, `initialPrompt`, `experimental` | Accepted, no effect; the warning says why (xpi compacts by reserve tokens, Claude Code's hook commands do not run in xpi (use `extensions`), and xpi has no agent-as-main-session for `initialPrompt`). |

### An agent file or a skill

Write an agent file when the work should run in its own context: a separate model, a narrower tool list, parallel
copies, or output too large to read in the main session. When the main agent only needs to know how to do something
(a procedure, a checklist, a house style), write a [skill](skills.md) instead: it costs no second process, no second
prompt and no hand-over of context, and the main agent keeps everything it has already read.

### Agents on the command line

`xpi --agents '<json>'` defines agents for one run, in Claude Code's shape: an object whose keys are agent names and
whose values are definitions, with `prompt` as the system prompt and the other keys as the fields above. The value may
also be the path of a JSON file.

```bash
xpi --agents '{"reviewer": {"description": "Reviews a diff", "prompt": "You review code.", "tools": "Read, Grep", "model": "sonnet"}}'
```

They rank above every agent file, so one named like a file agent or a built-in replaces it for the run. A value that
is not such an object stops the start with the reason; an entry that is not a valid agent is skipped with a warning.

## Model selection

**Subagents run on Claude Haiku 5.5 by default, not on your session's model.** The model is picked in this order:

1. `model` in the `Agent` call
2. `model` in the agent definition
3. `subagent.defaultModel` in settings, default `"haiku"`

The built-in agents `Explore`, `Plan` and `general-purpose` set no model, so they run on haiku too; `reviewer` sets
`sonnet` (remap that alias in `subagent.models` to run it on another model).

Values:

| Value | Model |
|---|---|
| `haiku` (default) | `anthropic/claude-haiku-5-5` |
| `sonnet` | `anthropic/claude-sonnet-5-5` |
| `opus` | `anthropic/claude-opus-5-5` |
| `fable` | `anthropic/claude-fable-5-2` |
| `inherit` | the parent session's current model. Only used when written explicitly. |
| anything else | passed to `pi --model` as is (`provider/id` or a pattern pi resolves) |

To follow your session's model everywhere, set `"defaultModel": "inherit"`. To use another provider for an alias,
remap it in `subagent.models`; the other aliases keep their defaults.

Alias lookup order: `subagent.models`, then the shared top-level `models` setting (also used by `ctx.complete`, see
[Settings](settings.md#model-and-thinking)), then the built-in aliases above. A name in none of them is passed on as is.
So an alias you define once in `models` works for subagents and extensions, and a `subagent.models` entry overrides it
for subagents only.

Without Anthropic credentials, haiku (and so every agent by default) fails with a provider error in `error`. Set
`defaultModel` to `inherit` or remap the aliases you use, for example:

```jsonc
"subagent": { "models": { "haiku": "<provider>/<cheap-model-id>", "sonnet": "<provider>/<model-id>" } }
```

## The Agent tool

Input (compatible with Claude Code's Agent tool): `{ description, prompt, subagent_type?, model?, effort?, resume?, run_in_background?, isolation?, schema?, name?, wake? }`.
`subagent_type` defaults to `general-purpose`. `isolation` is `"worktree"` or omitted (see [Worktree isolation](#worktree-isolation)); `schema` makes the
result a value (see [Structured output](#structured-output));
`name` names the agent (see [Names and SendMessage](#names-and-sendmessage)). Children run as `xpi --mode rpc` and get the prompt as a protocol message on stdin, not as a command
line argument, so prompts of any size work.

`run_in_background`: omitted, the first `Agent` call moves its codemode script to the background; `false` keeps the script in the foreground; `true` returns `status: "running"` at once and main gets a message when the agent ends (output cut at 8 KB), without moving the script. See [Background work](#background-work).

`wake`: `"group"` (default) or `"each"`, for an agent still running when its script ends. See [Agents that outlive their script](#agents-that-outlive-their-script).

Result:

```ts
{
  status: "completed" | "partial" | "failed" | "running"; // running: only with run_in_background: true
  agentId: string;      // pass as `resume` to continue this agent's session
  agentType: string;
  output: string;       // the agent's last message; with `schema`, the JSON text of `structured`
  structured?: unknown; // with `schema`: the agent's result, matching the schema
  model: string;
  usage: Usage;         // added to the session cost
  turns: number;
  durationMs: number;
  warnings: string[];
  error?: string;       // when failed
  worktree?: { changed: boolean; path?: string; branch?: string; files?: string[]; commits?: string[]; note?: string }; // isolation: "worktree" only
}
```

A child that fails returns `status: "failed"` instead of throwing, so scripts keep the structured result. Bad input
(unknown agent, no usable tools, unknown `resume` id) throws. A model value that is not a known alias is passed to
`--model` unchanged, and the child fails with pi's own error.

Children run with `XPI_SUBAGENT_DEPTH=1` and get no `Agent` tool: nesting is one level. Child sessions are stored next to
the parent session under `subagents/<parent session id>/`, with a small meta file per child (type, description, model,
status, turns, usage, times). With an in-memory parent session (`xpi --no-session`), children are in memory too: they
cannot be resumed, and the subagent screen cannot show them: the panel shows a one-line notice instead of rows and
`/subagents` says so. The
`Agent` tool itself works as before. A resume without `subagent_type` reuses the agent type of the first run; a different
`subagent_type` is an error. Children inherit the parent's project trust.

## Background work

Delegating does not block main. When a codemode script starts an `Agent`, the whole script moves to the background:
the `codemode` call returns to main at once ("Script moved to the background (id S1) ..."), main's turn can end, and
you can keep talking to main. The script keeps running and keeps orchestrating (`await tools.Agent(...)` still returns
the full result, so it can filter and combine). When it ends, main gets a message with the script's return value, its
error if it threw, and the agents it ran (id, type, status, cost). The message is always sent as a steer that
triggers a turn: if main is running it arrives as a steer, otherwise (idle, or compacting) a new turn starts. A return value over 8 KB is cut in the message and the full text is written to
a file whose path the message gives (in the parent session's `subagents/<session id>/` directory).

| `run_in_background` on an `Agent` call | Effect |
|---|---|
| omitted | the first call moves its script to the background |
| `false` | the script stays in the foreground (and is pinned there for its later calls), so main can use the result in the same turn |
| `true` | the call returns `status: "running"` with its `agentId` at once and the script is not moved; main gets a message when that agent ends |

**`run_in_background` on a `codemode` call** moves the script to the background as it starts, whether or not it starts an
agent, with an optional `description` (a few words) that names it ("Script S1 (build and test) started in the background
..."). Use it for a long command whose result main does not need this turn; the script should return a filtered result.
See [Run in the background](codemode.md#run-in-the-background). With `subagent.backgroundScripts: false`, in print mode,
or without this extension, the flag is ignored and the call waits.

### Agents that outlive their script

An `Agent` call still running when its codemode script ends is released, not cancelled: the agent runs on and reports
to main. So a script can start agents without `await` and end at once; main's turn can end, main stays idle (no LLM
turns) while the agents work, and wakes once when they are all done. The tool descriptions recommend this: start the
agents and end the script, and `await` an agent only when the script must use its result. This applies to
`tools.Agent(...)`, the `agent()` and `parallel()` helpers, and `SendMessage` (a continue is an agent run; a steer
returns at once anyway), on every end but an abort: a normal end, a throw,
`exit()`, the deadline (`timeout_ms` no longer stops agents), and a sandbox failure. Other calls still running are
cancelled as before, and so is everything on an abort (Esc on a foreground script, `x` on a running script, the
session's end).

- **The group.** The agents a script leaves running form its group: the calls that were still on their way at the end
  (in argument validation, a hook, a pause) and every `Agent` call the script started. A call that fails before its
  agent starts (bad arguments, a blocked call, an unknown `subagent_type`, `maxAgentsPerScript`) is part of the group
  with its error. The same agent continued later from another script belongs to that script's group. A
  `run_in_background: true` agent is a member too, and ends when its agent's run ends; inside a group it sends no
  message of its own. One whose run ends while the script's code still runs reports on its own, as before (the script
  only saw `status: "running"`), and is a line of the group. A script that leaves nothing running has no group and ends as before.
- **One message.** When every member has ended, main gets one message (a steer that triggers a turn): the script's
  outcome if it ran in the background (its state, such as "every agent failed", is decided then), one line per member
  (id, type, description, state, cost, duration, and the error of a failed one), the output of each member that was
  still running when the script ended (cut at 8 KB, the rest in a file in `subagents/<session id>/`), and the total
  cost and time. A member that ended before the script did gets only its line: the script could read its result. A
  failed member does not wake main early. A foreground script whose agents all ended before it did has no such
  message: its result carries them, as before.
- **`wake: "each"`** on an `Agent` call takes it out of the group: if it is still running when the script ends, it
  reports on its own when it ends, as a `run_in_background` agent does (for races). The group's message does not wait
  for it, and a foreground script that leaves only such agents sends no group message. Its usage is still counted. On a
  call that ends inside the script it changes nothing.
- **Panel.** The script's row stays open while its group runs, for example `● ended · script S3 · 2/4 agents done ·
  4m12s`, with its agents below. `x` on that row stops all of the script's agents, `wake: "each"` ones
  included (calls that have not started an agent yet do not start one), and main gets the message with the state `stopped`. A group cannot be paused: a script paused when its
  code ends is resumed, and the calls waiting for the resume do not start ("not started: the script was paused").
- **Cost.** The agents' usage is added to the session when the group ends.
- **Ending the session** stops the group's agents, and no message reaches the next session.
- **Workflows.** A workflow run is a script of its own, with its own group. Its run stays `running` until the group
  ends, and cannot be relaunched before.
- **Where.** As for background scripts: with a UI and `subagent.backgroundScripts` on. In print mode and with
  `backgroundScripts: false` a script waits for its agents, and its end cancels what is pending. Agents started
  outside scripts, and `/subtask`, report one message each as before.

The codemode result lists such a call with the status `released` (see [Codemode](codemode.md#scripts)).

### Waiting for agents

While agents run in the background, main makes no model turns, and the user and clients see what is going on:

- **A user message during a group.** When a user message starts a turn while a group is running, one line follows it
  in main's context, for example `[agents still running: k3x9 Explore "audit api" 4m12s; p0q1 general-purpose "fix
  tests" 2m05s]`: the members still running, with their elapsed time. It is a custom message (not shown in the
  transcript), so the cached prompt prefix is unchanged. Steers and follow-ups typed while main runs do not get it
  (they start no turn), and neither does a turn started by a message such as an agent's result.
- **Stalls.** Every event of a child counts as activity; the clock starts when the child's process starts, not while
  the agent waits for a free slot (`maxConcurrent`) or a staggered start. Every 30 s, a running agent with no activity
  for `subagent.stallMs` (default 600000, 10 minutes; `0` turns it off) is marked stalled: its panel row shows
  `stalled Nm` (`stalled Ns` under a minute) next to its last tool, and you get a notification naming the agent and its last tool. Main is never
  told. The next event clears the mark. A quiet tool (a long build or test run) can look stalled, which is why the row
  shows the tool; nothing is stopped automatically, and `maxTurns` still applies. A group's message adds
  `stalled Nm` to the line of a member that stalled (its longest stall).
- **Status for clients.** The extension publishes the session's running agents, stalled agents, groups and background
  scripts with `ctx.ui.setStatus("subagents", ...)`, for example `3 agents running · 1 stalled · 1 group`, and
  clears it when nothing runs. The TUI shows it in the footer; an rpc client receives it as an `extension_ui_request`
  with `method: "setStatus"` and `statusKey: "subagents"` (see [RPC extension UI](rpc-extension-ui.md)).

`npm run eval:delegation -- --long --only three` measures the waiting on two multi-agent tasks (three independent
parts each) through `xpi --mode rpc`: how often main woke (`wakes`), how many scripts set `timeout_ms`, how many agents a
deadline stopped, and how many calls were `released`, next to time and cost. `--cli <path>` runs another build, for a
before/after comparison. See [Relay: Limits](relay.md#limits) for the evaluation's other options.

**ctrl+b** moves a running foreground script to the background (for example a slow script that starts no agent). It
works only when the editor is empty; with text in the editor, or with no script running, ctrl+b stays cursor-left.

**Panel.** Each background script is a row with its agents indented below, for example
`● background · build and test (S1) · 1m12s · bash npm test`: state, the script's name, elapsed time and the tool call it
is running now. The name is its `description`, else its first `bash` command, else `script S1`; a workflow row reads
`workflow <name> (S1, R2)`. The agent count (`N agents running`) and the cost appear only when the script has agents.
Enter opens [the script screen](#the-script-screen). Finished rows linger like agent rows. `x` on a script row stops the script and all its agents (their calls return
`failed` / "stopped by user"; main gets the usual end message with the state `stopped`). `x` on an agent row stops only
that agent, and the script carries on. Several scripts can run at once; their agents share the `maxConcurrent` limit.

**Esc** aborts main's turn. It stops a script that is still in the foreground, as before, and leaves background scripts
running. **Ending the session** (quit, reload, `/new`, resume) stops every background script and detached agent; the
agents are marked stopped and stay resumable.

`subagent.backgroundScripts: false` turns all of this off: the extension does not track scripts or move them (the codemode
controller is simply never asked to), and a script that starts an agent waits for it. Print mode (`xpi -p`) behaves the same way on its own, since pi exits when the
turn ends and a background result would be lost; there `run_in_background: true` waits too, and the tool description leaves the background rules out. Your `codemode` settings (`mode`, `inlineBudget`) are unaffected either way.

## Structured output

`schema` on an `Agent` call, a JSON Schema with `type: "object"` at the top, makes the agent return a value instead of
prose, as Claude Code's workflow `agent(prompt, { schema })` does:

```js
const r = await tools.Agent({
  description: "list routes",
  prompt: "List every route file under src/routes.",
  subagent_type: "Explore",
  schema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] },
});
r.structured.files; // string[]
```

How it works: the child gets one more tool, `StructuredOutput`, whose parameters are the schema, and one line at the
end of its prompt telling it to finish with that tool. pi validates the call like any tool call, so an invalid one goes
back to the model with the failing paths and the model tries again within the same run. A valid call ends the run. The
tool is offered to the model directly, also to a codemode-only child (next to `codemode`), and is added to an agent's
`tools` list.

| Outcome | Result |
|---|---|
| a valid call | `completed`; `structured` is the value (validated and coerced), `output` its JSON text (`JSON.stringify(value, null, 2)`) |
| 5 invalid calls | `failed`, `error: "structured output did not match the schema after 5 attempts: <last validation error>"`; the child is stopped |
| the run ends without the call | the child is asked once more ("Call StructuredOutput now with your result."); still none: `failed`, `error: "the agent ended without structured output"`, `output` keeps its last text |
| `maxTurns` reached first | `partial`, no `structured` (a valid call in the last allowed turn counts as `completed`) |

A schema no value could match throws before any child starts: not an object, a root other than `type: "object"`,
`properties` that is not an object of schemas, `required` that is not a list of names, or a required name that
`additionalProperties: false` rules out. Nested schemas are not checked beforehand (pi's validator accepts almost any
schema, since it takes MCP servers' too); a nested mistake shows up as failed attempts.

The schema belongs to the call: a `resume` may pass one or not, and talking to the agent on its screen never uses one.
A `run_in_background: true` agent's end message carries the JSON text. The tool list comes before the system prompt in
a request, so a child with a schema has its own prompt-cache prefix (see [Prompt caching](#prompt-caching)).

## Names and SendMessage

`name` on an `Agent` call (letters, digits, `_` and `-`, at most 64) names the agent. The name is stored with it,
shown in the panel and on the screen header as `type(name) description`, and is unique in the parent session: a second
agent with the name throws, naming the first one's id. `resume` takes a name as well as an id. A resume keeps the
name; passing another one (or a name for an agent that has none) throws.

`SendMessage({ to, message, summary? })` reaches an agent this session started, `to` being its name or id:

| The agent is | Effect | Returns |
|---|---|---|
| running | `message` is delivered as a steer; the agent takes it after its current step | at once: `{ status: "running", agentId, delivered: "steer" }` |
| completed, partial, failed or stopped | continued from its session with `message`, exactly like `Agent({ resume, prompt: message })`, under the same background rules | the `Agent` result |
| unknown | throws, listing the session's agents by name and id | |

```js
await tools.Agent({ name: "reviewer", description: "review the diff", prompt: "Review the staged diff.", run_in_background: true });
// later, from another script
await tools.SendMessage({ to: "reviewer", message: "Also check the migration file." });
```

`summary` is accepted and unused. A steer main sends is not noted back to main (the note exists for what the user said
on the agent's screen). `SendMessage` carries no `schema`: use `Agent` with `resume` for a structured answer. Children
get neither `Agent` nor `SendMessage`, except teammates of an [agent team](#agent-teams), which get `SendMessage` only. With an in-memory parent session
(`--no-session`) names and steers work while the process lives, and nothing can be continued, as with `resume`.

## Agent teams

Experimental, off by default. With agent teams on, an `Agent` call with a `name` starts a **teammate**: a subagent that
runs in parallel with the session (the **lead**), messages the lead and other teammates by name, and is woken again by
messages. It is modelled on Claude Code's agent teams. This page describes what exists now: teammates, messages, idle
notices, shutdown and the end of a team. The shared task list, the `agent-teams:` events and the panel and screen
changes (typing to a teammate, Esc, `/tasks`) come in later changes.

### Turning it on

```json
{ "agentTeams": { "enabled": true, "maxTeammates": 8, "taskRetentionDays": 30 } }
```

`"agentTeams": true` is short for `{ "enabled": true }`. `XPI_EXPERIMENTAL_AGENT_TEAMS=1` also turns teams on; nothing
turns them off but the setting. The setting is read at session start and on `/reload`, because the lead's tools and prompt
section are set up then. Teams are on only in the interactive TUI, in a saved session (not `--no-session`, where nothing
can be continued). In print and rpc mode a named call is an ordinary subagent. See [Settings](settings.md#subagents).

### Starting a teammate

With teams on, `Agent({ name, description, prompt })` starts a teammate and returns at once with `{ status: "started",
agentId, name, team }` (`"queued"` while it waits for a `subagent.maxConcurrent` slot), like `run_in_background: true`. It
never waits for the teammate's work.

- A call with `subagent_type: "fork"` or `isolation` is an ordinary subagent. A name another (non-teammate) subagent has
  still throws.
- Refused, with the reason in the error: `schema`, `run_in_background: false`, and a call from a workflow or a workflow's
  script (a teammate outlives the script and reports to the lead, so the script could not use its result).
- At most `maxTeammates` members that are not stopped (running, queued or idle). A call over the cap throws, naming them.
  Stopping a teammate frees its place.
- The team is implicit: one per session, the lead fixed, named `session-<session id>` on disk and shown as
  `session-<first 8 characters>`. Teammates get no `Agent` or `Workflow`, so nesting stays one level.
- Model, trust and tools follow the subagent rules (`subagent.defaultModel`, the lead's trust decision). A teammate
  always has `SendMessage`, whatever its agent file's `tools`, `disallowedTools` or `permissionMode` say, as a codemode tool
  when it has codemode and as a direct tool when it has not. Naming `SendMessage` in `tools:` is accepted.

### Messages

`SendMessage({ to, message, summary? })` reaches any member by name; `to: "lead"` is the session (the only way from a
teammate to the lead). There is no broadcast. The call returns `{ status: "sent", to, id }` once the message is written to
the recipient's mailbox, and throws when it cannot be (`stopped` for a stopped member; an unknown name lists the members).
With teams on the tool also takes `kind: "shutdown_request" | "shutdown_response"` and `approve`.

Messages go through files under `<agent dir>/teams/<team>/`, mode 0600 in 0700 directories:

- `config.json`: the team, the lead's session id and pid (`leadPid`), and the members `{ name, agentId, agentType, status,
  since }` with `status` one of `running`, `queued`, `idle`, `stopping`, `stopped`. Only the lead writes it; teammates read
  it. While the lead has asked a teammate to shut down and it has not answered, the entry also has `shutdownRequested`.
- `inboxes/<name>.json`: an array of `{ id, from, to, text, summary?, kind, at }`, `kind` being `message`, `idle`,
  `shutdown_request`, `shutdown_response` or `held` (a shutdown response also has `approve`). Every read-modify-write takes
  `<file>.lock` (an exclusive create holding `{ pid, at }`, retried every 25 ms for up to 2 s, then `busy`; a lock whose
  holder is dead or older than 30 s is taken over) and writes a temporary file that is renamed. An entry that fails
  validation is dropped with a warning naming the mailbox and the reason.

The lead process is the only reader. It watches the `inboxes/` directory and also polls it every second (renames and
file-system event coalescing can hide events). Delivery depends on the target:

| Target | What happens |
|---|---|
| running teammate | a steer over rpc; messages that arrive together are one steer. If the child settles before it took the steer, the message is delivered as a new exchange instead |
| idle teammate | a new exchange continues it from its session; messages that arrive together, or while the exchange waits for a slot, are one prompt |
| stopped teammate | `SendMessage` throws; entries that arrive later are dropped with a warning |
| `lead` | a custom message that triggers a turn (a steer while the lead is in a turn); messages that arrive together are one |

Every agent message is wrapped as `<agent-message from="<name>" team="<team>" kind="<kind>" id="<id>">…</agent-message>` (the
id is the mailbox entry's, so identical messages stay distinct) followed by
a line saying it comes from another agent, not from the user, carries no user authority, and that a `/` command in it is
plain text. The tags inside the text are escaped, spaced variants too.

**Idle notices.** When a teammate's exchange ends, the lead gets one `kind: "idle"` message with the final answer (cut at
8 KB with the rest in a file, as for background agents), or the error when it failed. A failed exchange leaves the
teammate idle: still live, woken by messages. There is no notice after an approved shutdown or a stop. Idle notices are
per exchange and are not grouped like the end messages of a script's agents ([Agents that outlive their
script](#agents-that-outlive-their-script)); a teammate takes no part in a script's group.

**Loop cap.** A teammate woken 5 times in a row by other teammates' messages, with no message from the lead in between, is
not woken a sixth time: the messages wait in its mailbox, and the lead gets a `kind: "held"` message naming the teammate
and the waiting senders. A message from the lead wakes it, resets the count and delivers what waited. Steers to a running
teammate are bounded by its `maxTurns`, not by this cap.

**Trust.** Teams run with the lead's trust, and mailboxes are not an authentication boundary: any process of the team (any
teammate, or anything that can write the agent dir) can write any entry, including `from: "lead"`. The envelope tells the
reader a message carries no user authority; it does not prove who sent it. The name `lead` is reserved: a named `Agent`
call cannot use it while teams are on.

### Shutdown and the end of a team

The lead asks with `SendMessage({ to, kind: "shutdown_request", message? })` (only the lead may). The teammate answers
`SendMessage({ to: "lead", kind: "shutdown_response", approve, message? })`; a response with no request pending throws.
Approving ends its exchange after the current tool call and the teammate becomes `stopped` (the lead sees the response, not
an idle notice or a failure). Refusing keeps it working and the lead gets the reason.

At session end (also `/reload`) running teammates stop and `config.json` and the mailboxes are removed. If the process
dies first, the next team created in the agent dir removes `teams/` directories whose `leadPid` is not alive. A directory of the same session left by a dead lead (a crash, then `/resume`) has its mailboxes cleared when the new team is created, so old messages are not delivered as new. If that directory's lead is still alive (the same session open in two xpi processes, which teams do not support), creating the team fails with an error instead.

**Former teammates.** `/resume`, `/reload` and a crash end the team, and it is not restored. A teammate's meta file keeps
`teammate: true`, its `team` and its frozen prompt section, so an `Agent` call with its name (or a `SendMessage` to it)
continues it as a member of the new team, with its history and the same prompt section.

### Prompts

A teammate's system prompt tail has an "Agent team" section (its name, the roster when it started, how `SendMessage` and
the envelope work, shutdown), frozen when it first starts and reused on every continue so its history stays cached. The
lead's prompt has a short "Agent teams" section while teams are on. With teams off neither exists, and the head of the
system prompt stays the same for every agent.

## Fork

A fork is a subagent that starts as a copy of the main conversation instead of empty: it knows everything said so far,
does one side task, and returns only its result. Use it when the task needs the conversation ("write the tests for
what we just built") and restating the context in `prompt` would be long or lossy.

```js
const r = await tools.Agent({ subagent_type: "fork", description: "write the tests", prompt: "Write tests for the parser we just changed." });
```

- The user starts one with `/subtask <task>`, with no model turn: it runs in the background and its result arrives in
  main as a message (in print mode the command waits and prints it).
- `fork` is a reserved agent type with no agent file; an agent file or `--agents` entry with that name is skipped with
  a warning. It is listed in the tool's description when the session is saved and `subagent.fork` is not `false`.
- It runs on main's model and thinking level. `model`, `effort` and `schema` are refused. `name`, `isolation` and
  `run_in_background` work as for any agent, and so do `resume`, `SendMessage`, the panel, the screen and stop.
- How it starts: main's session file is copied into the subagents dir as the fork's own session
  (`SessionManager.forkFrom`), and every tool call of the last assistant message that has no result yet (the script
  that is calling `Agent`) gets one that says "you are a fork, do the task in the next message". The child then
  starts like a resume. It gets no system prompt flags: the session holds main's.
- Cost: the system prompt and tool declarations travel with the session, so the fork's first request reads main's
  prompt cache. Measured on haiku: a main prefix of 5929 tokens was read in full (`cacheRead 5929`), with 115 to 640
  new tokens written.
- A fork is a normal child: it has no `Agent`, `SendMessage` or `Workflow`, so it cannot start a subagent or another
  fork.
- An in-memory session (`--no-session`) has no file to copy: the call throws and says so.

## Worktree isolation

`isolation: "worktree"` (in the `Agent` call or the agent file; the call wins) runs the agent in its own git worktree
on its own branch, so it can edit freely without touching your checkout or other agents.

- The worktree is `<repo>/.pi/worktrees/<agentId>` on branch `subagent/<agentId>`, based on the main checkout's `HEAD`.
  `/.pi/worktrees/` is added once to the repository's `info/exclude`, so worktrees never show up as untracked files.
  Local repositories without a remote work. Outside a git repository, or in one without commits, the call throws.
- The agent's working directory (and the `Working directory:` line in its prompt) is the worktree. When the calling
  session's cwd is a subdirectory of the repository, it is the same subdirectory inside the worktree (if that directory
  is not in the starting commit, the worktree root, with a warning). Uncommitted changes in your checkout are not in it:
  the result carries a warning when there are any.
- Files listed in `.worktreeinclude` at the repository root (gitignore syntax) are copied into the worktree, but only
  those that are also gitignored, so tracked files are never duplicated. Directories are copied recursively.
- When an exchange ends (completed, partial, failed or stopped), an unchanged worktree is removed with its branch. A
  changed one is kept, and the result's `worktree` gives `path`, `branch`, `files`, `commits` and sometimes a `note`.
  Changed means: uncommitted, untracked or new commits, or gitignored files the agent made (`dist/`, `.env`; not `.pi/`
  and not unmodified `.worktreeinclude` copies), or HEAD no longer on `subagent/<agentId>` (detached, another branch), or
  a stash made on that branch; the `note` says which of the last two. Unchanged: `worktree: { changed: false }`. Nothing is committed, merged or deleted for
  you; remove a kept one with `git worktree remove --force <path>` and `git branch -D <branch>`.
- Resuming an agent re-enters its worktree. If the worktree was unchanged and so removed, it is recreated at the same
  path and branch from the current `HEAD`. If you removed a changed one but its branch remains, the call throws naming
  the path. The `isolation` of a resume call is ignored with a warning: the agent keeps how it was started.
- A `run_in_background: true` agent that keeps a worktree reports it in its end message.
- `/subagents worktrees` lists the kept worktrees under `<repo>/.pi/worktrees/` of the current checkout (agent id, branch, files changed, commits,
  path) and removes the ones you pick. Before removing it asks to confirm and names what would be lost (the changed files
  and the commits on the branch). Removal deletes the worktree and its branch. It only looks at the checkout of the current
  directory, not at other repositories.

## Agent memory

`memory: user | project | local` in an agent file gives the agent a persistent directory at Claude Code's paths, so agent
files and their memories carry over from Claude Code. `<name>` is the agent's `name` field.

| Scope | Directory |
|---|---|
| `user` | `~/.claude/agent-memory/<name>/` |
| `project` | `<main checkout>/.claude/agent-memory/<name>/` (meant to be committed) |
| `local` | `<main checkout>/.claude/agent-memory-local/<name>/` (added to the repository's `info/exclude` once) |

- The main checkout is the repository root of the cwd of the session that calls `Agent` (from a linked worktree, the
  main checkout), never the agent's worktree, so
  memory survives a removed worktree. Outside a repository `project` and `local` use that cwd, and no exclude file is written.
- The directory is created when the agent starts. The system prompt gets a "Persistent memory" section: where the
  directory is, how to keep `MEMORY.md` a short index, and the first 200 lines or 25000 bytes of `MEMORY.md` (whichever
  comes first, with a note when cut). A resumed agent reads the current file.
- Read, Write and Edit are enabled for the agent when its `tools` list lacks them. If `disallowedTools` names Write or Edit,
  they stay denied and the other one is removed too (a `tools` list is overridden): the memory is read-only, the prompt says so
  and the result carries a warning. A parameterised deny such as `Write(*.md)` denies the whole tool (pi has no per-path
  rules), and the warning says so. A `MEMORY.md` that cannot be read (a directory, permissions) counts as empty, with a
  warning. Only the tools are
  denied: an agent that still has Bash can write the file anyway, so deny Bash too when it must not change.
- **Risk:** an agent with memory writes files outside its working directory (`~/.claude` for `user`, the main checkout
  for `project` and `local`), and what it saves is fed back into its prompt on later runs. Use `disallowedTools` for a
  read-only memory, and review `project` memory before committing it.

## MCP

MCP tools are excluded from a child whenever its agent file has a `tools` list without `mcp__` entries. An agent with
no `tools` list gets your normal tools and every installed extension, MCP included.

`mcpServers: [docs, slack]` in an agent file narrows that to the named servers (names as in `mcp.json`, the agent dir's
and, in a trusted project, the project's). With a `tools` list, each server's tools join it as `mcp__<server>__*`.
Without one, the configured servers the agent does not name are excluded (`--exclude-tools`); servers an extension
registers at run time are not in `mcp.json` and are not excluded this way. `mcpServers: []` removes all MCP tools.

### Inline servers

An entry can also define a server, as in Claude Code, in the same shape as a `mcp.json` entry:

```yaml
mcpServers:
  - docs                       # configured in mcp.json
  - probe:                     # defined here, for this agent only
      command: node
      args: [./tools/probe-server.mjs]
  - tracker:
      url: https://tracker.example/mcp
      headers: { Authorization: "Bearer ${TRACKER_TOKEN}" }
```

- Only the child connects to them, and it disconnects when it ends: the child gets them with
  [`--mcp-config`](mcp.md#add-servers-for-one-run), as JSON in its arguments. The parent session does not get them.
  Values written out in the file (an `env` token, say) are visible in the process list then; use `${VAR}`, which the
  child expands. Servers the parent got from its own `--mcp-config` are not passed on.
- They need the built-in MCP extension. With it turned off (`-builtin:mcp` in the `extensions` setting) or replaced by
  another MCP extension, they are skipped with a warning in the result.
- Their tools are handled like a named server's: with a `tools` list, `mcp__<server>__*` joins it.
- Types are those `mcp.json` accepts (`stdio`, `http`, `streamable-http`, or none). An entry it rejects (`sse`, `ws`, a
  bad field) is skipped with a warning at discovery that gives the reason.
- Trust, as in Claude Code: inline servers of an agent file in the project (`.pi/agents`, `.claude/agents`) load only
  in a [trusted](security.md#understand-project-trust) project; otherwise they are skipped with a warning in the result.
  Those of user agent files (`~/.pi/agent/agents`, `~/.claude/agents`), `--agents` and built-ins always load. A project
  agent file may not use `auth: { provider }` (skipped with a warning), the rule the project `mcp.json` has: a
  repository must not choose where a credential goes.
- A name equal to a configured server's replaces that server for this child. A name that collides with another
  server's only in the tool namespace (`a-b` and `a_b`) is skipped with a warning.
- Each set of inline servers makes its own [prompt-cache group](#cost-caching-and-limits), since their tools come
  before the system prompt.
- A child has no UI, so an inline HTTP server cannot run an OAuth sign-in. It uses what `mcp.json` would: `headers`, or
  tokens `/mcp` already stored for a server with the same name and URL.

## Permission mode plan

`permissionMode: plan` is Claude Code's read-only exploration mode. xpi has no permission prompts, so it is done with
the child's tools:

- The agent gets `read`, `grep`, `find` and `ls` (and `codemode` when it is codemode-only, `StructuredOutput` for a
  call with `schema`). A `tools` list narrows that set: `tools: Read, Write, Grep` gives `read` and `grep`. If nothing
  is left, the call fails with "has no usable tools".
- The child has exactly those tools: no other tool registers, so a codemode script cannot reach one either.
  `write`, `edit`, `bash`, `powershell` and `mcp__*` are also excluded by name.
- No MCP: the child runs with `--no-mcp`, so no server starts (MCP tools can change things). `mcpServers` is ignored
  with a warning at discovery.
- `disallowedTools` still applies.
- Agent [memory](#agent-memory) is read-only: the prompt says so, and only `read` comes with it.
- The prompt tail tells the agent it is a read-only planning agent.

Tools that extensions register in the child are not available either, since the tool list is fixed; their event
handlers (an agent's [extensions](#extensions-as-hooks)) still run. (Fork does not read agent fields, so `plan` does not
apply to it.)

## Extensions as hooks

Claude Code's `hooks` field runs shell commands on tool events; xpi does that with [extensions](extensions.md). The
`extensions` field lists extensions that load only into this agent's child:

```yaml
---
name: careful-refactor
description: Refactors without touching the shell
extensions:
  - ./guards/no-bash.ts      # relative to this agent file
  - npm:@acme/audit-log
---
```

```typescript
// .pi/agents/guards/no-bash.ts
export default function (pi) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash") return { block: true, reason: "This agent may not use the shell." };
  });
}
```

- `tool_call` can block a call or change its input, `tool_result` can change a result, `agent_before_settle` can keep
  the agent going. Calls a codemode script makes go through the same handlers.
- Each entry is one `-e` for the child. A local path is resolved against the agent file's directory (for
  [`--agents`](#agents-on-the-command-line), against the working directory) and passed absolute, so it also works in a
  [worktree](#worktree-isolation). `npm:`, `git:` and `builtin:` sources are passed as given. Use the list form for a
  path that contains a comma. A local path that does not exist warns at discovery and is still passed, so the call
  fails until it exists.
- The child runs with [`--strict-extensions`](cli.md#resource-options): an extension that cannot load (a failed
  install, a missing file, an error while loading, a source that yields no extension, a package not installed in
  offline mode) stops it, and the result is `failed` with the error. A guarded agent never runs without its guard.
- Their event handlers always run. Tools they register appear only for an agent without a `tools` list: a `tools`
  list (and [`plan`](#permission-mode-plan)) names exactly the tools the child has.
- Trust: a project agent file's extensions load only in a [trusted](security.md#understand-project-trust) project.
  In an untrusted one the call fails with the reason instead of running without them. Those of user agent files,
  `--agents` and built-ins always load.
- They are part of the agent's [prompt-cache group](#cost-caching-and-limits): the tools they register come before the
  system prompt.

## Codemode-only children

By default a child sees only the `codemode` tool (pi's `codemode` extension in `only` mode, added with `-e`) and calls
its allowed tools from scripts. The `tools` / `disallowedTools` of the agent still bind inside those scripts, and a
`tools` list without `mcp__` entries still removes every MCP tool. The child's system prompt gets one extra line after
its preamble: "Use the `codemode` tool for all tool calls, and put independent calls in one script."

Why: fewer turns and less wall time. In the [comparison](#codemode-only-vs-direct-tools) below, codemode-only needed
2 to 3 turns where direct tools needed 2.6 to 4.4, at about the same cost.

Opt out:

- per agent: `codemode: false` in the agent file
- for everything: `"childCodemode": "inherit"` in `subagent` settings (direct tools)

Such a child gets direct tools and no `codemode`. One exception: a child without a `tools` list that has MCP servers
(any configured server, or the ones its `mcpServers` names) gets `codemode` from the MCP extension when a server's tools
are reachable only from scripts (`codemode` exposure, the default); otherwise it could not call them.

## Workflows

A workflow is a codemode script that orchestrates subagents, saved to be rerun, in Claude Code's dynamic-workflow
format. Every script that can call `Agent` has these helpers over it, so a script main wrote can be saved unchanged:

| Helper | Meaning |
|---|---|
| `agent(prompt, opts?)` | One subagent. `opts`: `label` (the `description`; default: the prompt's first words), `schema`, `type` (`subagent_type`), `model`, `effort`, `isolation`; `stallMs` is accepted and unused. Resolves to the output text, or with `schema` to the value; to `null` when the agent failed or was stopped, as in Claude Code (check `if (!r)`). It rejects only when a `schema` was never met (after 5 invalid attempts, or no structured answer), and for a wrong call. |
| `parallel(tasks)` | Functions returning promises, or promises; all run at once. Resolves to their results in order, `null` for one that failed. At most 4096 tasks. |
| `pipeline(items, fn)` | `fn(item, index)` for every item at once (`maxConcurrent` queues the agents). Results in order, `null` for a failed item. At most 4096 items. |
| `phase(title, fn?)` | Names the agents started from here (or inside `fn`) for the panel, whether a script starts them with `agent()` or with `tools.Agent`. Phases are sequential: concurrent `phase()` calls share one current title. |
| `log(text)` | A progress line on the script's row in the panel. |
| `args` | The run's input; `undefined` in an ad hoc script. |

`tools.Agent` stays available for the full result (`status`, `error`, usage). Unlike Claude Code, `Date.now()`, `Math.random()` and `new Date()`
work (there is no replay of a run). One script run may start at most `subagent.maxAgentsPerScript` agents (default
1000): the next `Agent` call throws.

### Saved workflows

`<name>.js` files, read from five places, highest priority first (the same order as agent files):

1. `.pi/workflows/` in the project (from the cwd up to the repository root, closest wins; trusted projects only)
2. `.claude/workflows/` in the project (same walk): Claude Code's workflow files run unchanged
3. `~/.pi/agent/workflows/`
4. `~/.claude/workflows/`
5. The built-in workflows that ship with xpi (see [Built-in workflows](#built-in-workflows)); they run in untrusted projects too

A name found earlier hides the same name later. The first statement is `export const meta = { name, description, phases? }`, a plain literal
(read, never run; `name` equals the file name, lowercase letters, digits and dashes); the rest is the script body, with
its line numbers kept in errors. A file with a missing or malformed `meta`, or with `import`, is skipped with a warning.

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

- `/<name> args` runs it with no model turn: `args` is the text after the name, parsed as JSON when it is JSON. With a
  UI it starts as a background script at once and its result arrives in main as a message; in print mode
  (`xpi -p "/audit-routes"`) it runs in the foreground and prints its return value. A name another command already has
  is skipped with a warning.
- The model runs one with `tools.Workflow({ name, args })`, or starts a run again with `relaunch` (offered when at least one workflow can run; its
  description lists them). It returns the script id at once, and the result arrives as a message.
- `/workflows` lists the saved workflows (with the directory each was read from) and this session's workflow runs
  (`R2 audit · stopped · 3 of 5 calls completed`). Enter on a workflow runs it (no args); on a run that is going it
  offers its agents, pause or resume, and stop; on one that stopped or failed it relaunches it.
- `s` on a script row in the panel saves that script: it asks for a name, a description and where (project or user),
  confirms an overwrite, and writes the script with a `meta` statement into `.pi/workflows/` or
  `~/.pi/agent/workflows/` (never into `.claude/`). The new workflow is a command at once.

The panel shows a workflow's run as `workflow <name> (S<n>, R<n>)` with its last `log()` line, and its agents under
their `phase()` titles.

### Built-in workflows

xpi ships workflows in `src/extensions/subagent/builtin/workflows/` (`dist/extensions/subagent/builtin/workflows/` in a
build; the standalone binary reads them from `dist/` next to the executable, like the built-in agents). They are listed
by `/workflows` with source `builtin` and run as `/<name>` like any saved workflow. To change one, save a file with the
same name in `.pi/workflows/` or `~/.pi/agent/workflows/`: it hides the built-in one. The only one today is `review`.

#### `/review [target]`

Reviews a diff with parallel read-only [`reviewer`](#agent-definitions) agents and returns a ranked list of findings.
It runs with no model turn and edits nothing. It reads the diff with the session's `bash` tool, so it needs that tool
(and `gh` for pull requests).

| Target | Reviews |
|---|---|
| (none) | The working tree against `HEAD`: staged, unstaged and untracked files (new files as all-added diffs) |
| `main` (a branch) | The changes on `HEAD` since it left that branch (`git diff main...HEAD`) |
| `abc1234` (a commit or tag) | That commit (`git show`) |
| `#12` | GitHub pull request 12 (`gh pr diff 12`) |

How it works:

1. Lockfiles, minified or generated files (`*.min.*`, `*.generated.*`), source maps, snapshots, `dist/`, `build/`,
   `out/`, `node_modules/`, `vendor/`, images, fonts, archives and binary diffs are skipped and named in the result.
2. The changed lines set the number of reviewers: under 100 lines or at most two files, one; under 500, two; under
   2000, four; more, eight (never more than there are files). Files are grouped by directory, a test file goes with the
   implementation that has the same base name, and the groups have about the same number of changed lines.
3. One `reviewer` per group runs in parallel and returns findings through a schema: `title`, `body`, `priority`
   (`P0` to `P3`), `confidence` (0 to 1), `file`, `lineStart`, `lineEnd`. A reviewer that fails is reported, not fatal.
4. With findings, one more `reviewer` re-checks them against the code, merges duplicates and drops what it cannot
   confirm. If it fails, the findings are shown marked as unverified.
5. The result lists the findings ranked by priority, then confidence: `1. [P1] title — file:10-14`, the explanation and
   the confidence; then how many findings the verifier dropped, the skipped files, and the reviewer count and failures.

A diff over 60000 changed lines is refused: review a narrower target. The reviewers run on the `sonnet` alias; see
[Model selection](#model-selection).

### Runs, saved results and relaunch

Every run of a saved workflow is recorded: a run file `subagents/<session id>/runs/R<n>.json` next to the session
holds the workflow's name, its args, and each `Agent` call in the order the script made it, with what it asked and
what it returned. Run ids are `R1`, `R2`, ... per session; the script row and the end message show them. An in-memory
session keeps its runs for the life of the process. A script that was not saved is not recorded: save it first (`s`).

A run that stopped or failed (or whose script finished although an agent failed) can be relaunched, so the work that
finished is not done twice:

- You: `/workflows`, select the run, `Enter`.
- The model: `tools.Workflow({ name, relaunch: "R2" })`. The end message of such a run says so.

A relaunch runs the script again from the top, with the workflow file as it is now and the args of the run it
relaunches (`args` may not be passed). Each `Agent` call, in order, is answered from the saved results when every call
before it was, and it asks the same thing (prompt, agent type, model, effort, schema, isolation) and completed last
time. No child starts and nothing is spent; the result is the old agent's, with its id, so it can still be continued.
The first call that differs, failed, or was still running when the run stopped runs again, and so does every call after
it, even ones that had completed (they may depend on what came before). This is Claude Code's rule. Example: a script
starts A, B, C and D in that order and B failed; the relaunch answers A from saved results and runs B, C and D.

- A relaunch is a run of its own (`R3`, a relaunch of `R2`) and can be relaunched in turn.
- Refused, with the reason: a run that is still going or whose agents are still running, a run that completed with
  nothing left to do, a run id with no saved results (`nothing to resume`).
- `Date.now()`, `Math.random()` and `new Date()` keep working (Claude Code makes them throw). A script whose prompts
  depend on them reruns from the first prompt that differs.
- A call with `run_in_background: true` is never answered from saved results and is not compared.
- A call that runs again and carries a `name` takes the name over from its agent of the earlier run, which keeps its
  id and loses the name.
- The script row shows how many calls were answered: `12 from saved results`.

### Pause and resume

`p` on a running script's row in the panel pauses it, and `p` again resumes it; `/workflows` offers the same for a run
that is going. A paused script starts no new agent: each `Agent` call it makes waits until it is resumed, in the order
the calls arrived. Agents that are already running finish their work (a model request under way cannot be held), and
their results are kept. Any script can be paused, saved or not. A paused script can be stopped (`x`); when the session
ends it is stopped like any other, and a saved workflow's run can then be relaunched.

## Watching and talking to subagents

The panel and the subagent screen need interactive xpi. In print mode (`-p`) agents, `/<workflow>` and `/subtask` run in
the foreground and print or return their result; there is nothing to watch.

### The panel

While a session has subagents, a panel sits below the editor. One row per subagent, oldest first:

```
Subagents (2)
  ● running · Explore(find auth code) · 3 turns · read · $0.0004
  ✓ completed · general-purpose(summarize) · 2 turns · $0.0011
```

| Marker | Status |
|---|---|
| `●` | running |
| `✓` | completed |
| `◐` | partial (stopped by `maxTurns`) |
| `✗` | failed |
| `■` | stopped by you or by an abort |

A row shows the type and description, turns, the last tool, `stalled Nm` when it is [stalled](#waiting-for-agents), and cost. A finished row stays 30 s (setting `panelLingerMs`) and then
drops out; running rows stay. Only subagents that ran in this pi process show as rows: ones rebuilt from disk after a
`/reload` are not rows and are reached with `/subagents`. The panel hides when it is empty. Older subagents of the session are still reachable with
`/subagents`.

| Key | Effect |
|---|---|
| `↓` on an empty editor | focus the panel |
| `↓` / `↑` | move the selection (`↑` on the first row, or `Esc`, goes back to the editor) |
| `Enter` | open the selected subagent's screen, or on a script row the [script screen](#the-script-screen) |
| `x` | stop the selected subagent (nothing happens on a row that is not running) |
| `r` | restart the selected running subagent: it starts over with the same task (see **Restart** under [The subagent screen](#the-subagent-screen)) |
| `s` | on a script row: save the script as a workflow |
| `p` | on a running script's row: pause it, or resume it (see [Pause and resume](#pause-and-resume)) |
| `shift+x` | stop everything of the session: every background script and every running subagent |

While the panel has focus it takes `↑ ↓ Enter x r s p shift+x Esc` (`r`, `s` and `p` only on a row they apply to). Any other key (ctrl+c, ctrl+d, text) goes to pi as usual and gives the
focus back to the editor. In an in-memory session (`xpi --no-session`) the panel lists no rows, only a one-line notice that
subagents cannot be viewed.

`/subagents` lists every subagent of the session, newest first, including finished ones, ones from before a `/reload`
and ones from a resumed parent session, each with its model and effort. Pick one to open its screen, whose header also shows the model and effort. `/subagents stop` stops every running subagent and background script of the session (the notice counts them; with nothing running it says so), from anywhere. `/subagents worktrees` manages the worktrees kept by isolated agents (see [Worktree isolation](#worktree-isolation)). Any other argument warns.

### The subagent screen

It covers the whole terminal. It is a view: main's pi keeps running underneath, and your main session is not
switched. The header shows `‹ main (esc or /main)`, the subagent (`type(description)`, status, turns) and whether main
is idle or running. Below it is the subagent's conversation, drawn like pi draws a session: messages, tool calls with
their results, codemode scripts in full. While the subagent runs, the message it is writing streams in token by
token (text and thinking as they arrive, a tool call once its arguments are complete), taken from the child's rpc event
stream; finished messages come from its session file, which is read when the screen opens and when the child reports
that something was added (not on a timer). There is one input line at the bottom.

| Input | Effect |
|---|---|
| `PgUp` / `PgDn`, `↑` / `↓`, `Home` / `End` | scroll (`End` follows the live end) |
| `Esc` or `/main` | back to main |
| text + `Enter` | talk to the subagent (below) |
| `/stop` | stop the subagent |
| `/restart` | restart the running subagent from the start of its task |
| `/model` | pick a model from a list drawn on the screen (`↑↓`, `Enter`, `Esc`); `/model provider/id` names one |
| any other `/command` | says it is not available here |

There is no `main` row in the panel: the screen covers it, so use the back hint, `Esc` or `/main`.

**Talking.** Text you type goes to the subagent. If it is running, it is sent as a steer and the subagent takes it
after its current step. If it is finished, it is continued from its own session with its own prompt, tools and model,
and the reply streams in. After each exchange main gets a short note (what you said and the reply, cut at 2000
characters): as a steer if main is running, stored without starting a turn if main is idle.

**One process per subagent.** A subagent never runs two exchanges at once. If you type to a subagent that main's
script is resuming, your message waits in a queue and goes out when it is free (the screen says "queued"). The same
holds the other way round. A waiting resume does not hold one of the `maxConcurrent` slots.

**Stop.** `x` in the panel or `/stop` on the screen aborts a running subagent. The script's `Agent` call gets a
result, not an exception: `status: "failed"`, `error: "stopped by user"`. Turns and cost so far are kept. The
subagent is not lost: main can resume it with `resume`, or you can type to it.

**Restart.** `r` in the panel or `/restart` on the screen is for an agent that is stuck. Its child is stopped and
started again with the same prompt, agent type, model, schema and worktree. The agent keeps its id, name and row, and
turns and cost add up across the starts. The `Agent` call that waits for it keeps waiting and gets the last start's
result, so a script does not see a failure (a stop does count as one). The conversation of the earlier start is kept
next to the session as `<agentId>.restart-<n>.jsonl.bak`. Only an agent's first run can be restarted: a continued agent
(`resume`, `SendMessage`, typing to it) would lose its earlier conversation, and a fork starts from a copy of main
taken once. Changes the earlier start made to files stay.

**`/model`.** Changes the model of that subagent's conversation. A running subagent switches at once; the choice is
kept in its meta file for later exchanges. The agent definition file is not touched. Only models pi lists as available
are accepted.

### The script screen

Enter on a script row opens the script's screen, for a background `codemode` script, a workflow run and a script that
started agents alike. Like the subagent screen it covers the terminal, is a view only, and main keeps running underneath.
The header shows the script's name, its id (and run id), its state and elapsed time. Below, in order:

- **Calls**: the tool calls the script made, in order, with a status icon (`●` running, `✓` done, `✗` failed), the tool
  and its main argument (the `bash` command, an `Agent` description, a path) and the duration. Agent calls show too.
- **Log**: the script's `log()` lines.
- **Code**: the script's source (the first 20 lines).
- **Output of ...**: the live output of the call that runs now, else the last call: the last 200 lines it reported.
- **Result**, **Error** or **Stopped**: what the script returned or threw, once it ended.

It follows the live end and updates while the script runs. Calls and their output are kept in memory only, for the
session: nothing is added to the session file, and a script row that dropped out of the panel is gone from the screen.

| Key | Effect |
|---|---|
| `↑` / `↓`, `PgUp` / `PgDn`, `Home` / `End` | scroll (`End` follows the live end) |
| `x` | stop the script (and its agents), like `x` on its row |
| `Esc` | back to main |

These keys are fixed, like the panel's and the subagent screen's.

## Config

Optional, in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```jsonc
"subagent": {
  "models": { "haiku": "anthropic/claude-haiku-5-5" },  // per-alias overrides of the defaults above
  "defaultModel": "haiku",                         // default "haiku"; "inherit" follows the session model
  "toolMap": { "WebFetch": "mcp__fetch__fetch" },  // merged over the built-in map
  "maxConcurrent": 20,                             // running children per pi process; extra calls queue. The first session's value wins for the process
  "maxAgentsPerScript": 1000,                      // agents one script run may start; the next Agent call throws
  "childCodemode": "only",                         // "only" (default): children see only `codemode`; "inherit": direct tools
  "backgroundScripts": true,                       // false: a script that starts an Agent waits for it (no background scripts)
  "fork": true,                                    // false: no "fork" agent type and /subtask starts nothing
  "staggerStart": false,                           // true: siblings with the same model, tools and project wait (at most 5 s) for the first one's response to begin, then read its cached prompt. See "Prompt caching"
  "shutdownGraceMs": 10000,                        // how long a stopped child may take to shut down (SIGTERM) before SIGKILL; raise it for slow MCP servers
  "panelLingerMs": 30000,                          // how long a finished subagent stays in the panel (the pty tests shorten it)
  "stallMs": 600000,                               // a running subagent with no activity this long is marked stalled and you are told; 0: off
  "piCommand": "xpi"                               // unset: children run the same build as this process; XPI_SUBAGENT_TEST_PI also overrides
}
```

## Cost, caching and limits

### What the tool costs in every prompt

The tool's description, parameters and result type are part of each request of a session that has codemode on,
whether or not an agent is ever started. They are kept short for that reason: one line per parameter, a result type
that names the fields a script uses (the full result is in [The Agent tool](#the-agent-tool)), a short line per built-in agent, and a
`SendMessage` declaration that does not repeat the Agent result. (Leaving `SendMessage` out of the prompt altogether
was tried: Haiku then started a second agent in place of a message in 2 of 17 runs, against 0 of 17.) In the
evaluation (`npm run eval:delegation`) neither Haiku nor Opus started a subagent on its own in any task, small or
long, so this fixed cost is what most sessions pay for the tool.

### Prompt caching

Anthropic caches the start of a request (tools, then the system prompt, then the messages) and bills a later request
that begins with the same bytes at a tenth of the input price for that part. A child's system prompt is laid out so
that most of it is the same for every child of a project:

- **Head**, the same for every agent type and every checkout: a fixed preamble, then the project context (`AGENTS.md`
  and the other context files, the list of user-level skills).
- **Tail**, the child's own: working directory, the agent file's body, preloaded skills, agent memory, date.

Each part ends with a cache breakpoint. So the first child of a project writes tools, head and tail; a later child with
another agent type, in a worktree, or with a changed `MEMORY.md` reads tools and head and writes only its tail.
Measured on Haiku 5.5 with a 6.8k token prompt: the later child reads 96% of what the first one sent (89% after a
memory edit), and costs a sixth of what it did before this layout.

What sharing depends on:

- **Same tools.** Tools come first in a request, so a child with another tool set shares nothing with the others, not
  even the head. Agent types without `tools` / `disallowedTools` in their files share with each other; each distinct
  tool list is its own group.
- **Same model.** The cache is per model.
- **Paths.** A context file inside the project is shown relative to the working directory (`AGENTS.md`,
  `../AGENTS.md`), one under your home as `~/...`. An absolute path would differ in every worktree and break the
  shared head. For the same reason the skills list moves into the tail when a skill lives inside the project.
- **Time.** An entry lasts 5 minutes after its last use.

Anthropic allows four cache breakpoints per request. A child uses all four: last message, last tool, tail, head. An
extension that adds `cache_control` of its own to a child's request would go over the limit.

#### Siblings started at the same moment

A cache entry can be read only once the response of the request that writes it has begun. Three children started
together therefore write the same head three times. `subagent.staggerStart: true` avoids that: the first child of a
group (same model, same tools, same project) starts alone, and the others start when its first response begins. They
never wait more than 5 s, and not at all if a child of the group got a response in the last 4 minutes: a second batch
right after the first reads everything and starts at once.

Measured on Haiku 5.5, three agent types with the same tools, tools already cached:

| prompt | at once | staggered | cost | first batch takes |
|---|---|---|---|---|
| 4.3k tokens | 3 write 2.3k each | 1 writes 2.3k, 2 read 4.0k | 50% less | 1.9 s longer |
| 9.8k tokens | 3 write 7.8k each | 1 writes 7.8k, 2 read 9.5k | 58% less | 2.3 s longer |

It is off by default because it trades about 2 s per cold batch for money. Turn it on when you often start three or
more children at once and the prompt is large (a long `AGENTS.md`, many skills; roughly 8k tokens and up) or the
children run on an expensive model. With two siblings, a small prompt and Haiku the saving is a fraction of a cent.

`npm run test:subagent:cache` (by hand, real Haiku 5.5, see [Development](#development)) measures all of the above
in fresh repositories and fails when a later child reads less than 80% of the first one's prompt.

### Limits and memory

- The registry, panel and queues live in the memory of the pi process. After `/reload` or in a resumed session the
  registry is rebuilt from the meta files; a meta file left in `running` (pi died) shows as `stopped`. A meta file that cannot be read is skipped with a
  warning at session start.
- `maxConcurrent` (default 20) caps running children per pi process; extra calls and extra exchanges queue.
- Stopping a child: an rpc abort, then (after 2 s) SIGTERM, then SIGKILL after `shutdownGraceMs` (default 10 s; the child
  can use that time to close its MCP servers). Each child runs in its own process group (POSIX), and every signal goes to
  the whole group, so its MCP servers, bash tools and other descendants are stopped with it, and whatever is left of the
  tree when the child exits is cleaned up too. When pi itself exits (`process.exit`, SIGINT, SIGTERM, SIGHUP) every live
  group gets SIGTERM and, after the grace, SIGKILL from a small detached watchdog. A pi that is SIGKILLed or crashes
  cannot clean up: its children see their rpc stdin close and exit by themselves, but a descendant that ignores that can
  be left behind. Because children are in their own groups they no longer receive the terminal's ctrl+c directly; the TUI
  reads ctrl+c as a key and stops subagents as before. On Windows children keep the plain `child.kill` behaviour.
- Each child is a full `pi`, about 220 MB (see [Stress test](#stress-test)).
- An in-memory parent session keeps nothing on disk: no meta files, no viewing, no resume.

## Development

Run from `packages/xpi-coding-agent/`. Tests assert on structure and side effects, never on model wording, and never
start a test runner from inside a test.

```bash
npm run test:subagent         # offline: faults (scripted fake child), panel, worktree, memory. No model, no auth, free
npm run test:subagent:real    # in-process tool, real children (built xpi) on real haiku
npm run test:subagent:parent  # a real `xpi --mode rpc` parent: background scripts, /subagents stop
npm run test:subagent:tui     # interactive xpi in a pty (node-pty + headless xterm)
npm run test:subagent:evals -- --runs 3
npm run test:subagent:stress -- --calls 20 --limit 20
npm run test:subagent:cache   # what the prompt cache reuses: agent types, worktree, memory edit, staggered start
```

The first line is part of the package `test` script (root `npm test`); the others are run by hand and need
`npm run build` plus Anthropic credentials. Each sandbox sets `XPI_CODING_AGENT_DIR` to a temp dir that holds a copy of
`~/.pi/agent/auth.json` and nothing else, and a temp HOME, so your own setup never leaks in and the real agent dir is
never written. A sandbox refuses to start when the OAuth token in that file expires within 30 minutes: a copy that
refreshed it would log your own file out. Send one message in xpi and run again. `XPI_SUBAGENT_TEST_PI` points the real suites at another build; `XPI_SUBAGENT_COST_LOG=<file>` makes each
real test file append its sum of `usage.cost.total`. The tui tests are slow (about 25 to 30 s each) and cost roughly a cent
each; the whole real set costs a few cents. The fault suite covers what real xpi will not do on demand: malformed JSON
line, missing session header, crash with stderr, provider-error retries, a child that never settles or never exits, exact
usage arithmetic.

Real-model smoke test (costs well under a cent with haiku). Run it from the repo root after `npm run build`:

```bash
node packages/xpi-coding-agent/dist/bundle/cli.js -p 'Use the codemode tool. Script:
const a = await tools.Agent({ description: "list builtins", prompt: "List file names in src/builtin. quick", subagent_type: "Explore" });
const [b, c] = await Promise.all([
  tools.Agent({ description: "follow up", prompt: "What was the first file name you listed? One word.", resume: a.agentId }),
  tools.Agent({ description: "find tool", prompt: "Which file registers the Agent tool? quick", subagent_type: "Explore" }),
]);
return [a, b, c].map((r) => ({ status: r.status, agentType: r.agentType, model: r.model, cost: r.usage.cost.total, output: r.output.slice(0, 200), error: r.error }));
Reply with the returned JSON only.'
```

Expect three `completed` results on `anthropic/claude-haiku-5-5`, the second one an `Explore` answering from its
earlier turn.

### Evals (real model, haiku throughout)

```bash
npm run test:subagent:evals                       # every case once
npm run test:subagent:evals -- --runs 3           # repeat, for pass rates
npm run test:subagent:evals -- --only resume      # cases whose name contains "resume"
```

`evals/cases.ts` holds 22 cases. Fifteen call the tool in-process with real `pi` children (listing, read-only agents
cannot write, custom agent tools, resume, `maxTurns`, skills, context files vs `omitClaudeMd`, model aliases, a bad
model, no nesting, parallel runs, a steer that changes a running subagent's course, sent through the registry handle and graded by an exact token and a file that must not appear, a `schema` that returns a value, worktree isolation, and agent memory). The isolation case runs on a temp git repository: an isolated agent that writes a file keeps its worktree (the result has path, branch and the changed file, the file is in the worktree, the main checkout is clean), and an isolated read-only agent leaves no worktree or branch. The memory case uses `memory: project` in a temp repository (never `~/.claude`): run 1 saves a fact to `MEMORY.md`, and a fresh run 2 (no `resume`) answers from it. Seven start a real parent `xpi` on haiku (the built CLI, `--tools +codemode`). Five run in print mode and pass
`run_in_background: false`, since print mode would exit before a background result arrived: a given script, the model
deciding to delegate, the model asking for a structured result with `schema`, the model asking a named agent one
more thing (it must use `SendMessage` with the name, not a second agent), and a fork (main is told a code word and
must not put it in the fork's prompt; the fork answers from the copied conversation and its first request must read
main's prompt cache). Two run a long-lived `xpi --mode rpc` parent:
the background case (the script's `codemode` call must return "moved to the background", main's turn must end while the
agent still runs, the result message must start a new turn, and main's final answer must contain the token the script
computed) and the saved-workflow case (main must run a fitting saved workflow through the `Workflow` tool, and the
workflow's end message must reach it). Cases are graded from the structured result and side effects. `defaultModel` is pinned to `haiku` whatever
your settings say, and every case checks that every result (or, for the parent cases, every assistant message of the
parent and its children) ran on haiku. A case running over 5 minutes is aborted and its children stopped. Results go
to `evals/results/` (ignored by git; the numbers worth keeping go into this document).

Children are `xpi --mode rpc` and codemode-only by default. Last run (xpi 1.8.0 + spec 08, 2026-11-11, one run): 22/22, $0.011 in all, 32 s wall. Before that (xpi 1.5.1, 2026-11-10, one run): 22/22, $0.009; the new parent cases (structured result, saved workflow, named agent, fork) each 3/3 at $0.0015 to $0.002 a run. Before that (pi 1.5.0, v3b, `--runs 3`): 51/51 over the 17 cases of the time, $0.037 in all, 94 s wall; the background case 3/3 at $0.001 and about 14 s per run, the isolation case 3/3 at $0.0008 and about 11 s, the memory case 3/3 at $0.0011 and about 12 s. Earlier (v2): 39/39 over 3 runs for the 13 original cases, $0.027 in all; the steer case passed 11/13 over two batches (the miss: haiku batched both steps into one codemode script, so there was nothing left to steer; $0.0005 per run). The first version of the suite found a bug that the fake-pi
tests had missed (a run could go past `maxTurns` and still be reported `completed`), fixed since. Two checks depend on
the model or on timing and could fail without a bug: `maxTurns` needs haiku to call a tool on its first turn, and the
parallel case needs wall time under 0.7 × the summed run times.

#### Codemode-only vs direct tools

`node --experimental-strip-types test/subagent/evals/compare.ts --runs 5` runs the same two tasks with the default children (codemode-only) and with an agent that
lists `Read, Grep, Glob, Bash` under `childCodemode: "inherit"` (direct tools), 5 runs each, children in parallel:

| task | mode | correct | turns | wall s | cost |
|---|---|---|---|---|---|
| 5 reads + grep | codemode-only | 5/5 | 2.0 | 4.9 | $0.00122 |
| 5 reads + grep | direct tools | 3/5 | 2.6 | 8.1 | $0.00101 |
| search + read chain | codemode-only | 5/5 | 3.0 | 6.0 | $0.00067 |
| search + read chain | direct tools | 5/5 | 4.4 | 10.2 | $0.00074 |

Codemode-only saves turns and about 40% wall time. Cost is about equal (+21% on the first task, -9% on the second, on
fractions of a cent); direct tools got the first task wrong twice (haiku miscounted by hand).

### Stress test

```bash
npm run test:subagent:stress                     # haiku: 20 calls at once, then 40 (20 run, 20 queue)
npm run test:subagent:stress -- --calls 20 --limit 20
npm run test:subagent:stress -- --fake           # 200 calls against test/subagent/fake-pi.mjs: the extension's own overhead
```

Last run (Apple M5, 10 cores, 24 GB; pi 1.5.0, rpc codemode-only children; each call an Explore reading one file):

| | 20 calls | 40 calls (limit 20) | 200 fake calls (limit 20, 550 ms each) |
|---|---|---|---|
| completed (all on haiku, right answer) | 20/20 | 40/40 | 200/200 |
| wall | 5.3 s | 11.3 s | 6.1 s (ideal 5.5 s) |
| call latency p50 / p95 | 4.7 / 5.2 s | 7.9 / 9.4 s | 3.3 / 6.0 s |
| latency − child run p50 / p95 (queue wait + spawn) | 9 / 17 ms | 21 ms / 5.2 s | 2.8 / 5.4 s |
| peak children (sampled from `ps`) | 20 | 20 | 20 |
| peak RSS (all children) | 4.5 GB | 4.9 GB | 0.9 GB |
| cost | $0.0085 | $0.0059 | — |

The 40-call phase costs less than the 20-call one because it runs second: the shared system prompt is then in the
prompt cache. One earlier run sampled 21 children once (`ps` caught a short-lived extra process); the limit itself is a
semaphore and never lets more than 20 children start.

Each child is a full `pi` that loads your installed extensions, about 220 MB each. With the default limit of 20,
plan for about 4.5 GB of memory while a large fan-out runs. Lower `maxConcurrent` on smaller machines.

Design notes and tickets of the original extension: the pi-pipipi repository (`.scratch/`). The stress test and the
codemode-only comparison were measured there on pi 1.5.0 and have not been re-measured on xpi; the evals above were
rerun on xpi 1.5.1.

## Porting to another pi-based agent

[subagent-porting.md](subagent-porting.md) lists every pi contract the extension relies on (CLI flags, the rpc protocol,
session files, extension and TUI APIs), the file that relies on it, what still works without it, and how to run the
test suites against another binary (`XPI_SUBAGENT_TEST_PI`). To choose which parts to port (the Agent tool, names and
`SendMessage`, background, the panel, workflows) and see what each depends on, start from the menu in
[Porting xpi features](porting.md).
