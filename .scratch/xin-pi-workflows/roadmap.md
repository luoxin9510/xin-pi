# Subagents v4: closing the gap to Claude Code's subagents and dynamic workflows

Status: specs 1-3 approved by the owner on 2026-11-10 (Grill 1, `decisions.md`); 1, 2 and 3 done (`issues/`); 4 (`04-fork.md`) and 5 (`05-inert-fields.md`) approved on 2026-11-10 (Grill 2); 4 and 5 done (`issues/`): the roadmap is complete; `06-workflows-2.md` (Claude Code workflow files, restart an agent) done (`issues/06-workflows-2.md`); `07-relaunch-and-pause.md` done and checked on real Haiku before merge (PR #22, `issues/07-relaunch-and-pause.md`). Since then (2026-11-11): Agent and SendMessage declarations shortened (#41), agent files with an unquoted `: ` in a value load (#44), codemode is a default tool (#45), skipped agent files are reported in print mode and in the call's error (#46). `/review` built in (#43). `08-mcp-permission-extensions.md` (inline MCP servers, `permissionMode`, per-agent `extensions`), approved in Grill 5 (2026-11-11), done in #57, #59 and #61 (its "Revisions while implementing" section lists where the build differs). Full real-model regression on main e6e96329e (2026-11-11): `test:subagent:real` 96/96, `:parent` 13/13, `:tui` 17/17, `:evals` 22/22, `test:relay:real` 1/1. **The subagent work is wrapped up.** Agent teams wait for pi-roost

Compared on 2026-11-10 against Claude Code's docs (`code.claude.com/docs/en/sub-agents`, `.../workflows`) and
`packages/xpi-coding-agent/docs/subagent.md`.

Already on par: agent files (`tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `memory`,
`isolation`, `color`, `omitClaudeMd`), built-in agents, foreground/background, ctrl+b, `resume`, worktrees, one level of
nesting, panel, subagent screen, talking to a subagent, stop.

Order of work, one spec each, each shippable on its own:

| # | Spec | Why this position |
|---|---|---|
| 1 | `01-structured-output.md`: `schema` on an `Agent` call | Small; scripts stop parsing prose; workflows build on it |
| 2 | `02-workflows.md`: saved, rerunnable workflow scripts | The largest visible gap |
| 3 | `03-names-and-messages.md`: `name` and `SendMessage` | Completes agent-to-agent addressing |
| 4 | fork (a child that inherits main's conversation) | Largest change (context and cache inheritance); spec after 1-3 land |
| 5 | Inert agent-file fields: `mcpServers`, `hooks`, `permissionMode`, `background`, `autoCompactWindow`, `initialPrompt`; `--agents` | Only the ones the owner uses; spec after 1-3 land |

Not planned: agent teams (pi-roost covers multi-session work), plugin and managed agent sources.

Rules for every spec here: real-model checks by hand on Claude Haiku 5.5 with a temp `XPI_CODING_AGENT_DIR`; no test may
run `npm test`, `vitest` or `node --test`; `docs/subagent.md` updated in the same PR; the by-hand suites rerun after any
change to the child's prompt.
