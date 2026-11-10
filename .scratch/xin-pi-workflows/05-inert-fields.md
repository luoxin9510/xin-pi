# 05: Agent-file fields that have no effect today, and `--agents`

Status: draft, NOT approved. Waiting for the owner's answers to Grill 2 (`decisions.md`). The roadmap says "only the
ones the owner uses": the proposal below builds three and leaves the rest inert.

## Problem

An agent file written for Claude Code may carry `mcpServers`, `hooks`, `permissionMode`, `background`,
`autoCompactWindow`, `initialPrompt` or `experimental`. xpi parses them and warns `field "<x>" has no effect in
subagent` (`definition.ts`, `INERT_FIELDS`). Claude Code also takes agents from a `--agents` JSON flag; xpi has no such
flag.

## Claude Code's fields (docs read 2026-11-10, quoted)

| Field | Claude Code |
|---|---|
| `mcpServers` | "Each entry is either a server name referencing an already-configured server (e.g., `"slack"`) or an inline definition with the server name as key and a full MCP server config as value." |
| `background` | "Set to `true` to keep this subagent in the background even when Claude asks to wait for it." |
| `autoCompactWindow` | "Lower the auto-compact window for this subagent to a token count from `100000` to `1000000`." |
| `permissionMode` | "`default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` as an alias for `default`." |
| `hooks` | "Lifecycle hooks scoped to this subagent." (PreToolUse, PostToolUse, Stop) |
| `initialPrompt` | "Auto-submitted as the first user turn when this agent runs as the main session agent (via `--agent` or the `agent` setting)." |
| `--agents '<json>'` | An object, each key an agent name, each value a definition (`prompt` for the body plus the frontmatter fields). Ranked above file agents. |

## Facts this builds on (xpi)

- MCP servers are configured in `mcp.json` (`mcpServers`, `docs/mcp.md`); a child loads the same config as main, and
  an agent's `tools` list keeps MCP tools out unless an entry starts with `mcp__` (`resolve.ts`).
- Compaction is `compaction.reserveTokens` / `keepRecentTokens` in settings, not a window size.
- xpi has no permission modes and no hooks: tool calls are not gated, and what hooks do is done by extensions. There is
  no `--agent` (an agent as the main session).
- `run_in_background` on the call and `subagent.backgroundScripts` decide what runs in the background.

## Solution (proposed)

Build:

- `mcpServers`: a list of names of servers configured in `mcp.json`. The agent gets those servers' tools
  (`mcp__<server>__*` is added to its tool list) and no others. An unknown name is a warning at discovery. Inline
  server definitions are not supported in this spec: the entry is skipped with a warning naming it.
- `background: true`: an `Agent` call for this agent without `run_in_background` behaves as `run_in_background: true`
  (the call returns at once, the result arrives as a message). An explicit `run_in_background: false` on the call wins,
  and print mode waits as it does today.
- `--agents '<json>'` (and a JSON file path): Claude Code's shape. These agents rank above project and user files, live
  for the process, and reach children's discovery only as far as needed (children get no `Agent` tool).

Stay inert, with the warning reworded to say why:

- `permissionMode`, `hooks`: xpi has neither concept.
- `initialPrompt`: only means something with `--agent`, which xpi does not have.
- `autoCompactWindow`: xpi compacts by reserve tokens, not a window; mapping one to the other would be a guess.
- `experimental`: ignored by Claude Code too.

## Out of scope

Inline MCP server definitions; permission modes; hooks; an agent as the main session (`--agent`).

## Testing

- Offline (fake children): `mcpServers` names become tool patterns, unknown and inline entries warn; `background: true`
  with and without `run_in_background`; `--agents` parsing, precedence over files, bad JSON.
- Real, by hand (haiku): an agent with `mcpServers: [<a test server>]` calls that server's tool and cannot see another
  server's; a `background: true` agent returns at once and its result arrives as a message.

## Tickets (after approval)

1. `mcpServers` by name.
2. `background: true`.
3. `--agents`.
4. Reworded warnings for the fields that stay inert; docs.
