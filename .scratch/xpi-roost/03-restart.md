# Spec 03: restart onto a rebuilt xpi

Status: approved by the owner on 2026-11-14 (Grill 6 in `decisions.md`).

## Problem

After xpi is rebuilt and installed again at the same path, three kinds of processes keep running the old code: the
daemon, each session's host, and the xpi inside each session. Today:

- `/reload` reads extensions, skills and settings again. It does not load xpi's own code or its built-in extensions,
  and it does not say so.
- The working recipe is two commands in a fixed order: `xpi roost daemon stop --keep-workers`, then
  `xpi roost respawn --all`. Running only the second leaves the daemon on the old code.
- The only warning compares version numbers. Rebuilding during development keeps the version, so nothing warns.
- A person inside a session has no command to restart it; they have to leave it and use the CLI or the hub.

## Goals

1. xpi knows when the installed code differs from what a process runs, also at the same version, and says so.
2. One command restarts everything onto the installed code.
3. A session can be restarted from inside it, by the person and by the agent.

Not in this spec: restarting a foreground session that is not a roost session (it gets the notice of goal 1 only),
restarting subagents on their own, hot-swapping code inside a running process.

## Design

### 1. The build id (decision 1)

- The bundle build (`scripts/build-coding-agent-bundle.mjs`) writes `dist/bundle/build-id`: one line, the first 16 hex
  digits of a SHA-256 over the bundle's files (path and content, in sorted path order, the `build-id` file left out).
  The same sources give the same id, so building again without a change does not ask for a restart.
- `xpi-roost` `lib/version.ts` exports `ROOST_BUILD` (read once, when the process starts) and `buildOnDisk()` (reads the
  file again). Both look for `build-id` next to the entry files of the bundle. Without the file (running from sources,
  an unbundled build) both are `undefined`, and everything in this spec that compares builds does nothing.
- "Stale" means: both ids are known and they differ. An unknown id is never stale.
- The id is not part of the protocol version. An old daemon without the field counts as unknown; the existing version
  warning still covers a real upgrade.

### 2. Who reports what (decision 2)

- The daemon's `status` answer gains `build`.
- A session's worker reports its `ROOST_BUILD` with its first report; the daemon stores it in the session's state and
  `list` rows carry `build`. A session that is not running has none.
- Clients compare against `buildOnDisk()`, never against their own `ROOST_BUILD`: a hub that has been open for hours is
  itself old.

### 3. Where it is said (decision 3)

- CLI: the existing one-time warning also fires for a stale daemon build. Both cases now name one fix:
  `xpi roost restart`. `xpi roost ls` adds one line on stderr when running sessions are stale (`2 sessions run an older
  build: xpi roost restart`).
- `xpi roost daemon status` prints `build` and marks a stale one.
- Hub: a notice in its status line while the daemon, a running session or the hub itself is stale, naming `/restart`.
- `/reload` (any session, roost or not): after it reloads, if this process is stale it adds a notice: xpi's own code
  changed and `/reload` does not load it. In a roost session the notice names `/restart`; in a foreground session it
  says to quit and start xpi again (`xpi --continue`). `/reload` itself does not change.

### 4. `xpi roost restart` (decision 4)

- `xpi roost restart` (no argument): stops the daemon keeping its sessions, waits for it to be gone, starts the
  installed daemon, then restarts every running xpi session. Sessions that are not running are left alone; they load
  the installed code when they next start. Shell sessions are never restarted (as `respawn --all` today).
- `xpi roost restart <id|name>`: restarts that session only (the same as `respawn` of a running session). It says so
  when the daemon is stale and was not restarted.
- A session that was working carries on in its new process (today's behaviour: the `Continue where you left off.`
  prompt). One that was idle comes back showing where it left off.
- `--if-stale`: do only what is stale (the daemon only if its build is stale, each session only if its build is
  stale). Without the flag everything named restarts. Unknown ids count as stale here, so the flag is safe on a
  build without ids.
- It prints one line per step and per session and exits 1 if any session failed to start.
- A daemon started by the login service is stopped and started the same way (the service has no keep-alive); the docs
  say that the new daemon is then not the service's until the next login.
- `xpi roost respawn --all` and `daemon stop --keep-workers` stay as they are.

### 5. Restarting from inside a session (decisions 5, 6)

- `/restart` in a roost session asks the daemon to restart this session. The person may type it; it is also in the
  hub's command table for a peek (class `reply` is wrong for it: the hub restarts the session itself, class `hub`).
- In a foreground session `/restart` only prints how to do it by hand (quit, `xpi --continue`).
- The agent may run `xpi roost restart` and `xpi roost restart <its own id|name>` from its shell tool. Nothing refuses
  it (unlike schedules: the owner decided the agent may restart).
- When the caller is itself a session (`ROOST_JOB_ID` is set) and its own session is among those to restart:
  - the whole restart is one request to the (new) daemon, so it completes after the caller's process is gone;
  - the caller's session is restarted last;
  - its new process gets a prompt that says what happened instead of the bare continue prompt: `xpi was restarted on
    the installed build, as this session asked. Carry on from where you were.`
  The tool call that ran the command is cut short by design; the prompt is how the model learns the outcome.
- `/restart all` in a roost session and `/restart` in the hub run the full `xpi roost restart`.

### 6. Attached terminals and the hub (decision 7)

- A terminal attached to a session when it restarts (by any of the above) attaches to its new process by itself: it
  shows `restarting…`, waits for the new host up to 30 s, then continues. If the session does not come back it ends
  with the reason.
- The standalone hub (`xpi roost hub`) reconnects to the new daemon as it does after any daemon stop. It cannot
  replace its own code: after `/restart` it says that the hub itself still runs the old build until it is started
  again, and its notice stays. The hub inside a session (`/agents`) restarts with that session.

## Tests

- Unit: the build id (deterministic, changes with content, absent file), staleness (unknown never stale; `--if-stale`
  treats unknown as stale), the warning text, the caller-last ordering and its prompt.
- Integration with a real daemon and hosts (the existing harness, fake worker): `restart` replaces the daemon pid and
  every running xpi session's host pid, leaves shell and ended sessions alone; `--if-stale` with a rewritten
  `build-id`; a restart asked from inside a session completes after the caller is killed and restarts it last.
- PTY: an attached terminal survives a restart of its session; `/restart` typed in a session.
- A real Haiku check: the agent is told to run `xpi roost restart <own name>` and report afterwards; the session's
  process is replaced and the model's next message acknowledges the restart.
- Tests never run `npm test`, vitest or `node --test` from inside a test. After the runs, no daemon, host or session
  process of a test is left.

## Docs (each PR updates what it changes)

`docs/roost.md` (the upgrade paragraph becomes a section: what runs old code, the notice, `restart`, `/restart`, the
login service note), `docs/cli.md`, `docs/protocol.md` (`build` fields, the `respawn` op's new arguments),
`docs/porting.md` if a component's entry changes, the hub's help, and the repository's `AGENTS.md` (after rebuilding
and installing xpi while working on it: `xpi roost restart`).
