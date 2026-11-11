# 01: xpi-roost, phase 1: the daemon, the host, `xpi roost` and the hub

Status: draft for the owner's approval (2026-11-11). Decisions: `decisions.md` (Grill 1, 2 and 3, all accepted).
Tickets: `issues/01-roost-core.md`.

## Goal

A native xpi daemon that manages several main sessions running in parallel, and an interface for them, as Claude Code
has: sessions keep running without a terminal, one overview lists them, and attaching to one shows its whole TUI. The
code comes from pi-roost (`~/Developer/pi-roost`, main `890cbe9`: v0.1.20 plus M79, M80 and a follow-up to M78), which
is frozen after one last release.

## Terms

From pi-roost's `GLOSSARY.md`, with one change (a Session):

- **Daemon**: one process per user and agent directory. It runs and keeps sessions, and everything else talks to it
  over a unix socket (JSON lines).
- **Host**: one process per session. It holds the session's PTY and its screen, so the session outlives every terminal.
- **Session**: a job the daemon runs: an xpi in a PTY, or a shell command. (In pi-roost a foreground pi registered as
  a peer is a Session too; here it is not, see decision 5.)
- **Hub**: the TUI overview of the sessions (pi-roost's "agent view"), inside an xpi session (`/agents`) or in a
  terminal of its own (`xpi roost hub`).
- **Person**: the user, through the hub or the CLI.

## Facts this builds on

Checked on 2026-11-11 against both repositories, and again by the independent review of this spec.

pi-roost:

- Source lines: `lib/` 11,679, `daemon/main.ts` 3,170, `hub/` 5,224 (`agent-view.ts` alone 3,686), `adapters/pi/`
  5,167, `host/main.ts` 546, `bin/pi-roost.ts` 431. Tests: 70 `*.test.ts` files and 7 support files, about 22,000
  lines (vitest, real PTYs and sockets). Also `evals/`, `stress/`, `spikes/`, `sdk/python/`, `scripts/`.
- The daemon, the host and the CLI do not import pi. `lib/` does not either, except `lib/pi-resolve.ts`, which finds
  the installed pi and loads its packages at run time for the standalone hub. `adapters/pi/` imports
  `@earendil-works/pi-coding-agent` and `pi-tui`; `hub/` imports `pi-tui` only. The 20 names they import from `pi-tui`
  all exist in `xpi-tui` (names checked, behaviour not).
- The daemon is started on demand by the first client: `spawn(process.execPath, [daemonEntry], { detached: true })`
  (`lib/client.ts`), where the entry is `<package root>/dist/daemon/main.js`; the host entry is found the same way
  (`PI_ROOST_HOST_ENTRY` overrides it). Both need a Node runtime and an entry file on disk.
- The host needs `node-pty` 1.1.0 (native; prebuilt for macOS and Windows only, compiled by its install script on
  Linux), `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0. The prebuilt `spawn-helper` can lose its
  execute bit; the host repairs it itself (`fixSpawnHelper`, `host/main.ts`), node-pty's scripts do not. The host also
  imports `lib/telemetry.ts` and `store.isProfileJob`.
- Where things are on disk (`lib/paths.ts`, `lib/config.ts`):
  - State: `~/.pi/agent/roost/` (`jobs/`, `roster.json`, `events.jsonl`, `daemon.log`, `scratch/`), or `ROOST_HOME`.
  - The daemon's socket and lock, and each host's socket: a runtime directory, `$XDG_RUNTIME_DIR/pi-roost` or
    `/tmp/pi-roost-<uid>`, or `ROOST_RUNTIME_DIR`. It does not depend on the state directory.
  - Settings: `roost.json` in `ROOST_CONFIG_DIR`, else `~/.config/roost/` when that file exists, else `~/.pi/agent/`;
    per project `<cwd>/.pi/roost.json` or `<cwd>/.roost/roost.json`. The daemon reads settings itself
    (`cleanupDays`, `reapIdleMinutes`, `autoResume`).
  - `HOME`, `RUNTIME_DIR` and `CONFIG_DIR` are read with either prefix, `ROOST_` or `PI_ROOST_` (`roostEnv`). About
    25 tuning and wiring variables are read as `PI_ROOST_*` only (`REAP_MINUTES`, `CLEANUP_DAYS`, `HOST_ENTRY`,
    `PARENT_PID`, `SHELL_KEEP_MS`, ...), and a worker's identity still uses `PI_JOB_ID` and `PI_DAEMON_SOCK`.
  - A session started with `inheritEnv: false` gets only the variables on the allow list.
- How features are wired: the concierge, schedules, watches and workspaces are modules created with injected ports.
  The task board's claim, release, done, drop and assign, the messages between sessions (`send`, `spawn`, peers), PR
  polling, profiles and worktree isolation are written directly in `daemon/main.ts`. Restarting a session whose
  agent process crashed (DM-5, `crashed`) and the reconciliation at the daemon's start are in the same code as resume
  after an interruption (M38: `autoResume`, a host that is gone).
- Kept modules import cut ones: `protocol.ts` (board, concierge), `protocol-schema.ts` (board, comms, concierge, pr,
  schedule), `config.ts` (concierge, profiles), `dispatch.ts` (worktree, profiles, agents), `store.ts` (profiles),
  `view-model.ts` and `filter.ts` (pr). `hub/agent-view.ts` imports board, concierge, schedule, pr, worktree, task-git,
  task-diff and agents, with about 300 lines of their handling in the file itself; `adapters/pi/hub-options.ts` has
  concierge, profiles and fan-out groups.
- A session reports its state with `Reporter` and `jobIdentity`, which live in `lib/agent-client.ts` next to the
  protocol client class (`RoostAgent`, M31).
- The session side (`adapters/pi/worker.ts`) does more than report. A reply reaches a session only through its
  worker connection and waits for the worker's ack (without one it stays queued, and a slash command is refused); the
  worker writes the session's slash-command list that the hub's peek reads, registers the earlier history (M53) and
  the repaint on attach. The hub's log overlay and the CLI's `log` read the `events` op. `handback` is a child
  session's report to its parent (M9), called only by the worker.
- A foreground pi becomes known to the daemon only through `peer_register` (M9, `adapters/pi/peer-link.ts`).
  `adapters/pi/foreground.ts` holds `/bg`, `/bg-fork` and the left-arrow key; after a hand-off it opens the hub.
- Ops: `hello`, `report`, `ack`, `ping`, `list`, `resolve`, `status`, `dispatch`, `subscribe`, `stop`, `rm`,
  `respawn`, `pin`, `rename`, `reorder`, `reply`, `shutdown`, `events`, `handback`; `peer_register`, `peer_ack`,
  `send`, `spawn`, `watch`; `schedules`, `schedule-*`; `concierge*`; `task` with its actions. Who may call which is
  one table (`lib/callers.ts`); every op has a schema (`lib/protocol-schema.ts`) that the daemon checks at its entry
  and from which `docs/protocol.md` is generated.
- `reply` to an ended session respawns it, and `respawn` runs the command stored in the job record.
- In pi it registers the slash commands `/agents`, `/bg` (alias `/background`), `/bg-fork`, `/subagents`, `/tasks`,
  and the flags `--bg`, `--bg-name`, `--agent`, `--worktree`, `--agents` (boolean) and `--agents-cwd`. The CLI has
  `hub`, `list`/`ls` (`--all`, `--cwd`, `--subagents`), a top-level `--json` (`--all`, `--cwd`), `logs`/`log`,
  `attach`, `reply`, `stop`, `rm`, `respawn` (`--all`), `review`, `schedule(s)`, and `daemon status|logs|stop`
  (`stop --keep-workers`). The hub and `foreground.ts` use fixed keys.
- `lib/pi-commands.ts` holds pi 1.5.0's slash commands for the hub's peek, each with how the hub runs it (`hub`,
  `screen`, `picker`, `confirm`). xpi exports its built-in commands (`BUILTIN_SLASH_COMMANDS`) without that class.

xin-pi:

- Nine `xpi-*` workspace packages; only `xpi-coding-agent` is published, and its bundle inlines the others
  (`scripts/build-coding-agent-bundle.mjs`, which rejects unexpected external imports). A separate worker entry in the
  bundle already exists (`codemode-worker.js`, found through `src/config.ts`). GitHub Releases also carry standalone
  binaries compiled with bun, which have no Node runtime to start a daemon with.
- Built-in extensions are listed in `src/extensions/index.ts` (`builtin:<name>`, disabled with `-builtin:<name>`).
  Subcommands (`xpi mcp`, `xpi auth`) are dispatched in `src/main.ts` before a session starts.
- The agent directory is `~/.pi/agent` unless `XPI_CODING_AGENT_DIR` says otherwise. `node-pty` 1.1.0 and
  `@xterm/headless` 5.5.0 are devDependencies of `xpi-coding-agent` (the TUI test harness); `@xterm/addon-serialize`
  is not in the repository.
- CI installs with `npm ci --ignore-scripts`, so `node-pty` is not compiled there. The `test (other)` job runs the
  `test` script of every workspace except the coding agent, and `./test.sh` walks `packages/*`. The install-lock check
  (`scripts/generate-coding-agent-install-lock.mjs`) allows no package to run install scripts, and a lockfile change
  needs `PI_ALLOW_LOCKFILE_CHANGE=1`.
- No slash command named `agents`, `bg`, `background` or `bg-fork` exists; `/subagents` is the built-in subagent
  extension's. The subagent extension registers a string flag `--agents`. No flag named `--bg` or `--bg-name` exists.
- AGENTS.md forbids hardcoded key checks, with an exemption for the subagent panel's files.
- Extensions written for upstream pi do not load in xpi, the owner's settings list no pi-roost package, and no
  pi-roost daemon runs on the owner's machine. `~/.pi/agent/roost.json` exists and holds only `summaryModel`.

Not known yet; settled in the PR that meets it, and a contradiction with a decision stops the work (decision 16):

- Whether `xpi-tui` behaves as the `pi-tui` the hub was written against (xin-pi forked at pi 1.5.0, the version
  pi-roost was tested with).
- Whether the host's `@xterm/headless` 6 and `@xterm/addon-serialize` are best bundled into the host entry or declared,
  given the pinned 5.5.0 the TUI tests use.

## Decisions

1. **Where the code lives.** `packages/xpi-roost` holds `lib/`, `daemon/`, `host/`, `hub/`, the CLI and their tests.
   It may import `xpi-tui` (the hub) and nothing else of xpi. The adapter is the built-in extension `builtin:roost`,
   `packages/xpi-coding-agent/src/extensions/roost/`, which may import `xpi-roost`; its tests are in
   `xpi-coding-agent`. Both ship in the `xpi-coding-agent` bundle; `xpi-roost` is not published on its own.
2. **What a session is.** A real `xpi` in a PTY held by a host process, as in pi-roost. Attaching shows the session's
   own TUI, with its own subagent panel and screens.
3. **The daemon manages main sessions only.** The hub lists sessions, never their subagents. Nothing in roost reads
   the subagent extension's records. pi-roost's subagent panel, its lifecycle handling and its transcript view (M12,
   M13, M19), its `/subagents` command and `list --subagents` are not ported.
4. **Phase 1 scope.**
   - Sessions: an xpi session or a shell command, started from the hub, with `xpi --bg "<task>"` (and
     `--bg-name <name>`), or by `/bg` and `/bg-fork` in a foreground session. A new session is a plain xpi session
     with a model and thinking level, optionally from a launch preset (M27).
   - Ops kept: `hello`, `report`, `ack`, `ping`, `list`, `resolve`, `status`, `dispatch`, `subscribe`, `stop`, `rm`,
     `respawn`, `pin`, `rename`, `reorder`, `reply` (with steer and follow-up, M28), `shutdown`, `events`. Request
     ids with resend (M36, M51) stay. `handback` goes with the messages between sessions.
   - The daemon keeps: restart of a session whose agent process crashed and reconciliation at its own start (DM-5;
     a session whose host is gone ends, since resuming it is M38), the session write lock (DM-8), the shell environment a session gets (M20: `inheritEnv`, the allow and deny lists,
     `workspaceEnv`), cleanup of old sessions (`cleanupDays`) and reaping of idle ones (`reapIdleMinutes`).
   - Hub: the list with pin, reorder, grouping and the filter; peek with the reply editor and the session's own slash
     commands (M48, M61); attach (replay, M21, and several
     windows, M22); new session; stop; remove; rename; resume of an earlier session and the model choice (M23);
     usage (M24); multi-select and batch actions (M25); the log overlay; earlier history when entering a session (M53).
   - In a session: `/agents` opens the hub; `/bg` (alias `/background`) hands the session to the daemon and
     `/bg-fork` a copy of it; the left arrow on an empty editor opens the hub when the `leftArrowOpensAgents` setting
     is on (the default).
   - CLI: `xpi roost hub [dir]`, `ls`/`list` (`--all`, `--cwd`, `--json`), `logs`/`log`, `attach`, `reply`, `stop`,
     `rm`, `respawn` (`--all`), `daemon status|logs|stop` (`stop --keep-workers`). pi-roost's top-level `--json`
     becomes `ls --json`. The command that runs the daemon itself is internal and not listed in help.
   - The hub's table of xpi's built-in slash commands, each with how the hub runs it, lives in `builtin:roost` (it
     knows xpi); a test fails when a command in `BUILTIN_SLASH_COMMANDS` has no class.
5. **A foreground session is not in the hub.** The hub lists the sessions the daemon runs. An xpi started in a
   terminal appears there once it is handed over with `/bg`. `peer_register` and `peer-link.ts` are not ported.
6. **Left out of phase 1.** The code is not copied (not copied and switched off):
   - Phase 2: schedules (M39, M40) and resume after an interruption (M38). Until then an interrupted session is shown
     as ended, and the `autoResume` setting does not exist.
   - With agent teams, later: messages between sessions and peers (M9, M50), watches (M43), the `roost_*` agent tools,
     and with them the limits on agents starting agents (`agentMax*`).
   - Only if the owner asks: the task board and workspaces (M47, M52, M54 to M60, M64 to M66; `review` in the CLI,
     `/tasks`), the concierge and standing orders (M44 to M46), worktree isolation for started sessions (M10,
     `--worktree`), pull request status (M16), fan-out and `/compare` (M26), starting a session from an agent
     definition (M18: `--agent`, `dispatchAgent`, `<agent> <prompt>` in the hub, the `a:` filter), terminal-agent
     profiles and the protocol client class (M30, M31), the Python SDK, pi-mobile (M11), telemetry (M34), the summary
     model, `defaultToAgentsView`. A launch preset loses its `worktree`, `agent` and `fanout` fields.
   - Never, as they are: `--agents` and `--agents-cwd` (xpi's `--agents` defines subagents; the hub from a terminal
     is `xpi roost hub`).
   - Not ported at all: `lib/pi-resolve.ts` (the hub imports `xpi-tui` directly), `lib/pi-commands.ts`, the
     `extensions/index.ts` shim, `spikes/`, `evals/` and `stress/` (xin-pi's own real-model checks cover phase 1).
   A module that phase 1 keeps and that imports a cut one is split: the kept part moves, the cut part does not. That
   holds for `protocol.ts`, `protocol-schema.ts`, `callers.ts`, `config.ts`, `dispatch.ts`, `store.ts`,
   `events.ts`, `view-model.ts`, `filter.ts`, `agent-client.ts` (only `Reporter` and `jobIdentity` move), the host (without
   telemetry and profile jobs), `hub/agent-view.ts` and the hub options. The caller table and the op schemas lose the
   rows of ops that are not ported; the `Concierge` caller kind goes with its ops.
7. **Entry points.** `xpi roost <subcommand>` in `src/main.ts`, next to `xpi mcp`. No `pi-roost` executable. The
   daemon and the host are two more entry files in the bundle, as `codemode-worker.js` is. `xpi-coding-agent` finds
   them and hands their paths to `xpi-roost` (which cannot import xpi's config): the client starts the daemon with the
   running Node and the daemon entry, and the daemon starts hosts with the host entry it was given. The daemon and the
   hosts are processes of their own, so what they need travels in their environment: the daemon is started with the
   agent directory, the state and runtime directories and the host entry, and it gives every host and every session
   the same, whatever `inheritEnv` says. A session's own `/agents` therefore reaches the daemon that runs it. A client
   and a daemon of different versions: the client says so and how to restart the daemon
   (`xpi roost daemon stop --keep-workers`, then `xpi roost respawn --all`), as pi-roost's version warning does.
8. **Native dependency.** `node-pty` becomes an `optionalDependencies` entry of `xpi-coding-agent`, and the
   install-lock check allows it to run its install scripts (Grill 3; the reason, recorded where the allowlist is, is
   the compile on Linux). The host keeps `fixSpawnHelper`. It is imported only when a host starts, never at the top of the extension, so an xpi without it loads. When it
   cannot be loaded, `xpi roost` commands, `/agents`, `/bg` and `--bg` say why and how to fix it, and the rest of xpi
   is unaffected. A standalone binary (no Node runtime) says roost needs the npm installation.
9. **State, runtime directory and settings.**
   - State: `<agent dir>/xpi-roost/`, where the agent directory follows `XPI_CODING_AGENT_DIR`. pi-roost's
     `~/.pi/agent/roost/` is never read, so its sessions do not appear and cannot be respawned.
   - Runtime directory (sockets, lock): `$XDG_RUNTIME_DIR/xpi-roost-<key>` or `/tmp/xpi-roost-<uid>/<key>`, where
     `<key>` is a short hash of the resolved agent directory. Each agent directory has its own daemon, and a temporary
     one (tests, real-model checks) never meets the owner's. The path stays short enough for a unix socket.
   - `ROOST_HOME` and `ROOST_RUNTIME_DIR` still override both (the tests use them). Only the `ROOST_` prefix is read:
     every `PI_ROOST_*` variable is renamed `ROOST_*`, and `PI_JOB_ID` and `PI_DAEMON_SOCK` get `ROOST_` names too. The runtime directory has two levels under `/tmp`; the
     owner and symlink checks cover both.
   - Settings: the `"roost"` section of `settings.json`, global and project, with the keys that still apply
     (`leftArrowOpensAgents`, `reapIdleMinutes`, `cleanupDays`, `dispatchModel`, `dispatchThinking`, `inheritEnv`,
     `envAllowList`, `envDenyList`, `workspaceEnv`, `groupBy`, `fullscreen`, `rowDetails`, `notify`, `presets`) and the
     same rule for keys a project may not set. The extension and the hub read and write it through xpi's settings
     (a saved preset, a changed option); the daemon reads the section itself from `<agent dir>/settings.json`. No
     `roost.json` is read.
10. **Platforms.** macOS and Linux. On Windows `xpi roost`, `/agents`, `/bg` and `--bg` say roost is not supported.
11. **Keys.** The hub is a full-screen component with fixed keys, as the subagent panel is; AGENTS.md's exemption list
    gains the hub's files and the left-arrow check. Nothing else gets a hardcoded key.
12. **Names.** `ROOST_*` environment variables, op names and file layouts stay as they are: they are internal, and
    keeping them keeps the diff against pi-roost readable. User-facing text says `xpi` and `xpi roost`. The generated
    op reference becomes `packages/xpi-roost/docs/protocol.md`.
13. **Tests and CI.**
    - Tests whose subject is in `packages/xpi-roost` move to `packages/xpi-roost/test` and keep running on vitest with
      real PTYs and sockets. Tests of the adapter (foreground, reply queue, reporter, worker wiring, earlier history)
      move to `xpi-coding-agent`.
    - A CI job `test (roost)` on Linux compiles `node-pty` (`npm rebuild node-pty` after the install) and runs the
      package's tests; `xpi-roost` is excluded from `test (other)` and from `./test.sh`'s default walk.
    - The orphan sweep (M78) comes along, and a roost test never runs another test command.
    - Tests of removed features are removed whole, never emptied. For each kept test file, a guard is deleted once to
      see the test fail (as in M66 and M70).
14. **Real-model check.** Before each merge that changes what a session does: on real Haiku, start a background
    session, reply to it, attach and detach, with a temporary agent directory holding a copy of `auth.json` made with
    `copyUserAuth` (an OAuth copy can rotate the original's token: check the expiry first).
15. **pi-roost's last release.** 0.1.21 with what is on its main, then a README notice that the project continues in
    xin-pi. npm is published by the owner. `docs/porting.md` moves to `packages/xpi-roost/docs/porting.md` and is cut
    to phase 1's scope.
16. **How it is built.** After the owner approves this spec, the PRs below are built without stopping to ask, each
    with an independent Claude Opus review and green CI before its merge, and with its own docs. Work stops only for a
    fact that contradicts a decision. `packages/xpi-roost/docs/port-inventory.md` lists every pi-roost source and test
    file as ported, split or cut (with the decision), so a reviewer can check the cut.

## The five PRs

In this order. Each one works on its own when merged.

1. **Core processes.** The package, `lib/` for phase 1, the host, the daemon with phase 1's ops, the new state and
   runtime directories, their tests, the CI job, the inventory. Nothing in `xpi-coding-agent` changes; the daemon and
   the host run from source in tests.
2. **Command line and packaging.** `xpi roost <subcommand>` without `hub`: `ls`, `logs`, `attach`, `reply`, `stop`,
   `rm`, `respawn`, `daemon`. The bundle entries, the optional `node-pty`, the messages for an unsupported platform or
   a missing native module, the `"roost"` settings section. A shell-command session can be started for tests through
   the client library; users get their first way to start a session in PR 3.
3. **`builtin:roost`: the session side.** `xpi --bg "<task>"` starts an xpi session under the daemon. The session
   reports state, waiting, dialogs, context and model, takes replies, writes its slash-command list, and registers
   the earlier history and the repaint on attach. With the CLI of PR 2 this is usable end to end: start, list, reply,
   attach, stop.
4. **The hub.** `xpi roost hub [dir]` and `/agents`: everything in decision 4's hub list. With it come the commands
   that open it: `/bg` and `/bg-fork` (the hub opens after the hand-off) and the left arrow.
5. **Docs and release.** The user guide complete, the porting document, pi-roost's notice, a release.

## Out of scope

Everything in decision 6; agent teams; a headless (rpc) session model; roost in the standalone binaries; Windows.
