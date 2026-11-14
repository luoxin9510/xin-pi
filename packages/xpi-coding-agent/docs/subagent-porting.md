# Porting the subagent extension to another pi-based agent

> **In the component menu.** This guide covers four entries of [Porting xpi features](porting.md): [the Agent
> tool](porting.md#subagents-agent-tool), [names and SendMessage](porting.md#subagents-names-and-sendmessage),
> [background](porting.md#subagents-background) and [the panel and screens](porting.md#subagents-panel-and-screens),
> plus the host side of [workflows](porting.md#workflows). Depends on: [codemode](porting.md#codemode) (or `Agent` made
> a direct tool), an rpc mode in your agent's CLI, child processes and session files. Platform notes, Linux first: each
> child runs in its own process group (`src/extensions/subagent/process-tree.ts`), so a stop or the parent's exit
> signals its whole tree, and worktree isolation needs `git` on the PATH. macOS behaves the same. On Windows there are
> no process groups and a child is killed alone.

The subagent extension is a built-in of xpi (xin-pi), written against pi 1.5.0 and since evolved with xpi. Many teams run their own agent
built on pi: a fork, a rebranded build, or an app on pi's SDK with its own extensions. This guide lists every pi
contract the subagent extension relies on, which file relies on it, and what still works if your agent differs. Work through it
top to bottom: each layer only needs the ones above it.

If your agent still loads pi extensions and still has pi's CLI, you may need no code changes at all: set
`subagent.piCommand` to your binary and run the checks in [Verify](#verify).

## The layers

| Layer | Needed for | Files |
|---|---|---|
| 1. Child process (CLI + rpc) | everything: each subagent is a child process | `src/extensions/subagent/resolve.ts`, `src/extensions/subagent/runner.ts` |
| 2. Session files | resume, `/subagents` after reload, the transcript on the subagent screen | `src/extensions/subagent/sessions.ts`, `src/extensions/subagent/registry.ts`, `src/extensions/subagent/subagent-screen.ts` |
| 3. Extension API (parent) | the `Agent` tool, config, the note to main | `src/extensions/subagent/index.ts`, `src/extensions/subagent/agent-tool.ts`, `src/extensions/subagent/config.ts` |
| 4. Codemode | calling `Agent` from scripts; codemode-only children; background scripts | `src/extensions/subagent/agent-tool.ts`, `src/extensions/subagent/index.ts` (the codemode-only child), `src/extensions/subagent/resolve.ts`, `src/extensions/subagent/background.ts` (host: `src/extensions/codemode/scripts.ts`, `addons.ts`) |
| 5. TUI | the panel, the subagent screen, `/subagents`, `/model` picker | `src/extensions/subagent/panel.ts`, `src/extensions/subagent/subagent-screen.ts`, `src/extensions/subagent/subagents-command.ts`, `src/extensions/subagent/script-screen.ts`, `src/extensions/subagent/talk.ts`, `src/extensions/subagent/stop-all.ts`, `src/extensions/subagent/live.ts` |

Layers 1-4 are the `Agent` tool. Layer 5 is only the UI: without it (a headless or web front end) the tool works, and
the UI is turned off by removing its wiring in `index.ts` (see [Without pi's TUI](#without-pis-tui)).

The layers are for reading, not for copying apart: the files import each other across them (`agent-tool.ts` imports
`background.ts`, `runs.ts` and `script-helpers.ts`, which import codemode's `scripts.ts` and `addons.ts`; `resolve.ts`
imports the MCP built-in's `config.ts`), so the directory is copied whole and a feature is turned off by a setting or
by removing the line in `index.ts` that wires it in. The [component menu](porting.md#subagents) names those lines.

## 1. Child process

The subagent extension starts every subagent as `<piCommand> --mode rpc ...` (`subagent.piCommand`; unset, the same
build as the running process: its Node and entry script, or a compiled binary itself,
`src/extensions/subagent/invocation.ts`), with stdin, stdout and stderr as pipes and the parent's cwd.

### Command-line flags (`src/extensions/subagent/resolve.ts`, `src/extensions/subagent/runner.ts`)

| Flag | Why |
|---|---|
| `--mode rpc` | JSONL commands on stdin, events on stdout |
| `--model <provider/id>` | the resolved model |
| `--thinking <level>` | `effort`, or the parent's level; must accept `off` |
| `--tools a,b` | the agent's `tools`, mapped (`Read→read`, `Glob→find`, ...). Without a list, `--tools +codemode`: the `+` prefix adds to the default tools and must be supported |
| `--exclude-tools a,b` | `disallowedTools`, and `mcp__*` when `tools` lists no MCP tool: entries are glob patterns |
| `--system-prompt <path>`, `--system-prompt-tail <path>` | the prompt in two cache regions, each written to a temp file by `runChild` (`src/extensions/subagent/runner.ts`): the head (a fixed preamble, the same for every agent type) and the tail (the agent body, skills, memory, environment block). `--system-prompt-tail` is a xin-pi core addition (`src/cli/args.ts`, `src/main.ts`). pi reads a path as the prompt's contents. If your agent takes the value as literal text, every child gets the path as its prompt: change `runChild` |
| `--mcp-config <json>` | the agent's inline `mcpServers` definitions as `{"mcpServers": {...}}`, which the child's MCP extension adds after `mcp.json`. Only those the agent's `scope` allows: a `project` agent file's (`AgentDefinition.scope`, set by discovery: `project`, `user`, `cli` or `builtin`) only when the parent's project is trusted |
| `--no-context-files` | `omitClaudeMd` |
| `--approve` / `--no-approve` | the child gets the parent's project trust |
| `--session-dir <dir> --session-id <id>` | a persisted child session (or `--no-session` for an in-memory parent) |
| `-e <path or source>`, `--strict-extensions` | the agent's `extensions`, one `-e` each (local paths absolute), and `--strict-extensions` with them so one that cannot load stops the child. Without `--strict-extensions` a failed package install only warns: the agent would run without its guard |
| (environment) `XPI_SUBAGENT_DEPTH=1`, `XPI_SUBAGENT_CHILD_CODEMODE=only` | every child loads the same subagent extension, which sees `XPI_SUBAGENT_DEPTH` and registers no `Agent` tool; for codemode-only children (layer 4) `resolve.ts` also sets `XPI_SUBAGENT_CHILD_CODEMODE=only`, and `index.ts` then registers `createCodemodeExtension({ mode: "only" })` in the child. No extra `-e` is passed |

The environment is the parent's plus `XPI_SUBAGENT_DEPTH=1`. The extension does nothing when that variable is set, so
children get no `Agent` tool. If your agent drops unknown environment variables before loading extensions, nesting
protection breaks.

If a flag has another name in your agent, change it in `resolveChild` (`src/extensions/subagent/resolve.ts`). If one is missing:

- no `--system-prompt`: agent prompts cannot replace the default; prepend them to the prompt instead (behaviour changes).
- no `--tools` / `--exclude-tools`: tool restrictions cannot be enforced. Do not ship read-only agents.
- no `--mcp-config`: inline `mcpServers` definitions cannot reach the child; agents keep the servers they name.
- no `--session-dir` / `--session-id`: no resume and no transcripts; use `--no-session` everywhere.

### rpc protocol (`src/extensions/subagent/runner.ts`)

One JSON object per line, LF only (JSON strings may contain U+2028, so the subagent extension splits on the byte `0x0a`).

Commands the subagent extension sends:

| Command | When |
|---|---|
| `{"id":"subagent-prompt","type":"prompt","message":...}` | start of every exchange |
| `{"type":"abort"}` answered by `agent_settled` with `aborted: true`; a child that starts a new conversation when no session file `*_<id>.jsonl` exists for its `--session-id` | stop, and restart (`r`, `/restart`: the session file is renamed to `<id>.restart-<n>.jsonl.bak` and the child is started again) |
| `{"type":"steer","message":...}` (no id; pi's `response` to it is ignored) | the user types to a running subagent, or main calls `SendMessage` to one |
| `{"type":"abort"}` (no id; response ignored) | maxTurns reached on a tool turn, the caller aborted, the user pressed `x` / `/stop` |
| `{"id":...,"type":"set_model","provider":...,"modelId":...}` | `/model` on a running subagent |

Then stdin is closed after `agent_settled`; the child must exit (the subagent extension sends SIGTERM, then SIGKILL, if it does not).
Note that pi in rpc mode also exits when stdin closes *during* a run, so stdin must stay open until `agent_settled`.

What the subagent extension reads:

| Record | Used for |
|---|---|
| `{"type":"response","id","success","error"}` | a failed `prompt` fails the run; `set_model` errors are shown |
| `message_start` / `message_update` (`assistantMessageEvent`: `text_*`, `thinking_*`, `toolcall_end`) | live streaming on the subagent screen (`src/extensions/subagent/live.ts`) |
| `message_end` with `message.role`, `content[]`, `usage`, `stopReason`, `errorMessage` | output, usage and cost, errors; `stopReason: "toolUse"` / `"error"` drive maxTurns and retries |
| `tool_execution_start` (`toolName`) | progress: last tool |
| `turn_end` | turn count, maxTurns |
| `agent_settled` (`aborted`) | end of the run |

`usage` must have `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost.{input,output,cacheRead,cacheWrite,total}`.
pi's rpc mode sends no session header (json mode does); the subagent extension does not need one.

If your agent has no rpc mode but has pi's json print mode (`--mode json -p <prompt>`), v1 of the subagent extension (commit `9d3f5a6`,
`main` before v2) used that: everything works except steer, `/model` on a running
subagent and `x` / `/stop` (they need a live stdin).

## 2. Session files

- A child started with `--session-dir D --session-id I` writes `D/<timestamp>_I.jsonl` (`src/extensions/subagent/subagent-screen.ts`
  finds it by the `_I.jsonl` suffix). A resume starts a new child with the same flags and must append to that file.
- Child sessions live in `<parent session dir>/subagents/<parent session id>/`, next to a meta file `<agentId>.json`
  that the subagent extension writes (agent type, description, model, status, usage, times). Your agent never reads these.
- A background script's end message or a detached agent's end message over 8 KB (UTF-8 bytes) is cut, and the full text
  is written to `subagents/<parent session id>/` next to the child sessions (a temp dir when the parent session is in memory).
- The subagent screen reads the file with pi's `parseSessionEntries` and `buildSessionContext` and draws messages with
  role `user`, `assistant` (content parts `text`, `thinking`, `toolCall`) and `toolResult`. A different session format
  only affects `transcriptParts` in `src/extensions/subagent/subagent-screen.ts`.

### Git (worktree isolation, `src/extensions/subagent/worktree.ts`)

`isolation: "worktree"` needs only `git` on the PATH (no pi contract); a host without git can drop it. The commands, all run
with `execFile`, never through a shell, and serialised per repository (git's own lock fails concurrent `worktree add`):

| Command | For |
|---|---|
| `git rev-parse --show-toplevel` | the checkout of the parent's cwd; failing means "not a git repository" (the call throws) |
| `git rev-parse --verify HEAD^{commit}` | the base commit; failing means no commits (the call throws) |
| `git rev-parse --path-format=absolute --git-common-dir` | agent memory's root: the parent of a `.git` common dir, i.e. the main checkout even from a linked worktree (else `--show-toplevel`) |
| `git cat-file -e <base>:<subdir>` | the parent's cwd subdirectory exists in the starting commit, so the child starts in it inside the worktree (else the root, with a warning) |
| `git rev-parse --git-path info/exclude` | where `/.pi/worktrees/` is appended once (relative to the root; inside a linked worktree it is the shared main `.git/info/exclude`) |
| `git status --porcelain` (main checkout) | dirty main checkout: a warning on the result |
| `git worktree prune`, `git branch --list subagent/<id>` | before a (re)create; an existing branch with a missing worktree is an error |
| `git worktree add -q -b subagent/<id> <root>/.pi/worktrees/<id> <base>` | create |
| `git ls-files --others --ignored --exclude-from=.worktreeinclude -z`, `git check-ignore -z --stdin` | `.worktreeinclude`: pattern match, then keep only gitignored files |
| `git status --porcelain -z --untracked-files=all --ignored`, `git symbolic-ref -q HEAD`, `git stash list --format=%gs`, `git rev-parse HEAD`, `git diff --name-only -z <base> HEAD`, `git log --format=%h\ %s <base>..HEAD` | changed or not, and what changed, after the child has exited. Changed also when gitignored files were made (not `.pi/`, not unmodified `.worktreeinclude` copies), HEAD is not `refs/heads/subagent/<id>`, or a stash entry was made on that branch (the outcome then has a `note`) |
| `git worktree remove --force <path>`, `git branch -D subagent/<id>` | remove an unchanged worktree; also `/subagents worktrees` removal of a picked one |
| `git worktree list --porcelain`, `git merge-base <worktree HEAD> <main HEAD>` | `/subagents worktrees`: the entries after the first (the main checkout) whose path is under `<root>/.pi/worktrees/` (any branch or detached), and the fork point used as the base for the change summary |

Verified on git 2.54: `worktree add` works from a repository that is itself a linked worktree; with no commits `HEAD` does
not resolve (`fatal: invalid reference: HEAD`); the exclude path from `--git-path` is the shared one in a linked worktree.
The child gets the worktree as its cwd (`spawn` option) and in the prompt's `Working directory:` line; its session files
stay in the parent's `subagents/<parent session id>/`. The meta file `<agentId>.json` gains
`worktree: { root, path, branch, base }`.

Failure behaviour worth copying. The per-repository lock is in-process only: two pi processes working in one repository
are not serialised against each other (git's own lock then fails the second `worktree add`). Settling at the end of an
exchange degrades instead of losing the run: if a git command fails there, the worktree is reported as kept with a result
warning (path and branch given); a worktree whose directory vanished is reported as removed, with a warning, and its
branch is left alone. A worktree removed by `/subagents worktrees` gets `removed: "user"` in the meta file's `worktree`
object, and a resume of it throws naming the path instead of recreating it. Only an unchanged worktree removed by the
exchange itself is recreated on resume. A foreground call aborted while its worktree was kept throws an error whose
message ends with the kept path and branch.

### Agent memory (`memory` in the agent file, `src/extensions/subagent/resolve.ts`)

No pi contract; the host needs Read, Write and Edit tools (mapped through `toolMap`) and the same two `rev-parse`
commands as above (`--show-toplevel`, `--git-path info/exclude`). Directories: `~/.claude/agent-memory/<name>/`,
`<repository root of the parent cwd>/.claude/agent-memory/<name>/`, `.../.claude/agent-memory-local/<name>/` (outside a
repository the parent cwd replaces the root and no exclude is written; an agent file whose `name` is unsafe as a directory name is skipped when it sets `memory`). Created
with `mkdir -p` when the child is resolved. Local scope appends `/.claude/agent-memory-local/<name>/` to the info/exclude
file once. The prompt gets a `# Persistent memory` section after the skills and before `# Environment`: the directory, our
instructions (read-only wording when Write or Edit is denied) and the head of `MEMORY.md` (first 200 lines, then at most
25000 bytes, a cut multibyte character dropped whole, plus a truncation note). `Read`, `Write`, `Edit` are added to the
`--tools` list unless `disallowedTools` denies them; Write or Edit denied means read-only memory plus a result warning.

## 3. Extension API (parent side)

| API | Where | If missing |
|---|---|---|
| `pi.registerTool({ name, parameters, outputSchema, exposure: "codemode", execute })`; `execute` returns `content`, `details`, `structuredContent`, `usage`, `isError` | `src/extensions/subagent/agent-tool.ts` | no tool: nothing works |
| `pi.on("session_start", (event, ctx))` | `src/extensions/subagent/index.ts` | config and discovery never run |
| `pi.on("session_shutdown", (event, ctx))` (emitted on quit, reload, /new, resume and fork, before the runtime is torn down; rpc SIGTERM emits it with reason "quit") | `src/extensions/subagent/index.ts` | background scripts and detached agents keep running past the session; with it they are stopped (agents `stopped`, resumable) and main is sent nothing |
| `pi.on("agent_start" / "agent_end", (event, ctx))` | `src/extensions/subagent/index.ts` | the subagent extension keeps the latest `ctx` from these and `session_start`; without them the note to main and main's state on the screen use the context of session start, which a reload replaces |
| `pi.getSettings()` keeping the unknown `subagent` key | `src/extensions/subagent/config.ts` | defaults only (replace with your own config source) |
| `pi.registerCommand(name, { handler(args, ctx: ExtensionCommandContext) })`, `pi.getCommands()` | `/subagents`, `/workflows`, one `/<name>` per saved workflow | no commands; a workflow could still run through the Workflow tool |
| `ctx.createToolContext(toolCallId)` on the command context; a nested call with no assistant message in the session runs against an empty one | `src/extensions/subagent/workflow-run.ts` (`/<name>` starts a workflow) | `/<name>` cannot start a script; use the Workflow tool from a model turn |
| `pi.sendMessage({ customType, content, display }, { deliverAs: "steer" })`; `{ triggerTurn: true, deliverAs: "steer" }` for a background script's or detached agent's result | the note to main, the background script message | main is not told about your exchanges |
| `ctx.cwd`, `ctx.model {provider,id}` (may be undefined: `inherit` then throws), `ctx.thinkingLevel`, `ctx.isProjectTrusted()`, `ctx.isIdle()` | `src/extensions/subagent/agent-tool.ts`, `src/extensions/subagent/index.ts` | `inherit`, thinking and trust mirroring, the note's delivery |
| `ctx.hasUI`, `ctx.ui.notify` | `src/extensions/subagent/index.ts` | gates the panel, discovery warnings and background scripts; false = tool only, no UI, scripts stay in the foreground (print mode exits at turn end) |
| `ctx.sessionManager.getSessionFile()` / `getSessionId()` | sessions, registry | children run `--no-session`, no resume. The session dir must be writable: the subagent extension writes `subagents/` there and rebuilds its list from it on every `session_start` (startup, reload, resume, new) |
| `ctx.modelRegistry.getAvailable()` | `/model` picker | type `/model provider/id` only |
| `SessionManager.forkFrom(file, cwd, dir, { id })` and `appendMessage()` on the result; a session that stores its system prompt and tool declarations, and a child that continues it with `--session-dir` / `--session-id` | fork (`src/extensions/subagent/fork.ts`) | set `subagent.fork: false`; everything else works |
| `pi.registerFlag("agents", { type: "string", validate })`, `pi.getFlag("agents")` | `--agents` (`src/extensions/subagent/discovery.ts`, `parseCliAgents`, `setCliAgents`) | no agents from the command line; agent files still work. Without `validate` (a xin-pi core addition, `agent-session-services.ts`), a value that does not parse is only reported by `session_start` and the run goes on without those agents |
| `loadMcpConfig({ agentDir, cwd, projectTrusted })` from the MCP built-in (`src/extensions/mcp/config.ts`) | the configured server names behind an agent file's `mcpServers` (`src/extensions/subagent/resolve.ts`) | pass the names yourself (`ResolveOptions.mcpServers`), or every name warns as not configured |
| The MCP built-in's `--mcp-config <file or JSON>` in the child (`src/extensions/mcp/config.ts`, `parseMcpConfigFlag`) and `validateMcpServerConfig` (`src/core/mcp-servers.ts`) | an agent's inline `mcpServers` definitions: validated at discovery (`definition.ts`), passed to the child as JSON (`resolve.ts`, `inlineServers`) | inline definitions cannot reach the child; keep only names, and configure those servers in `mcp.json` |

Imports: `xpi-coding-agent`, `xpi-tui`, `xpi-ai` (only `StringEnum` and types), plus `typebox` and `yaml`. xpi provides its
own packages to extensions at load time. If your fork publishes them under other names, replace the import paths
(`grep -rn "xpi-" src/extensions/subagent`), or alias them in your extension loader. (Extensions written for upstream pi
that import `@earendil-works/*` are not supported by xpi; see [xin-pi.md](../../../docs/xin-pi.md).)

## 4. Codemode

- `Agent` is registered with `exposure: "codemode"`: the model reaches it only from codemode scripts
  (`tools.Agent(...)`). The codemode unit is needed to build the extension either way (its controller and add-ons are
  imported). To expose `Agent` as a direct tool, change `exposure` in `agent-tool.ts`, `send-message-tool.ts` and
  `workflow-tool.ts` and drop the codemode examples in [subagent.md](subagent.md); that path is not tested.
- Codemode-only children (`subagent.childCodemode: "only"`, the default) get `XPI_SUBAGENT_CHILD_CODEMODE=only`
  (`src/extensions/subagent/resolve.ts`). The child's own subagent extension sees it and registers
  `createCodemodeExtension({ mode: "only" })` (`src/extensions/subagent/index.ts`, imported from
  `src/extensions/codemode/index.ts`). The host then skips its built-in codemode extension (an extension that registers
  the same tool replaces a built-in one). Your agent must load the subagent extension in children and pass the variable
  through; without that or the replacement rule, set `"childCodemode": "inherit"`: children get direct tools, as in v1.
- Background scripts. In xpi the codemode built-in owns the mechanism and the subagent extension owns the policy; the
  `codemode` tool is not wrapped, proxied or replaced. The host must provide:
  - A script controller exported from the package index, `codemodeScripts` (`src/extensions/codemode/scripts.ts`): `owner`,
    `list`, `background`, `backgroundAll`, `stop`, `stopAll`, `subscribe`, plus the `beginCodemodeScript` hook the executor
    calls for each script. `executeCodemode` registers every script, links the turn's abort signal only while the script is
    in the foreground, races the script against "moved to background", and on a move returns early with
    `details.background` / `details.scriptId`; the real end is reported through the script's `onEnd`.
  - Nested tool call ids `<codemode call id>/<n>`; the owner of an `Agent` call is found by that prefix
    (`codemodeScripts.owner`).
  - `ctx.detachNestedCalls()` / `ctx.releaseNestedCalls()` on the tool context (`NestedToolCallRunner.detach/release` in
    `src/core/nested-tool-calls.ts`): a detached scope survives `takeRecord()` and `clear()` at `agent_end`, so nested ids
    keep counting and later calls and their usage keep going into the same recorder.
  - `ctx.executeTool` working after the tool call returned (the script keeps using the original context).
  - `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" })`: the host routes it itself (streaming: steer; idle or
    compacting: a run starts, deferred while the previous run settles), so a result is never only appended while main
    sleeps. A throwing delivery is logged with `console.error`, never rethrown.
  - `ctx.ui.onTerminalInput` for ctrl+b (layer 5; without a TUI, scripts move to the background only by starting an
    `Agent`).
  - For agents that outlive their script (spec 09): the sandbox option `outlives` (`packages/xpi-codemode`), the add-on
    fields `outlives(target, sessionId)` and `describe(sessionId)` (`addons.ts`, asked by `execute.ts` and `tool.ts`;
    the codemode extension records the session id at `session_start`), and `codemodeScripts.keep(scriptId, ...)` /
    `release(scriptId)` (by script id: call ids can be reused) with the `onKeep` event: a script that ends with `Agent`
    or `SendMessage` calls still running stays registered (state `ended`) until the subagent extension releases it when
    its group has ended. Without them a script's end cancels its agents, as before, and the description says so.

  The extension connects its registry to `codemodeScripts.subscribe` at `session_start` (`src/extensions/subagent/background.ts`);
  the policy (move on the first `Agent` call unless `run_in_background: false`, the end message to main) is in the
  extension. `run_in_background: true` agents run detached from the call's signal and report with the same
  `sendMessage` delivery. Esc aborts main's signal, which stops only foreground scripts; session shutdown stops every
  script and detached agent. Without a controller, set `subagent.backgroundScripts: false`: scripts stay in the foreground
  (v2 behaviour). The file-by-file list of core changes is in [xin-pi.md](../../../docs/xin-pi.md).
- Workflow helpers (`agent`, `parallel`, `pipeline`, `phase`, `log`) come from a codemode add-on
  (`codemodeAddons` in `src/extensions/codemode/addons.ts`): a one-line prelude prepended to the script and two host
  globals, `__subagentAgent` (runs `Agent` through the script's own tool path, carrying the phase in an
  `AsyncLocalStorage`) and `__subagentNote`. Without add-ons, scripts keep `tools.Agent` only, and saved workflows
  that use the helpers fail with `agent is not defined`.
- Runs, relaunch and pause (`src/extensions/subagent/runs.ts`, `background.ts`) need nothing more from the host: the
  run file lives next to the subagent sessions, a relaunch is decided inside the `Agent` tool (which answers a call
  without starting a child), and a pause holds the `Agent` call before it starts anything. They rely on what is listed
  above: nested call ids `<script id>/<n>` in call order, and the script controller's `onEnd`.
- With codemode-only, an agent's `tools` list must also bind inside scripts (a script calling a tool outside `--tools`
  gets "does not exist"). Check with `test/subagent/real/09-codemode-only.test.ts`.

## 5. TUI

Only needed for the panel and the subagent screen.

| API | Where | Notes |
|---|---|---|
| `ctx.ui.setWidget(key, (tui, theme) => Component, { placement: "belowEditor" })`; `tui.requestRender()` | the panel | components implement `render(width)` and `invalidate()` |
| `ctx.ui.onTerminalInput(handler)` returning `{ consume: true }` | ↓ into the panel, panel keys, ctrl+b (`scripts.backgroundAll`; passes through as cursor-left when the editor has text or no script runs) | the handler gets raw input including kitty key **releases**; the subagent extension ignores them with pi-tui's `isKeyRelease`. If your terminal layer sends other event encodings, check `handleKey` in `src/extensions/subagent/panel.ts` |
| `tui.focusedComponent` (not public API) | the panel acts only while the editor (a component with `getText`) has focus | if your TUI renames it, the panel may steal keys from pickers: fix `focusedIsEditor` in `src/extensions/subagent/panel.ts` |
| `ctx.ui.getEditorText()` | ↓ only on an empty editor; ctrl+b moves foreground scripts to the background only when the editor is empty | |
| `ctx.ui.custom(factory, { overlay: true, overlayOptions })`, full width and height; `tui.terminal.rows` | the subagent screen (it draws exactly the terminal's rows; its commands: `/main`, `/model`, `/stop`) | must not stop main's run; pi's `switchSession` would, so it is not used. The screen is `Focusable` and gets keys through `handleInput` (pi filters key releases for components) |
| `ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.notify`, `ctx.cwd` | `/subagents`, `/subagents worktrees` (the confirm names what removal loses), notices | |
| pi components `AssistantMessageComponent`, `UserMessageComponent`, `ToolExecutionComponent`, `getMarkdownTheme`; pi-tui `Input`, `Text`, the `TUI`, `Component` and `Focusable` types, `matchesKey`, `isKeyRelease`, `truncateToWidth` | the transcript, the screen, the panel | |
| `theme.fg/bg/bold`; colour names `accent`, `success`, `error`, `warning`, `muted`, `dim`, `toolTitle`, `selectedBg` | panel and screen | a theme must define them (pi's built-in themes do) |
| raw 256-colour SGR escapes `\x1b[38;5;<n>m` ... `\x1b[39m` (palette in `src/extensions/subagent/color.ts`) | agent `color`: panel row label and screen header | the host's TUI must pass SGR through; without it the label shows escape text, so drop the `color` field |

### Without pi's TUI

Web or headless front ends: the `Agent` tool, resume, codemode-only and queueing all live below the UI. Leave out
`installPanel` and the `/subagents` registration in `src/extensions/subagent/index.ts`. The registry (`src/extensions/subagent/registry.ts`) exposes what a UI
needs: `list(parentSessionId)`, `get(id)`, `subscribe(fn)`, `watch(id, fn)` for live rpc events, `stop(id)`,
`setModel(id, model)`, and `talkTo` in `src/extensions/subagent/talk.ts` for steer / continue. A web panel can be built on those.

## Models and credentials

Aliases default to Anthropic models (`haiku` → `anthropic/claude-haiku-5-5`, the default for every subagent). If your
agent uses another provider or naming, remap them in settings; no code change:

```jsonc
"subagent": {
  "models": { "haiku": "<provider>/<cheap-model>", "sonnet": "<provider>/<model>", "opus": "<provider>/<big-model>" },
  "piCommand": "<your agent's binary>"
}
```

## Verify

From `packages/xpi-coding-agent/` of an xin-pi checkout, with your agent's binary:

```bash
npm run test:subagent                                              # runner logic against a scripted fake child; no model, no binary
XPI_SUBAGENT_TEST_PI=/path/to/your-agent npm run test:subagent:parent  # background scripts in a real rpc parent (needs haiku)
XPI_SUBAGENT_TEST_PI=/path/to/your-agent npm run test:subagent:real    # real children on your binary (needs Anthropic haiku)
XPI_SUBAGENT_TEST_PI=/path/to/your-agent npm run test:subagent:tui     # your binary's interactive TUI in a pty
XPI_SUBAGENT_TEST_PI=/path/to/your-agent npm run test:subagent:evals   # real-model evals
```

The real, tui and eval suites call Claude Haiku 5.5 and expect `~/.pi/agent/auth.json` (they copy it into a temp agent
dir, `XPI_CODING_AGENT_DIR`). If your binary reads its config elsewhere, adapt `sandbox()` in
`test/subagent/real/helpers.ts` and the env in `test/subagent/tui/harness.ts`.

Read failures by layer:

| Layer | Tests |
|---|---|
| 1. Child process | `test/subagent/real/01-tracer-bullet`, `02-agent-files`, `03-model-selection`, `04-tools-and-flags` (flags such as `--tools`, `--exclude-tools`, `--no-context-files`), `05-skills`, `06-run-outcomes`, `08-concurrency-and-config`, `11-talk` (steer), `12-stop-and-model` (abort, set_model); `test/subagent/faults/` (stream handling) |
| 2. Session files | `test/subagent/real/07-sessions-and-resume`, `10-registry` |
| 4. Codemode | `test/subagent/real/09-codemode-only`; `test/subagent/parent/` (a real parent `xpi --mode rpc` : `01-background-script` early return, new turn from the result message and nested ids; `02-run-in-background` `false`/`true`; `03-edges` errors, long results, steer delivery, stop, shutdown) |
| 5. TUI | `test/subagent/panel/` (no pi; `scripts.test.ts` for script rows and `x`), `test/subagent/tui/05-panel`, `06-screen`, `07-talk`, `08-stop-model`, `09-streaming`, `10-script-panel` (script rows, `x`, ctrl+b) |

Quick manual check that a binary speaks the rpc protocol (one haiku call):

```bash
{ printf '%s\n' '{"id":"p","type":"prompt","message":"Reply OK"}'; sleep 15; } \
  | /path/to/your-agent --mode rpc --no-session --model anthropic/claude-haiku-5-5 \
  | grep -oE '"type":"(response|message_end|agent_settled)"' | sort | uniq -c
```

Expect one `response` (for `p`, with `"success":true`), `message_end` records (user and assistant), and one
`agent_settled`; the process exits when stdin closes after the `sleep`. Without the `sleep`, stdin closes at once and
pi exits before answering.

## Agent teams

Optional and experimental; see [Agent teams](subagent.md#agent-teams) for behaviour, and the [menu entry](porting.md#subagents-agent-teams)
for what to switch on and off. Everything here is in `src/extensions/subagent/`. A team is the lead (the session) plus
teammates, which are ordinary subagent children; what is added is files that every process of the team reads and writes, and
a deliverer in the lead that turns mailbox entries into steers and new exchanges.

### The pieces

| piece | file | what it does |
|---|---|---|
| the setting | `team-config.ts` | `agentTeams` (`true` or `{ enabled, maxTeammates, taskRetentionDays }`) or `XPI_EXPERIMENTAL_AGENT_TEAMS=1`; read at `session_start` |
| the team | `team.ts` (`Team`, `teams`) | `config.json`, members and their states, the cap, the loop cap, shutdown, closing; the deliverer |
| the file layer | `team-files.ts` | `writeAtomic`, `withLock`, `withLockFile`, `pidAlive`, mailboxes (`appendEntry`, `takeEntries`, `putBack`, `entryProblem`) |
| messages | `team-send.ts`, `team-text.ts` | `SendMessage` between members, the envelope, idle notices, the prompt sections |
| the named call | `team-start.ts` | what an `Agent` call with `name` does with teams on, and its refusals |
| tasks | `team-tasks.ts`, `team-task-tools.ts`, `team-lead-tasks.ts` | the task files, the four tools, the lead's side |
| events | `team-hooks.ts` | `agent-teams:teammate_idle`, `task_created`, `task_completed` with `block` and `hold` |
| UI | `team-ui.ts`, `panel.ts`, `subagent-screen.ts` | rows, the teammate screen (typing, Esc), `/tasks` |

Port them in this order, running the matching tests (below) after each: file layer, team and deliverer, messages, tasks,
events, UI. The UI is optional; without it the tools still work.

### What the host must provide

- **Event bus** (`pi.events`): `emit` calls every handler synchronously (up to its first `await`), so a handler can answer
  during `emit` by calling `block(feedback)` or `hold(promise)` on the payload. `team-hooks.ts` reads the answers right after
  `emit` returns; a bus that calls handlers later would make every answer count for nothing.
- **Mode** (`ctx.mode`): teams are on only for `"tui"` (not print, not rpc, where `hasUI` is true too), and only in a saved
  session (not `--no-session`, where nothing can be continued).
- **rpc in the child**: `steer` (a running teammate takes a message), `abort` (stop, and Esc's interrupt), the `message_end`
  event of the user message (to know that a steer was taken), and the settle event of the exchange. If the child settles
  before it takes a steer, `handle.send` returns false and the lead keeps the messages for the next exchange.
- **File system**: exclusive create (`O_EXCL`, `wx`) for lock files, rename onto an existing name as an atomic replace, in
  one directory (the temporary file is a dot file next to its target), and modes 0600 and 0700.
- **Process liveness**: `kill(pid, 0)`; `EPERM` counts as alive.
- **Child environment**: `XPI_TEAM` (the team name), `XPI_TEAM_MEMBER`, `XPI_TEAM_DIR`, `XPI_TEAM_TOOLS` (`codemode` or
  `direct`: whether the child has codemode). `registerTeamTools(pi)` in `index.ts` adds `SendMessage` and the four task tools
  when they are set; the lead adds `+SendMessage`, `+TaskCreate`... to an explicit `--tools` list.
- **Extension API**: a custom message with `triggerTurn` (idle notices and messages for the lead), `before_agent_start`
  with mutable `systemPromptOptions.sections` (the lead's team section), `ctx.abort()` in a tool (after an approved
  shutdown the teammate ends its own turn).

### On-disk formats

Under `<agent dir>` (`getAgentDir()`):

```
teams/session-<session id>/config.json        the lead writes it; teammates read it
teams/session-<session id>/inboxes/<name>.json  one mailbox per member, `lead` included
tasks/session-<session id>/<id>.json          one file per task
tasks/session-<session id>/next               the id counter (a decimal number)
tasks/session-<session id>/.lead              { "pid": ... } while the lead runs
tasks/session-<session id>/.lock, next.lock, <id>.json.lock
```

- **`config.json`**: `{ team, leadSessionId, leadPid, members: [{ name, agentId, agentType, status, since,
  shutdownRequested? }] }`. `status` is `running`, `queued`, `idle`, `stopping` or `stopped`. The lead is a member
  (`name: "lead"`, `agentType: "team-lead"`). Only the lead writes it; writes are queued in order and atomic.
- **Mailbox**: one JSON array of entries `{ id, from, to, text, summary?, kind, at, approve? }`; `kind` is `message`, `idle`,
  `shutdown_request`, `shutdown_response` or `held`. Names are `lead` or valid agent names, `id` matches
  `[A-Za-z0-9_-]{1,64}`. The mailbox is a trust boundary: `entryProblem` validates each entry on read and the deliverer drops
  (and reports) invalid ones, or the whole file if it is not an array. A send counts once `appendEntry` has returned. An
  empty mailbox is `[]` and is not locked when read (locking writes files in the watched directory).
- **Task file**: `{ id, subject, description, status, owner?, blockedBy, result?, createdBy, createdAt, updatedAt }`;
  `status` is `pending`, `in_progress` or `completed`; ids match `[1-9][0-9]{0,8}`. `taskProblem` validates on read.
- **Locks**: `<file>.lock` holds `{ pid, at }`, created exclusively, retried every 25 ms for up to 2 s, then `busy`. A lock
  is stale when its pid is dead or it is older than 30 s (an unreadable lock file: older than 1 s). A stale lock is removed
  under `<lock>.takeover`, itself an exclusive create, and only if it still holds the content that was judged stale. A bare
  rename of the stale lock is wrong: a second taker could rename the fresh lock its rival had just made, and for a moment
  nobody would hold it. Task changes take the task's own lock; creating a task or changing `blockedBy` also takes the
  directory's `.lock` (so two writers cannot make a cycle), and the counter takes `next.lock`. The order is always the
  directory lock first, then `next.lock` or the task's.
- **`.lead`**: the pid of the running lead, refreshed when the lead uses the list. Retention (`taskRetentionDays`, checked
  against the newest file of each `session-*` directory) never removes a directory whose lead is alive, with or without a
  team. At the end of a session `teams/session-<id>/` is removed and `tasks/session-<id>/` stays. A directory whose lead is
  dead (a crash) is swept at the next team start (`sweepStaleTeams`).

### The deliverer (`Team.start`, `pass`, `steer`)

The lead watches `inboxes/` and, per pass, takes each mailbox's entries: a running teammate gets a `steer` message, an idle one
a new exchange (entries that arrive together are joined), the lead's own mailbox becomes a custom message with `triggerTurn`.

- `fs.watch` on the directory, plus a poll every 1 s (`POLL_MS`); the poll is the guarantee, the watch only makes delivery fast.
- The watch handler ignores names that start with `.` or do not end in `.json`, so lock files and temporary files are not news.
- It ignores a mailbox the lead's own pass rewrote in the last 200 ms (`SELF_WRITE_MS`, `selfWrites`).
- Events are debounced: one pass 50 ms after the first event of a burst (`WATCH_DEBOUNCE_MS`). Passes run one at a time.
- Taking an empty mailbox does not lock it (see above).
- A refused steer (`handle.send` returns false: the child settled on its way out) puts the entries back (`putBack`) and
  remembers that child handle (`steerRefused`); the next pass leaves that member alone until a new exchange starts.

Why: inotify does not coalesce, so every create and remove of a lock file or temporary file in the directory is an event.
Taking a mailbox writes exactly such files, so a watcher that reacted to them, or to its own rename, made every pass cause
the next, and the lead spun at full speed (found on Linux). Three filters together stop it: only `*.json`, ignore own writes
for 200 ms, and a debounce that bounds the rate whatever else writes. A port that watches the same directory must keep all
three. `/tasks` re-reads the task files on a timer instead of watching `tasks/`, for the same reason.

A teammate woken 5 times in a row by other teammates' messages (`MAX_WAKES`) is not woken again until a message from the lead
or the user; the lead is told. `maxTeammates` counts members that are not `stopped`.

### The extension events contract

`agent-teams:teammate_idle` (in the lead, when an exchange ends), `agent-teams:task_created` and `agent-teams:task_completed`
(in whichever process makes the change; a teammate's process loads the extensions xpi discovers). The payload carries the data
plus `block(feedback)` and `hold(promise<string | undefined>)`; a string from a hold blocks. `block` refuses the step and sends
the feedback; a `hold` is awaited up to 5 minutes, then the step is allowed with a warning. At most 3 `teammate_idle` blocks in
a row per teammate; after that handlers only observe. Rules for a port: run the event before taking any lock (a hold may take
minutes), and check the step again once the locks are held, since the list may have changed meanwhile; answers given after a
handler's first `await` count for nothing.

### Linux and macOS

Linux is the reference: `fs.watch` on a directory is inotify, fast and exact, and a lock is a file, not `flock`. macOS
`fs.watch` is FSEvents, which coalesces events and may report them late or with no file name (the handler treats a missing
name as news). Never rely on the watch alone: the 1 s poll must stay, and tests that wait for delivery should allow a poll
interval. The self-write window and the debounce matter less there but are harmless. Windows is not covered: the rename and
`kill(pid, 0)` semantics differ.

### Verify

All offline, in `npm run test:subagent` (fake children, no model), under `test/subagent/teams/`:

- `files.test.ts`: locks, takeover and its guard, mailboxes, concurrent writers (`lock-worker.ts` is the second process).
- `team.test.ts`: members and `config.json`, delivery, the loop cap, shutdown, stale team directories, and the watcher
  scenarios run in their own process (`watch-worker.ts`: no run-away passes on the lead's own lock files, a refused steer, a
  rewritten mailbox). These are the tests to keep green on a new OS: a pass count above the bound means the watcher feeds on
  its own writes.
- `messages.test.ts`: the envelope and its escaping, delivery to the lead and to idle teammates.
- `start.test.ts`: where teams are on, the refusals, the setting.
- `tasks.test.ts`, `task-tools.test.ts`, `tasks-processes.test.ts` (ids from several processes; `task-worker.ts`): the list, dependencies
  and cycles, retention, the tools, the events across processes.
- `hooks.test.ts`: `block`, `hold`, timeouts (`hold-worker.ts`).
- `ui.test.ts`, `ui-live.test.ts`: rows, the screens, typing, `x`, `/tasks`.

A port is done when these pass against its host's fake. By hand on a real model (Haiku), after `npm run build`:
`test/subagent/tui/14-teams.test.ts` (the UI in a pty) and `test/subagent/tui/15-teams-flow.test.ts` (a lead with two
teammates, a dependent task, messages, an approved shutdown, the end of the session). Both are part of
`npm run test:subagent:tui`.

## Shadow-git sandboxes

An option of the [shadow-git](porting.md#shadow-git) unit, in this extension: in a workspace registered with
`xpi sg init`, `isolation: "worktree"` and teammates (agent teams) run in a sandbox of the workspace's shadow repo
instead of a git worktree at `<root>/.pi/worktrees/<agentId>`. Port it with the unit; it needs layers 1 to 3 and the
[agent teams](#agent-teams) wiring for teammates. The user-level description is in [shadow-git](shadow-git.md#isolation-and-teammates).

**Files.**

| File | What it does |
|---|---|
| `src/extensions/subagent/sandbox-worktree.ts` | plan, ensure, settle, remove and list a sandbox, and `sandboxLauncher` |
| `src/extensions/subagent/worktree.ts` | `WorktreeRef.kind` and the dispatch by kind; `worktreeCwd` |
| `src/extensions/subagent/agent-tool.ts` | plans the sandbox for a teammate (`team-<name>`), where `isolation` plans `sub-<agentId>` |
| `src/extensions/subagent/exchange.ts`, `runner.ts`, `resolve.ts` | `ChildSpec.launch`: set after the sandbox exists, called by `runChild` just before `spawn` |
| `src/extensions/shadow-git/workspace.ts` | `findWorkspace(cwd)`, `quietContext`, the nesting message |

**The contract.**

- `WorktreeRef` has a second kind, `kind: "shadow-git"` (stored in the agent's meta file, so a resume knows). Its `root` is
  the workspace, `path` the sandbox tree (in the store, outside the workspace), `branch` `sbx/<id>`, and `repo`,
  `sandbox` and `backend` say which sandbox and how it runs. Every function of `worktree.ts` that takes a ref
  dispatches on it: a host that keeps one kind can ignore the rest.
- Planning (`planWorktree`) refuses inside a sandbox (`XPI_SG_SANDBOX`), plans a sandbox in a registered workspace, and
  otherwise a git worktree as before. A sandbox that already exists under the id (a kept teammate's) is an error.
- The child is not started with `spec.command` as it is: `spec.launch(command, args, env)` returns what to start
  (`unshare ... sh -c <script> <command>` under `namespace`, the command itself with the sandbox's cwd under `policy`)
  and the environment, in which the sandbox's variables replace `GIT_DIR`, `GIT_WORK_TREE`, `XPI_SG_SANDBOX`,
  `XPI_SG_BACKEND` and `XPI_SG_STORE`. It is built from `prepareLaunch(repo, id)` of xpi-shadow-git, which refreshes the
  tree's links under the sandbox's lock first, so it is async and runs in the exchange, not in `resolve`. The runner
  cannot build the command earlier: it adds the system-prompt files to the arguments itself.
- Settling removes a sandbox (and its branch) with no commits and no changes, else keeps it; the outcome carries a
  `note` telling the user to run `/sg merge sbx/<id>`. All core calls here are synchronous and print nothing
  (`quietContext`): the terminal belongs to the TUI.
- The core API used: `resolveRepo`, `createSandbox`, `loadSandbox`, `listSandboxes`, `removeSandbox(..., dropBranch)`,
  `changedFiles`, `sandboxGit`, `prepareLaunch`, `resolveBackend`, `currentBranch`, `revParse`, `dirtyPaths`, `git`.

**Teams.** `startAgent` plans `team-<member>` when a teammate starts in a registered workspace (and refuses in a sandbox).
Each exchange of a teammate settles its sandbox: an idle teammate that did nothing holds none, and the next wake
recreates it from the primary's current branch. Nothing in `team.ts` changed.

**Verify.** `test/subagent/shadow-git/isolation.test.ts` and `teams.test.ts` (the fake child records its cwd and the
`XPI_SG_*` variables; `fake-pi.mjs`). They force the `policy` backend (`XPI_SG_UNSHARE` names a missing program). The
`namespace` command that `prepareLaunch` builds, with its subdirectory, is covered in xpi-shadow-git's
`test/namespace.test.ts`, which runs where user namespaces work (a Linux container with seccomp and AppArmor unconfined).

## Keeping up with pi

xin-pi no longer merges upstream pi. To follow it, run `/upstream` (it lists what upstream changed since the fork point
and recommends what to port) and translate ported code with `node scripts/xpi-rename.mjs <paths>`; the procedure is in
[xin-pi.md](../../../docs/xin-pi.md). The facts the code relies on are also noted where they are used (comments in
`src/runner.ts`, `src/panel.ts`, `src/subagent-screen.ts`).
