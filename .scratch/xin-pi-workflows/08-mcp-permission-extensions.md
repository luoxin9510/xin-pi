# 08: Inline MCP servers, permissionMode, and per-agent extensions

Status: done (2026-11-11, `issues/08-mcp-permission-extensions.md`; #57, #59, #61); real-model regression passed on
main e6e96329e. Approved by the owner on 2026-11-11 (Grill 5, `decisions.md`).

## Problem

Three agent-file fields from Claude Code are parsed and ignored with a warning (`definition.ts`, `INERT_REASONS`, and
the inline branch of `serverNames`): inline `mcpServers` definitions, `permissionMode` and `hooks`. Agent files that rely
on them lose their servers, their read-only mode or their guards without anything taking their place.

## Claude Code's behaviour (docs read 2026-11-11, `code.claude.com/docs/en/sub-agents`, quoted)

- `mcpServers`: each entry is "a server name referencing an already-configured server (e.g., `"slack"`) or an inline
  definition with the server name as key". "Inline definitions use the same schema as `.mcp.json` server entries ...
  and support the `stdio`, `http`, `sse`, and `ws` types." "Inline servers defined here are connected when the subagent
  starts, subject to the trust rule for the agent file's folder, and disconnected when it finishes." "The subagent gets
  the tools; the parent conversation doesn't." Project agent files' inline servers load "only after you trust the
  folder the agent file came from"; user-level files and `--agents` load without that check.
- `permissionMode`: "`default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` as an alias for
  `default`." `plan` is "read-only exploration".
- `hooks`: Claude Code's own hook format (event, matcher, shell command) for `PreToolUse`, `PostToolUse`, `Stop`, scoped
  to the subagent while it runs.

## Facts this builds on (xpi)

- `mcp.json` uses the same server schema for stdio (`command`, `args`, `env`, `cwd`) and HTTP (`url`, `headers`,
  `oauth`); `validateMcpServerConfig` rejects `sse` and `ws` (`docs/mcp.md`, `xpi-mcp/src/config.ts`). Config is read from the agent dir and,
  in a trusted project, `.pi/mcp.json` (`extensions/mcp/config.ts`, `loadMcpConfig`).
- A child is `xpi --mode rpc` with `--tools`, `--exclude-tools`, `--approve`/`--no-approve` from the parent's trust
  (`subagent/resolve.ts`). It exits when the subagent ends.
- xpi never asks for permission: there are no permission prompts, so every Claude mode except `plan` behaves like
  `bypassPermissions`.
- xpi's hooks are extensions: `pi.on("tool_call")` can block a call or change its input, `pi.on("tool_result")` can
  change a result, `agent_before_settle` can keep the agent going (`docs/extensions.md`). Calls a codemode script makes
  go through the same `tool_call` / `tool_result` handlers as direct calls (`extensions/codemode/tool.ts`), so an
  extension in a codemode-only child sees every tool call. A script can call every tool with `codemode` or `deferred`
  exposure (MCP and extension tools) whatever `--tools` lists; only `--exclude-tools` keeps a tool from registering.
- `AgentDefinition.source` is a path, `--agents` or `builtin:<name>`; whether a file came from the project walk is
  known only inside `discoverAgents` today. A child of an in-memory parent runs with `--no-session`.
- Built-in tools include `powershell` next to `bash`.
- `-e <path>` loads an extension file, directory or `builtin:<name>` and is repeatable (`docs/cli.md`).

## Decisions (Grill 5)

1. A public `--mcp-config <file or JSON>` flag adds servers on top of `mcp.json`, in the same schema (Claude Code has a
   flag of that name). It takes one value (an extension flag is a single string; the last one given wins). A child gets
   its agent's inline servers through it, as a JSON value in argv (no file: an in-memory parent has no session dir, and
   `spawn` does not go through a shell). Accepted types are those `validateMcpServerConfig` accepts (`stdio`, `http`,
   `streamable-http`, or none); other entries are rejected by that validator and skipped with a warning that names
   the server and, for `sse` and `ws`, says the type is not supported (the validator's own message for `ws` is the
   generic "needs either command or url"). JSON or a file that does not parse stops the start with the reason, as `--agents` does. Servers from
   the flag have their own config scope (`cli`): `/mcp` lists them, and a change to one is not saved (it says so).
2. Inline servers follow Claude Code's trust rule. `AgentDefinition` gains `scope`: `project` (`.pi/agents`,
   `.claude/agents` in the project walk), `user` (`~/.pi/agent/agents`, `~/.claude/agents`), `cli` (`--agents`) or
   `builtin`. Discovery sets it. Inline servers load from `user`, `cli` and `builtin` always, from `project` only when the
   project is trusted (skipped with a warning otherwise). A `project` inline server may not use `auth: { provider }`, the
   rule project `mcp.json` already has (a repository must not choose where credentials go). Their tools are handled like
   a named server's: with a `tools` list, `mcp__<name>__*` joins it; without one, configured servers the agent does not
   name are excluded. An inline name equal to a configured server's name replaces it for that child; a name that only
   collides in the tool namespace (`a-b` and `a_b`) is skipped with a warning. Inline servers are part of the
   prompt-cache prefix key. An inline HTTP server cannot run an OAuth login in a child (no UI): it uses what `mcp.json`
   would (`headers`, stored tokens), and the docs say so.
