# xpi

`xpi` is a coding agent for the terminal from [xin-pi](https://github.com/luoxin9510/xin-pi), an independent fork of
[pi](https://github.com/earendil-works/pi) by earendil-works (MIT). It is not affiliated with or endorsed by the pi
project.

What xin-pi adds to pi:

- **Built-in subagents**: a Claude Code-compatible `Agent` tool for codemode scripts, a panel and a full-screen view of
  running subagents, `/subagents`, background scripts (a script that starts a subagent moves to the background and main
  keeps going), worktree isolation and agent memory.
- **Structured output, names and messages**: `schema` on an `Agent` call returns a validated value instead of prose;
  `name` an agent and reach it later with `resume` or `SendMessage` (a steer while it runs, a continue once it ended).
- **Workflows**: orchestration scripts saved as `.pi/workflows/<name>.js` in Claude Code's format, with the helpers
  `agent`, `parallel`, `pipeline`, `phase` and `log`; run as `/<name> args` with no model turn, or by the model through
  the `Workflow` tool.
- **Native codemode background**: codemode can move a running script to the background; nested calls keep their ids,
  context and usage.
- **`/upstream`**: compares upstream pi with xin-pi and asks the model what is worth porting.

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
- Everything else (usage, settings, extensions, sessions, models) works as in pi; the inherited guide is in
  [README.upstream.md](https://github.com/luoxin9510/xin-pi/blob/main/packages/xpi-coding-agent/README.upstream.md) and
  the `docs/` folder, with the command named `xpi` instead of `pi`.

## License

MIT. Copyright (c) 2025 Mario Zechner and the pi contributors; xin-pi changes copyright (c) 2026 luoxin9510. See
[LICENSE](LICENSE).
