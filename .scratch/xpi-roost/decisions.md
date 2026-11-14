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

## Grill 5: phase 2 after the spec's first review (2026-11-12)

The review found that the daemon starts only when a client needs it, that "waiting for an answer" is a heuristic
(a reply ending in a question), and that a session's model can reach the daemon as a person through `xpi roost`. The
owner accepted every recommendation.

11. Schedules run only while the daemon runs. An opt-in `xpi roost daemon install` registers it as a per-user login
    service (launchd on macOS, systemd user on Linux), with `uninstall` and a line in `status`; nothing is installed
    by default.
12. Revises Grill 4's item 6: a slot is skipped only while the previous run is working (starting, or waiting to
    restart after a crash). A previous run waiting for an answer does not hold the schedule back: the new run starts
    and the old one stays as Needs input.
13. Inside a session the daemon runs (`ROOST_JOB_ID` set), `xpi roost schedule add|edit|run` refuse; `list` works.
    It stops accidents, not a model that clears the variable, and the docs say so.

The author's corrections from the same review, not owner decisions: the 5-minute floor for cron rules is checked on
the rule's times of day, not on the next two slots; the protocol version stays 1; the CLI builds a run's launch
through the extension's wrapper and uses the stored trust decision only; a run's environment is not stored (corrected below: it is stored); a missing
executable skips a run; run now, edit and retention are specified; each PR updates its own user docs; names follow
pi-roost's pattern.

After the spec's second review, the author's corrections (no owner decision changes): a run's environment is computed
when the schedule is made or edited and stored with it, as a job's record stores it today (the first draft said it
was computed at run time, which the code does not do, and a login service's daemon has almost no environment); the
login service runs once per login with no restart, `KillMode=process` on systemd and a per-agent-directory name;
`schedule list` does not start the daemon; the hub's `/schedule` works inside a roost session.

The owner approved spec 02 as reviewed on 2026-11-12.

## Grill 6: restart onto a rebuilt xpi (2026-11-14). Accepted by the owner on 2026-11-14

The owner asked how a rebuilt xpi gets loaded when sessions run under the daemon. Asked three questions; the owner
answered "do all three, and the agent may run it too".

1. A build id, not only the version: the bundle build writes a content hash; a process knows the one it started with
   and can read the one on disk. Unknown is never stale.
2. The daemon and each running session report their build; clients compare with the disk, not with themselves.
3. The notice appears in the CLI's warning, `ls`, `daemon status`, the hub's status line and after `/reload`.
   `/reload` keeps its meaning (the owner agreed: a notice only).
4. `xpi roost restart`: one command for the daemon and every running xpi session; `--if-stale`; one session by name.
   The two older commands stay.
5. `/restart` inside a roost session. Owner: yes.
6. The agent may restart too (owner: "Agent 也可以跑"), through `xpi roost restart` in its shell tool. Its own session
   goes last and its new process is told what happened.
7. An attached terminal follows its session through a restart; the standalone hub says it is itself still old.
8. A foreground session that is not a roost session gets no restart in this spec (the author's recommendation; the
   owner did not ask for it): `/reload`'s notice and `/restart` there say how to do it by hand.
