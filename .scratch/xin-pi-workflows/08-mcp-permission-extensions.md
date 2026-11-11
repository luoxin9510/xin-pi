# 08: Inline MCP servers, permissionMode, and per-agent extensions

Status: approved by the owner on 2026-11-11 (Grill 5, `decisions.md`); tickets in `issues/08-*.md`.

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
  `oauth`); the legacy SSE transport and ws are not supported (`docs/mcp.md`). Config is read from the agent dir and,
  in a trusted project, `.pi/mcp.json` (`extensions/mcp/config.ts`, `loadMcpConfig`).
- A child is `xpi --mode rpc` with `--tools`, `--exclude-tools`, `--approve`/`--no-approve` from the parent's trust
  (`subagent/resolve.ts`). It exits when the subagent ends.
- xpi never asks for permission: there are no permission prompts, so every Claude mode except `plan` behaves like
  `bypassPermissions`.
- xpi's hooks are extensions: `pi.on("tool_call")` can block a call or change its input, `pi.on("tool_result")` can
  change a result, `agent_before_settle` can keep the agent going (`docs/extensions.md`). Calls a codemode script makes
  go through the same `tool_call` / `tool_result` handlers as direct calls (`extensions/codemode/tool.ts`), so an
  extension in a codemode-only child sees every tool call.
- `-e <path>` loads an extension file, directory or `builtin:<name>` and is repeatable (`docs/cli.md`).

## Decisions (Grill 5)

1. A public `--mcp-config <file or JSON>` flag adds servers on top of `mcp.json`, in the same schema (Claude Code has a
   flag of that name). A child gets its agent's inline servers through it. Types `stdio` and `http` (and entries
   without `type`, as in `mcp.json`); `sse` and `ws` are skipped with a warning naming the server.
2. Inline servers follow Claude Code's trust rule: from a project agent file only when the project is trusted (skipped
   with a warning otherwise); from user-level agent files and `--agents` always. Their tools are handled like a named
   server's: with a `tools` list, `mcp__<name>__*` joins it; without one, configured servers the agent does not name are
   excluded. An inline name equal to a configured server's name replaces it for that child.
3. `permissionMode: plan` keeps only read-only tools: `read`, `grep`, `find`, `ls` (and codemode, which then reaches only
   those), no `write`, `edit` or `bash`, and the child's prompt says it is a read-only planning agent. Agent memory is
   read-only under `plan`. Every other value (`default`, `manual`, `acceptEdits`, `auto`, `dontAsk`,
   `bypassPermissions`) is accepted, changes nothing, and the result carries one warning: "xpi never asks for
   permission; runs as bypassPermissions". An unknown value skips the file, as for other enum fields.
4. Hooks use xpi's own mechanism: a new xpi field `extensions` lists extensions loaded only into this subagent's child
   (`-e` each), paths relative to the agent file's directory, or package sources and `builtin:<name>` as `-e` accepts
   them. They load from a project agent file only when the project is trusted (skipped with a warning otherwise); from
   user-level files and `--agents` always (relative paths in `--agents` resolve against the cwd). A path that does not
   exist is a warning at discovery and the entry is dropped.
5. Claude Code's `hooks` field stays accepted with no effect; its warning now says to use `extensions`.
6. Three PRs, in this order: inline MCP and `--mcp-config`; `permissionMode`; `extensions`. Each with an independent
   Claude Opus review and a real Haiku check; after all three, the full real-model regression, then the subagent work
   is wrapped up.

## Out of scope

- Claude Code's hook format and events (`PreToolUse` etc. as shell commands).
- `sse` / `ws` MCP transports (xpi does not support them anywhere).
- Agent teams (later, with pi-roost).
- `autoCompactWindow`, `initialPrompt`, `experimental` stay inert.