3. `permissionMode: plan` is an allowlist plus exclusions:
   - Allowed: `read`, `grep`, `find`, `ls`, and `codemode` for a codemode-only child, `StructuredOutput` with a schema.
     With a `tools` list, the intersection with it (empty is the existing "has no usable tools" error, as intended).
   - Excluded: `write`, `edit`, `bash`, `powershell`, and `mcp__*`. MCP tools are out because they can write and a
     codemode script reaches them whatever `--tools` says; excluded tools never register. A `mcpServers` field (names
     or inline) is ignored under `plan`, with a warning.
   - Agent memory is read-only, through the existing `memoryReadOnly` path, with its own wording ("read-only in plan
     mode").
   - The prompt tail says it is a read-only planning agent.
   - `disallowedTools` still applies. `extensions` still load: they are the agent author's own code, and `plan` does not
     police the tools they register; a codemode-only child can call such a tool from a script when its exposure is
     `codemode` or `deferred`. The docs say so. (The author's call, flagged to the owner.)
   - Fork does not read agent fields (`resolveFork`); nothing changes there.
   Every other value (`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`) is accepted and
   changes nothing; discovery warns once (like the inert fields, not in every result): "xpi never asks for permission;
   runs as bypassPermissions". An unknown value skips the file, as for other enum fields.
4. Hooks use xpi's own mechanism: a new xpi field `extensions` (a list, or a comma-separated string like `tools`) lists
   extensions loaded only into this subagent's child, one `-e` each. A local path (the loader's `isLocalPath`) is
   resolved against the agent file's directory (`--agents`: against the cwd) with `resolvePath` and passed absolute,
   since a child's cwd may be a worktree. Package sources (`npm:`, `git:`) and `builtin:<name>` pass as given, as the
   owner approved ("也可以写 npm 包名"). Today a `-e` that fails to install, a missing path or an extension that throws
   while loading is only a warning (`resource-loader.ts`, `installWarnings`, `extensionsResult.errors`) and the session
   starts without it, which would run a guarded agent unguarded. So a new core flag `--strict-extensions` makes any such
   failure of an explicit `-e` stop the start with the error; the subagent passes it whenever the agent has
   `extensions`, and the result is `failed` with that error. Documented in `docs/cli.md` and `docs/xin-pi.md`. Same trust rule as inline servers (by `scope`). A local path that does not exist is a
   warning at discovery and the entry is dropped. Extensions are part of the prompt-cache prefix key.
5. Claude Code's `hooks` field stays accepted with no effect; its warning now says to use `extensions`.
6. Three PRs, in this order: inline MCP and `--mcp-config`; `permissionMode`; `extensions`. Each with an independent
   Claude Opus review and a real Haiku check; after all three, the full real-model regression, then the subagent work
   is wrapped up.

## Revisions while implementing

Facts above that turned out wrong, and how the build differs from the decisions (each in its PR's description and review):

- Decision 1 (#57): a `session_start` handler that throws only reports the error, so `--agents` never stopped the start.
  A core `validate(value, cwd)` on string extension flags now stops it for `--agents` and `--mcp-config`. Inline servers
  are skipped with a warning when the built-in MCP extension is not loaded (a child would not know `--mcp-config`).
- Decision 3 (#59): with an explicit `--tools` list no tool outside it registers, extension tools included, so a
  script cannot reach one (the fact on codemode/deferred exposure holds only without a list). A `plan` child therefore
  has no extension tools; extensions' event handlers still run. It also runs with `--no-mcp` (`mcp__*` alone missed the
  resource tools), and memory brings `read`.
- Decision 4 (#61): a missing `-e` path and an extension that throws while loading are already errors that stop the
  start; a failed package install was a warning, and a source skipped in offline mode or not read as a source
  (`github:owner/repo`) loaded nothing silently. `--strict-extensions` makes every explicit source that loads no
  extension an error. A missing local path in an agent file is kept (the child fails on it) instead of dropped, and a
  project agent file with `extensions` in an untrusted project makes the call fail instead of skipping them: either
  would run a guarded agent unguarded, which this decision exists to prevent.

## Out of scope

- Claude Code's hook format and events (`PreToolUse` etc. as shell commands).
- `sse` / `ws` MCP transports (xpi does not support them anywhere).
- Agent teams (later, with pi-roost).
- `autoCompactWindow`, `initialPrompt`, `experimental` stay inert.
