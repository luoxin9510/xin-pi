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
   (The directory was replaced by decision 14; the settings part stands.)
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

## Grill 3 (2026-11-11): after the independent review of the spec. Accepted by the owner on 2026-11-11

The review found facts the first draft had missed: the daemon's socket is not under the state directory; `reply` and
`respawn` run the command stored in an old job record; a foreground session becomes known only through the peer
mechanism that is not ported; `xpi --bg` was missing and pi-roost's `--agents` flag collides with xpi's; the hub uses
fixed keys, which AGENTS.md forbids outside an exemption list; `node-pty` runs install scripts, which the install-lock
check does not allow.

14. State is in a new directory, `<agent dir>/xpi-roost/`; pi-roost's `roost/` is never read, so its sessions do not
    appear and cannot be respawned. The runtime directory (sockets) is keyed by the agent directory, so a temporary
    daemon never meets the owner's. This replaces the directory of decision 8.
15. The hub lists the sessions the daemon runs. A foreground xpi is not in it until `/bg` hands it over.
16. A background session is started from the command line with `xpi --bg "<task>"` and `--bg-name <name>`. `--agent`,
    `--worktree`, `--agents` and `--agents-cwd` are not ported; the hub from a terminal is `xpi roost hub`.
17. Starting a session from an agent definition (`<agent> <prompt>` in the hub, M18) is not in phase 1. A new session
    is a plain xpi session with a model and a launch preset.
18. The hub keeps fixed keys and its files join AGENTS.md's exemption list. The left arrow on an empty editor opens
    the hub, behind a `"roost"` setting that is on by default.
19. `node-pty` may run its install scripts: it is added to the install-lock check's allowlist (it compiles on Linux).
    (The question also said the scripts fix the mode of a helper on macOS. They do not: pi-roost's host does that
    itself. The Linux reason stands.)

In the spec these are decisions 4 to 6, 8, 9 and 11; the spec's own numbering differs from this record's.

Decision 12's order stands (session side, then hub), with one move so that each PR works on its own when merged:
`/agents`, `/bg`, `/bg-fork` and the left arrow, which open the hub, are in the hub's PR and not in the session side's.
(A first revision swapped the two PRs; the second review showed that replies, the peek's commands and the earlier
history need the session side first.)

The owner approved the spec as reviewed, with these additions, on 2026-11-11.

Added by the author after the third review, within decision 18 (no new exemption was needed): the keys that detach an
attached session instead of ending it follow the user's keybindings (`app.suspend`, `app.clear` twice, `app.exit`
twice) rather than fixed keys.

## Grill 4: phase 2 (2026-11-12)

Facts gathered first: pi-roost's M38/M39/M40 and what xpi-roost on main already has; Claude Code's documented
behaviour for scheduled tasks and for background sessions after an interruption. The owner accepted every
recommendation.

1. Resume after an interruption is not added: phase 1 already behaves as Claude Code does (crash restarts while the
   daemon runs; after a machine restart, failed or stopped, resumed by the person). M38 and `autoResume` are not ported.
2. Phase 2 is daemon schedules: each run is a new background session. A timer inside a session (`/loop`) is a core
   xpi feature for a separate spec.
3. Rules: pi-roost's four (`every`, `daily`, `weekdays`, `cron`) plus `weekly <day> HH:MM` and `manual`; local time;
   at least 5 minutes apart; no one-shot schedules.
4. Missed slots: as Claude Code, run once if the latest missed slot is within 7 days, else drop it; no `catchUp`
   option; a catch-up is logged.
5. A run is a new session named after the schedule; the list keeps a schedule's last 3 ended runs, older records are
   removed (the session files stay, `/resume` finds them).
6. Overlap: skip the slot and record why; no queue, no parallel runs.
7. Made and managed in the hub (`/schedule`) and the command line (`xpi roost schedule ...`, including `add` and
   `edit`); not in an ordinary session.
8. A run's directory, model, thinking and trust decision are fixed when the schedule is made (trust: a stored decision
   only, else `--no-approve`); `edit` changes them; a missing directory skips the run.
9. Notifications as for any session; catch-ups and skips are logged, not notified.
10. At most 50 schedules; names `[A-Za-z0-9._-]{1,40}`.
