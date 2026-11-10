# Subagents

The `subagent` built-in extension of xpi gives codemode scripts a Claude Code-compatible `Agent` tool. Each call runs
an agent definition in its own `xpi` subprocess and returns a structured result, so a script can run agents in parallel
and filter what reaches the model. Next to it: `SendMessage` to steer or continue an agent
([Names and SendMessage](#names-and-sendmessage)), and saved, rerunnable scripts with fan-out helpers, run as `/name` or
through the `Workflow` tool ([Workflows](#workflows)). In interactive xpi you can watch the subagents in a panel below the editor, open one in
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

## Enabling

The extension is built in (source: `src/extensions/subagent/`) and on by default; `-builtin:subagent` turns it off. The
tool has `codemode` exposure: the model reaches it only through the `codemode` tool, so enable codemode
(`xpi --tools +codemode`, or `"defaultTools": ["+codemode"]` in settings).

## Agent definitions

Existing Claude Code agent files work unchanged. Sources, highest priority first (each scanned recursively for `*.md`):

1. `.pi/agents/` (cwd up to the repo root, closest wins)
2. `.claude/agents/` (same walk)
3. `~/.pi/agent/agents/`
4. `~/.claude/agents/`
5. Built-in: `Explore`, `Plan`, `general-purpose`

The project walk never includes your home directory (`~/.pi/agent/agents` and `~/.claude/agents` are user sources only).
Scans skip dot directories and `node_modules`, go at most 6 levels deep and read at most 5000 entries per source.

Definitions are re-read on every call, so edits apply at once. The agent list in the tool's description is built at
session start: a new agent can be called right away but shows up in the description only after `/reload`.
Invalid files are skipped with a warning.

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
| `mcpServers`, `autoCompactWindow`, `permissionMode`, `hooks`, `background`, `initialPrompt`, `experimental` | Accepted, no effect yet (warning). |

## Model selection

**Subagents run on Claude Haiku 5.5 by default, not on your session's model.** The model is picked in this order:

1. `model` in the `Agent` call
2. `model` in the agent definition
3. `subagent.defaultModel` in settings, default `"haiku"`

The built-in agents (`Explore`, `Plan`, `general-purpose`) set no model, so they run on haiku too.

Values:

| Value | Model |
|---|---|
| `haiku` (default) | `anthropic/claude-haiku-5-5` |
| `sonnet` | `anthropic/claude-sonnet-5-5` |
| `opus` | `anthropic/claude-opus-5-5` |
| `fable` | `anthropic/claude-fable-5-1` |
| `inherit` | the parent session's current model. Only used when written explicitly. |
| anything else | passed to `pi --model` as is (`provider/id` or a pattern pi resolves) |

To follow your session's model everywhere, set `"defaultModel": "inherit"`. To use another provider for an alias,
remap it in `subagent.models`; the other aliases keep their defaults.

Without Anthropic credentials, haiku (and so every agent by default) fails with a provider error in `error`. Set
`defaultModel` to `inherit` or remap the aliases you use, for example:

```jsonc
"subagent": { "models": { "haiku": "<provider>/<cheap-model-id>", "sonnet": "<provider>/<model-id>" } }
```

## The Agent tool

Input (compatible with Claude Code's Agent tool): `{ description, prompt, subagent_type?, model?, effort?, resume?, run_in_background?, isolation?, schema?, name? }`.
`subagent_type` defaults to `general-purpose`. `isolation` is `"worktree"` or omitted (see [Worktree isolation](#worktree-isolation)); `schema` makes the
result a value (see [Structured output](#structured-output));
`name` names the agent (see [Names and SendMessage](#names-and-sendmessage)). Children run as `xpi --mode rpc` and get the prompt as a protocol message on stdin, not as a command
line argument, so prompts of any size work.

`run_in_background`: omitted, the first `Agent` call moves its codemode script to the background; `false` keeps the script in the foreground; `true` returns `status: "running"` at once and main gets a message when the agent ends (output cut at 8 KB), without moving the script.

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
get neither `Agent` nor `SendMessage`: agents do not message each other. With an in-memory parent session
(`--no-session`) names and steers work while the process lives, and nothing can be continued, as with `resume`.

## Workflows

A workflow is a codemode script that orchestrates subagents, saved to be rerun, in Claude Code's dynamic-workflow
format. Every script that can call `Agent` has these helpers over it, so a script main wrote can be saved unchanged:

| Helper | Meaning |
|---|---|
| `agent(prompt, opts?)` | One subagent. `opts`: `label` (the `description`; default: the prompt's first words), `schema`, `type` (`subagent_type`), `model`, `effort`, `isolation`; `stallMs` is accepted and unused. Resolves to the output text, or with `schema` to the value. Rejects when the agent failed; awaited directly, that ends the script with the error. |
| `parallel(tasks)` | Functions returning promises, or promises; all run at once. Resolves to their results in order, `null` for one that failed. |
| `pipeline(items, fn)` | `fn(item, index)` for every item at once (`maxConcurrent` queues the agents). Results in order, `null` for a failed item. At most 4096 items. |
| `phase(title, fn?)` | Names the agents started from here (or inside `fn`) for the panel. Phases are sequential: concurrent `phase()` calls share one current title. |
| `log(text)` | A progress line on the script's row in the panel. |
| `args` | The run's input; `undefined` in an ad hoc script. |

`tools.Agent` stays available for the full result. Unlike Claude Code, `Date.now()`, `Math.random()` and `new Date()`
work (there is no replay of a run). One script run may start at most `subagent.maxAgentsPerScript` agents (default
1000): the next `Agent` call throws.

### Saved workflows

`<name>.js` in `.pi/workflows/` (from the cwd up to the repository root, closest wins; trusted projects only) or in
`~/.pi/agent/workflows/`. The first statement is `export const meta = { name, description, phases? }`, a plain literal
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
- The model runs one with `tools.Workflow({ name, args })` (offered when at least one workflow can run; its
  description lists them). It returns the script id at once, and the result arrives as a message.
- `/workflows` lists the saved workflows and this session's workflow runs. Enter runs a workflow (no args) or lists a
  run's agents to open one.
- `s` on a script row in the panel saves that script: it asks for a name, a description and where (project or user),
  confirms an overwrite, and writes the script with a `meta` statement. The new workflow is a command at once.

The panel shows a workflow's run as `workflow <name> (S<n>)` with its last `log()` line, and its agents under their
`phase()` titles.

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

## Watching and talking to subagents

This part needs interactive pi. In `-p` mode only the `Agent` tool exists.

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

A row shows the type and description, turns, the last tool, and cost. A finished row stays 30 s (setting `panelLingerMs`) and then
drops out; running rows stay. Only subagents that ran in this pi process show as rows: ones rebuilt from disk after a
`/reload` are not rows and are reached with `/subagents`. The panel hides when it is empty. Older subagents of the session are still reachable with
`/subagents`.

| Key | Effect |
|---|---|
| `↓` on an empty editor | focus the panel |
| `↓` / `↑` | move the selection (`↑` on the first row, or `Esc`, goes back to the editor) |
| `Enter` | open the selected subagent's screen |
| `x` | stop the selected subagent (nothing happens on a row that is not running) |
| `shift+x` | stop everything of the session: every background script and every running subagent |

While the panel has focus it takes `↑ ↓ Enter x shift+x Esc`. Any other key (ctrl+c, ctrl+d, text) goes to pi as usual and gives the
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

**`/model`.** Changes the model of that subagent's conversation. A running subagent switches at once; the choice is
kept in its meta file for later exchanges. The agent definition file is not touched. Only models pi lists as available
are accepted.

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

**ctrl+b** moves a running foreground script to the background (for example a slow script that starts no agent). It
works only when the editor is empty; with text in the editor, or with no script running, ctrl+b stays cursor-left.

**Panel.** Each background script is a row (`S1`, state, agents running, elapsed, cost) with its agents indented below.
Finished rows linger like agent rows. `x` on a script row stops the script and all its agents (their calls return
`failed` / "stopped by user"; main gets the usual end message with the state `stopped`). `x` on an agent row stops only
that agent, and the script carries on. Several scripts can run at once; their agents share the `maxConcurrent` limit.

**Esc** aborts main's turn. It stops a script that is still in the foreground, as before, and leaves background scripts
running. **Ending the session** (quit, reload, `/new`, resume) stops every background script and detached agent; the
agents are marked stopped and stay resumable.

`subagent.backgroundScripts: false` turns all of this off: the extension does not track scripts or move them (the codemode
controller is simply never asked to), and a script that starts an agent waits for it, as in v2. Print mode (`xpi -p`) behaves the same way on its own, since pi exits when the
turn ends and a background result would be lost; there `run_in_background: true` waits too, and the tool description leaves the background rules out. Your `codemode` settings (`mode`, `inlineBudget`) are unaffected either way.

## Codemode-only children

By default a child sees only the `codemode` tool (pi's `codemode` extension in `only` mode, added with `-e`) and calls
its allowed tools from scripts. The `tools` / `disallowedTools` of the agent still bind inside those scripts, and a
`tools` list without `mcp__` entries still removes every MCP tool. The child's system prompt gets one extra line after
its preamble: "Use the `codemode` tool for all tool calls, and put independent calls in one script."

Why: fewer turns and less wall time. In the [comparison](#codemode-only-vs-direct-tools) below, codemode-only needed
2 to 3 turns where direct tools needed 2.6 to 4.4, at about the same cost.

Opt out:

- per agent: `codemode: false` in the agent file
- for everything: `"childCodemode": "inherit"` in `subagent` settings (direct tools, as in v1)

## MCP

MCP tools are excluded from a child whenever its agent file has a `tools` list without `mcp__` entries. An agent with
no `tools` list gets your normal tools and every installed extension, MCP included. `mcpServers` in an agent file is
still ignored (a warning).

## Limits and memory

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

## Prompt caching

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

### Siblings started at the same moment

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

## Config

Optional, in `.pi/settings.json` or `~/.pi/agent/settings.json`:

```jsonc
"subagent": {
  "models": { "haiku": "anthropic/claude-haiku-5-5" },  // per-alias overrides of the defaults above
  "defaultModel": "haiku",                         // default "haiku"; "inherit" follows the session model
  "toolMap": { "WebFetch": "mcp__fetch__fetch" },  // merged over the built-in map
  "maxConcurrent": 20,                             // running children per pi process; extra calls queue. The first session's value wins for the process
  "maxAgentsPerScript": 1000,                      // agents one script run may start; the next Agent call throws
  "childCodemode": "only",                         // "only" (default): children see only `codemode`; "inherit": v1 behaviour, direct tools
  "backgroundScripts": true,                       // false: a script that starts an Agent waits for it, as in v2 (pi's own codemode)
  "staggerStart": false,                           // true: siblings with the same model, tools and project wait (at most 5 s) for the first one's response to begin, then read its cached prompt. See "Prompt caching"
  "shutdownGraceMs": 10000,                        // how long a stopped child may take to shut down (SIGTERM) before SIGKILL; raise it for slow MCP servers
  "panelLingerMs": 30000,                          // how long a finished subagent stays in the panel (the pty tests shorten it)
  "piCommand": "xpi"                               // unset: children run the same build as this process; XPI_SUBAGENT_TEST_PI also overrides
}
```

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
node packages/xpi-coding-agent/dist/bundle/cli.js --tools +codemode -p 'Use the codemode tool. Script:
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

`evals/cases.ts` holds 21 cases. Fifteen call the tool in-process with real `pi` children (listing, read-only agents
cannot write, custom agent tools, resume, `maxTurns`, skills, context files vs `omitClaudeMd`, model aliases, a bad
model, no nesting, parallel runs, a steer that changes a running subagent's course, sent through the registry handle and graded by an exact token and a file that must not appear, a `schema` that returns a value, worktree isolation, and agent memory). The isolation case runs on a temp git repository: an isolated agent that writes a file keeps its worktree (the result has path, branch and the changed file, the file is in the worktree, the main checkout is clean), and an isolated read-only agent leaves no worktree or branch. The memory case uses `memory: project` in a temp repository (never `~/.claude`): run 1 saves a fact to `MEMORY.md`, and a fresh run 2 (no `resume`) answers from it. Six start a real parent `xpi` on haiku (the built CLI, `--tools +codemode`). Four run in print mode and pass
`run_in_background: false`, since print mode would exit before a background result arrived: a given script, the model
deciding to delegate, the model asking for a structured result with `schema`, and the model asking a named agent one
more thing (it must use `SendMessage` with the name, not a second agent). Two run a long-lived `xpi --mode rpc` parent:
the background case (the script's `codemode` call must return "moved to the background", main's turn must end while the
agent still runs, the result message must start a new turn, and main's final answer must contain the token the script
computed) and the saved-workflow case (main must run a fitting saved workflow through the `Workflow` tool, and the
workflow's end message must reach it). Cases are graded from the structured result and side effects. `defaultModel` is pinned to `haiku` whatever
your settings say, and every case checks that every result (or, for the parent cases, every assistant message of the
parent and its children) ran on haiku. A case running over 5 minutes is aborted and its children stopped. Results go
to `evals/results/`; the runs worth keeping are committed as a record.

Children are `xpi --mode rpc` and codemode-only by default. Last run (xpi 1.5.1, 2026-11-10, one run): 21/21, $0.009 in all, 31 s wall; the new parent cases (structured result, saved workflow, named agent) each 3/3 at about $0.0015 a run. Before that (pi 1.5.0, v3b, `--runs 3`): 51/51 over the 17 cases of the time, $0.037 in all, 94 s wall; the background case 3/3 at $0.001 and about 14 s per run, the isolation case 3/3 at $0.0008 and about 11 s, the memory case 3/3 at $0.0011 and about 12 s. Earlier (v2): 39/39 over 3 runs for the 13 original cases, $0.027 in all; the steer case passed 11/13 over two batches (the miss: haiku batched both steps into one codemode script, so there was nothing left to steer; $0.0005 per run). The first version of the suite found a bug that the fake-pi
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

Last run (Apple M5, 10 cores, 24 GB; pi 1.5.0, v2 rpc codemode-only children; each call an Explore reading one file):

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

Design notes and tickets of the original extension: the pi-pipipi repository (`.scratch/`).
The numbers in this document were measured there on pi 1.5.0 and have not been re-measured on xpi.

## Porting to another pi-based agent

[subagent-porting.md](subagent-porting.md) lists every pi contract the extension relies on (CLI flags, the rpc protocol,
session files, extension and TUI APIs), the file that relies on it, what still works without it, and how to run the
test suites against another binary (`XPI_SUBAGENT_TEST_PI`).
