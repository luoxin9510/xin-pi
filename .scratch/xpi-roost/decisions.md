# xpi-roost: decisions

Each line is worded so "yes" accepts the proposal.

## Grill 1 (2026-11-11): bringing pi-roost into xin-pi. Accepted by the owner on 2026-11-11

The owner's goal: a native xpi daemon that manages several agents running in parallel, with an interface for them,
"as Claude Code does it".

1. Code: a new workspace package `packages/xpi-roost` (daemon, host, hub, CLI, shared library) and a built-in extension
   `builtin:roost` in `xpi-coding-agent` (the adapter). Both ship in the `xpi-coding-agent` bundle.
2. The pi-roost repository gets one last release (0.1.21, with M79 and M80) and is frozen; xin-pi is the only home, and
   the porting document moves with the code.
3. A session is a real `xpi` in a PTY held by a host process; attaching shows its whole interface. No rewrite to a
   headless rpc model.
4. The owner's own rule, replacing the proposal: the daemon manages each main session and nothing below it. A
   session's subagents are shown in that session's own TUI (xin-pi's subagent panel and screens). The hub does not
   show subagents and does not read subagent records; pi-roost's subagent panel and transcript view (M12, M13, M19)
   are not ported. Agent teams get their own spec later.
5. Scope, by Claude Code's measure (background sessions, one overview, attach): phase 1 is the daemon, the host, the
   `xpi roost` commands and the hub (list, peek, reply, attach, stop, rename, new, resume, model). Phase 2: schedules
   and resume after an interruption. With agent teams, later: messages between sessions, watches. Not ported unless the
   owner asks: the task board and workspaces (worktree, verify, review, merge), the concierge and standing orders,
   pi-mobile, the Python SDK, fan-out and `/compare`, telemetry.
6. Entry: `xpi roost <subcommand>`; no `pi-roost` executable. In a session: `/agents` (the hub) and `/bg`. The daemon
   starts on demand.
7. `node-pty` is an optional dependency of `xpi-coding-agent`. Where it cannot be installed (Linux without a
   toolchain, the standalone binaries of a GitHub Release), roost commands say so and the rest of xpi works.

## Grill 2 (2026-11-11): details. Accepted by the owner on 2026-11-11

8. State stays in `<agent dir>/roost/` (it follows `XPI_CODING_AGENT_DIR`). Settings move from `roost.json` to a
   `"roost"` section of `settings.json`, as `"subagent"` has. No migration code: the format is unchanged, old sessions
   show in the history and cannot be resumed; deleting the old `roost/` directory gives a clean start.
9. macOS and Linux only. On Windows `xpi roost` says it is not supported.
10. The daemon keeps its agent-neutral structure, but phase 1 runs two kinds of session only: xpi sessions and plain
    shell commands. Terminal-agent profiles and the protocol client are not ported.
11. Tests in phase 1's scope move to `packages/xpi-roost/test` (vitest, real PTYs) with a CI job of their own,
    `test (roost)`; the orphan sweep (M78) comes along. Before each merge, a small real Haiku check (new session,
    reply, attach).
12. Phase 1 is five PRs, merged in order: core processes; command line and packaging; `builtin:roost`; the hub; docs
    and the porting document. Phase 2 is its own group afterwards.
13. After the owner approves the spec, the PRs are built without stopping to ask, each with an independent Claude Opus
    review and green CI before its merge; work stops only for a fact that contradicts the spec. Mechanical moves go to
    cheaper models; judgement and review stay with the lead.
