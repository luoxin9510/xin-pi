# xpi

`xpi` is a coding agent for the terminal from [xin-pi](https://github.com/luoxin9510/xin-pi), an independent fork of
[pi](https://github.com/earendil-works/pi) by earendil-works (MIT). It is not affiliated with or endorsed by the pi
project.

It is a personal project, made in the author's own time, for two things: making games with
[Godot](https://godotengine.org/), and exploring how the pi agent works by changing it. It is not connected to any
company or employer.

What xin-pi adds to pi:

- **Codemode on by default**: `codemode` is one of the default tools, so the model can run a script that calls other
  tools in every session; `"defaultTools": ["-codemode"]` or `--tools -codemode` turns it off.
- **Built-in subagents**: a Claude Code-compatible `Agent` tool for codemode scripts, a panel and a full-screen view of
  running subagents, `/subagents`, background scripts (a script that starts a subagent moves to the background and main
  keeps going), worktree isolation and agent memory.
- **Structured output, names and messages**: `schema` on an `Agent` call returns a validated value instead of prose;
  `name` an agent and reach it later with `resume` or `SendMessage` (a steer while it runs, a continue once it ended).
- **Fork**: `subagent_type: "fork"` or `/subtask <task>` starts a subagent as a copy of the conversation; its first
  request reads the main session's prompt cache.
- **Workflows**: orchestration scripts saved as `.pi/workflows/<name>.js` in Claude Code's format (its own
  `.claude/workflows/` files run unchanged), with the helpers
  `agent`, `parallel`, `pipeline`, `phase` and `log`; run as `/<name> args` with no model turn, or by the model through
  the `Workflow` tool. Runs are recorded: a run that stopped or failed is relaunched without redoing the agents that
  finished, and a running script can be paused and resumed. The built-in `/review [branch | commit | #PR]` workflow
  reviews a diff with read-only `reviewer` agents (no argument: your uncommitted changes).
- **Native codemode background**: codemode can move a running script to the background; nested calls keep their ids,
  context and usage.
- **Relay**: the model `relay/auto` runs one conversation on two models. A strong lead explores, plans and reviews; a
  cheap worker builds. The lead hands over with a plan and acceptance commands (a call from a codemode script), and reads
  a record of the result, not the worker's transcript. Both work in one session, and every phase change and repair is
  an entry and a line on screen. The logic is the `xpi-relay` package; see [docs/relay.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/docs/relay.md).
- **Graph**: a flow written as nodes and edges in `.pi/graphs/<name>.js`, run with `/graph start <name>`. The model
  works freely inside a node and can leave it only by a declared edge, so a step of the flow cannot be skipped; each
  node can have its own model. Not complete yet: nodes that run a command, approvals and per-node limits are next
  ([docs/graph.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/docs/graph.md)).
- **Protected paths**: the file tools cannot read `.env` files and private keys or write `.git/` and `node_modules/`;
  your own patterns go in the `protect` setting, `/protect off` lifts it for a session ([docs/protect.md](docs/protect.md)).
- **Checks after edits**: name your type-check or lint commands in the `checks.commands` setting and xpi runs them after
  each turn that changed something, then shows the model the errors that are new, before its next request
  ([docs/checks.md](docs/checks.md)).
- **`/upstream`**: compares upstream pi with xin-pi and asks the model what is worth porting.
- **shadow-git**: in a workspace owned by another version control system and registered with `xpi sg init`, git works with no setup, `/sg` imports, exports and merges, and subagents and teammates work in sandboxes ([docs/shadow-git.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/docs/shadow-git.md)).
- **Background sessions** (macOS and Linux): `xpi --bg "<task>"` or `/bg` hands a session to a daemon that keeps it
  running; `/agents` or `xpi roost hub` lists them to peek, reply, attach and start more. Schedules
  (`xpi roost schedule add`, or `/schedule` in the hub) start a task as a new session on a time rule;
  `xpi roost daemon install` starts the daemon at login so they run without xpi open. See
  [Background Sessions](docs/roost.md).

## Install

```bash
npm install -g xpi-coding-agent
xpi
```

Node.js 22.19 or newer. Standalone binaries are attached to each
[GitHub Release](https://github.com/luoxin9510/xin-pi/releases). `xpi` reads its settings, auth and sessions from `~/.pi/agent` (shared with pi). Environment
variables use the `XPI_` prefix (for example `XPI_CODING_AGENT_DIR`).

## Documentation

- xin-pi overview, install from source, porting from upstream: [docs/xin-pi.md](https://github.com/luoxin9510/xin-pi/blob/main/docs/xin-pi.md)
- Subagents: [docs/subagent.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/docs/subagent.md)
- Relay: [docs/relay.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/docs/relay.md)
- Graph: [docs/graph.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/docs/graph.md)
- Everything else (usage, settings, extensions, sessions, models) works as in pi; the inherited guide is in
  [README.upstream.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/README.upstream.md) and
  the `docs/` folder, with the command named `xpi` instead of `pi`.

## License

MIT. Copyright (c) 2025 Mario Zechner and the pi contributors; xin-pi changes copyright (c) 2026 luoxin9510. See
[LICENSE](LICENSE).
