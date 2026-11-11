# 01: xpi-roost, phase 1: the daemon, the host, `xpi roost` and the hub

Status: draft for the owner's approval (2026-11-11). Decisions: `decisions.md` (Grill 1 and 2, all accepted). Tickets:
`issues/01-roost-core.md`.

## Goal

A native xpi daemon that manages several main sessions running in parallel, and an interface for them, as Claude Code
has: sessions keep running without a terminal, one overview lists them, and attaching to one shows its whole TUI. The
code comes from pi-roost (`~/Developer/pi-roost`, main `890cbe9`: v0.1.20 plus M79 and M80), which is frozen after one
last release.

## Terms

From pi-roost's `GLOSSARY.md`, kept as they are:

- **Daemon**: one process per user. It runs and keeps sessions, and everything else talks to it over a unix socket
  (JSON lines).
- **Host**: one process per session. It holds the session's PTY and its screen, so the session outlives every terminal.
- **Session**: a job the daemon runs (an xpi in a PTY, or a shell command), or a foreground xpi that registered itself.
- **Hub**: the TUI overview of the sessions (pi-roost's "agent view"), inside an xpi session (`/agents`) or in a
  terminal of its own (`xpi roost hub`).
- **Person**: the user, through the hub or the CLI.

## Facts this builds on

Checked on 2026-11-11 against both repositories.

pi-roost:

- About 26,000 source lines: `lib/` 11,700, `daemon/main.ts` 3,170, `hub/` 5,200, `adapters/pi/` 5,200, `host/main.ts`
  550, `bin/pi-roost.ts` 430. 77 test files, about 22,000 lines (vitest, real PTYs and sockets).
- The daemon, the host, the CLI and `lib/` do not import pi. `adapters/pi/` imports `@earendil-works/pi-coding-agent`
  and `pi-tui`; `hub/` imports `pi-tui` only.
- The daemon is started on demand by the first client: `spawn(process.execPath, [daemonEntry], { detached: true })`
  (`lib/client.ts`). A host is a Node process too. So both need a Node runtime and an entry file on disk.
- The host needs `node-pty` (native) and `@xterm/headless` with `@xterm/addon-serialize`. `node-pty` 1.1.0 has prebuilt
  binaries for macOS and Windows only; on Linux it compiles at install.
- The task board and workspaces (`workspace.ts`, `board.ts`, `task-*.ts`, `worktree.ts`, `workspace-*.ts`), the
  concierge (`concierge*.ts`), schedules, watches, messages between sessions, profiles and the protocol client are
  separate modules in `lib/` (the architecture work of M63 to M77), wired into the daemon by injection.
- Who may call which op is one table (`lib/callers.ts`); every op has a schema (`lib/protocol-schema.ts`) that the
  daemon checks at its entry and from which `docs/protocol.md` is generated.
- State is in `~/.pi/agent/roost/` (`jobs/`, `roster.json`, `events.jsonl`, `daemon.log`); settings in
  `~/.pi/agent/roost.json` and `<cwd>/.pi/roost.json`. No Windows support (unix sockets, POSIX signals).
- Slash commands it registers in pi: `/agents`, `/bg` (alias `/background`), `/bg-fork`, `/subagents`, `/tasks`.

xin-pi:

- Nine `xpi-*` workspace packages; only `xpi-coding-agent` is published, and its bundle inlines the others
  (`scripts/build-coding-agent-bundle.mjs`, which rejects unexpected external imports). GitHub Releases also carry
  standalone binaries compiled with bun, which have no Node runtime to start a daemon with.
- Built-in extensions are listed in `src/extensions/index.ts` (`builtin:<name>`, disabled with `-builtin:<name>`).
  Subcommands (`xpi mcp`, `xpi auth`) are dispatched in `src/main.ts` before a session starts.
- The agent directory is `~/.pi/agent` unless `XPI_CODING_AGENT_DIR` says otherwise. `node-pty` and `@xterm/headless`
  are devDependencies of `xpi-coding-agent` today (the TUI test harness).
- No slash command named `agents`, `bg`, `background` or `bg-fork` exists. `/subagents` is the built-in subagent
  extension's.
- Extensions written for upstream pi (`@earendil-works/*` imports) do not load in xpi, so the pi-roost package still
  listed in the owner's settings is not running. No pi-roost daemon is running on the owner's machine.

Not checked yet, to settle in the PR that meets it (a contradiction with a decision stops the work, decision 13):

- Whether `xpi-tui` differs from the `pi-tui` the hub was written against (xin-pi forked at pi 1.5.0, the version
  pi-roost was tested with).
- How the bundle should carry two more Node entry points (the daemon, the host) and an optional native dependency.
- Which of pi-roost's tests cover only phase 1's scope after the cut.

## Decisions

1. **Where the code lives.** `packages/xpi-roost` holds `lib/`, `daemon/`, `host/`, `hub/`, the CLI and their tests.
   It may import `xpi-tui` (the hub) and nothing else of xpi. The adapter is the built-in extension `builtin:roost`,
   `packages/xpi-coding-agent/src/extensions/roost/`, which may import `xpi-roost`. Both ship in the `xpi-coding-agent`
   bundle; `xpi-roost` is not published on its own.
2. **What a session is.** A real `xpi` in a PTY held by a host process, as in pi-roost. Attaching shows the session's
   own TUI, with its own subagent panel and screens.
3. **The daemon manages main sessions only.** The hub lists sessions, never their subagents. Nothing in roost reads
   the subagent extension's records. pi-roost's subagent panel, its lifecycle handling and its transcript view (M12,
   M13, M19) and its `/subagents` command are not ported.
4. **Phase 1 scope.**
   - Daemon ops kept: starting a session (an xpi session or a shell command), listing, reading a session's log and
     screen, reply (with steer and follow-up, M28), stop, remove, respawn, rename, attach, resume of an earlier
     session and the model choice (M23), usage (M24), multi-select and batch actions (M25), launch presets (M27),
     session reports (state, waiting, dialog, context, model), foreground registration, the event stream the hub
     reads, request ids with resend (M36, M51).
   - Hub: the list, peek with the reply editor and the session's own slash commands (M48, M61), attach, new session,
     stop, rename, resume, model, usage, the log overlay, earlier history when entering a session (M53).
   - In a session: `/agents` opens the hub; `/bg` (alias `/background`) sends the current session to the background
     and `/bg-fork` a copy of it.
   - CLI: `xpi roost hub [dir]`, `ls` (alias `list`), `logs`, `attach`, `reply`, `stop`, `rm`, `respawn`, and the
     internal `daemon`.
5. **Left out of phase 1**, with the code not copied (not copied and disabled):
   - Phase 2: schedules (M39, M40) and resume after an interruption (M38).
   - With agent teams, later: messages between sessions and peers (M9, M50), watches (M43), `roost_*` agent tools.
   - Only if the owner asks: the task board and workspaces (M47, M52, M54 to M60, M64 to M66), the concierge and
     standing orders (M44 to M46), worktree isolation for dispatched sessions (M10), pull request status (M16),
     fan-out and `/compare` (M26), terminal-agent profiles and the protocol client (M30, M31), the Python SDK,
     pi-mobile (M11), telemetry (M34), the summary model.
   The caller table and the op schemas lose the rows of ops that are not ported; the `Concierge` caller kind goes with
   its ops.
6. **Entry points.** `xpi roost <subcommand>` in `src/main.ts`, next to `xpi mcp`. No `pi-roost` executable. The
   daemon starts on demand, as today, from an entry file in the bundle run with the Node that runs xpi.
7. **Native dependency.** `node-pty` becomes an `optionalDependencies` entry of `xpi-coding-agent`; `@xterm/headless`
   and `@xterm/addon-serialize` are bundled or ordinary dependencies, whichever the bundle check allows. When `node-pty`
   cannot be loaded, `xpi roost` commands, `/agents` and `/bg` say why and how to fix it, and the rest of xpi is
   unaffected. A standalone binary (no Node runtime) says roost needs the npm installation.
8. **State and settings.** State in `<agent dir>/roost/`, where the agent directory follows `XPI_CODING_AGENT_DIR`.
   Settings are the `"roost"` section of `settings.json` (global and project, read through xpi's settings), with the
   keys of `roost.json` that still apply and the same rule for keys a project may not set. `roost.json` is not read. No
   migration code: the state format is unchanged, so earlier sessions show in the history; they cannot be resumed.
9. **Platforms.** macOS and Linux. On Windows `xpi roost`, `/agents` and `/bg` say roost is not supported there.
10. **Names.** `ROOST_*` environment variables, op names, the socket and file layouts stay as they are: they are
    internal, and keeping them keeps the diff against pi-roost readable. User-facing text says `xpi` and `xpi roost`.
    The generated op reference becomes `packages/xpi-roost/docs/protocol.md`.
11. **Tests and CI.** Tests whose subject is in scope move to `packages/xpi-roost/test` and keep running on vitest
    with real PTYs and sockets. A CI job `test (roost)` runs them on Linux (where `node-pty` compiles) and they are
    not part of the existing coding-agent job. The orphan sweep (M78) comes along, and a roost test never runs another
    test command. A cut must not leave a test that passes while asserting nothing: tests of removed features are
    removed, not emptied.
12. **Real-model check.** Before each merge that changes behaviour a session can see: on real Haiku, start a
    background session, reply to it, attach and detach, with a temporary agent directory (a copy of `auth.json` only).
13. **pi-roost's last release.** 0.1.21 with M79 and M80, then a README notice that the project continues in xin-pi.
    npm is published by the owner. `docs/porting.md` moves to `packages/xpi-roost/docs/porting.md` and is cut to phase
    1's scope in the last PR.

## The five PRs

In this order; each is reviewed by an independent Claude Opus and merged on green CI.

1. **Core processes.** The package, `lib/` for phase 1, the host, the daemon with phase 1's ops, their tests, the CI
   job. Nothing in `xpi-coding-agent` changes; the daemon and the host run from source in tests.
2. **Command line and packaging.** `xpi roost <subcommand>`, the bundle entries for the daemon and the host, the
   optional `node-pty`, the messages for an unsupported platform or a missing native module, the `"roost"` settings
   section and its schema.
3. **`builtin:roost`: the session side.** A session started by the daemon reports its state; `/bg`, `/bg-fork`;
   a foreground session registers itself.
4. **The hub.** `/agents` and `xpi roost hub` with everything in decision 4.
5. **Docs.** `docs/roost.md` (user), `docs/xin-pi.md` (the new package, the bundle entries, the optional dependency),
   README files, `docs/cli.md`, `docs/settings.md`, the porting document, pi-roost's notice. Then a release.

## Out of scope

Everything in decision 5; agent teams; a headless (rpc) session model; roost in the standalone binaries; Windows.
