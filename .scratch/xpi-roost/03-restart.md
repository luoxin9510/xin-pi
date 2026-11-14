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
  digits of a SHA-256 over the files under `dist/bundle` (each file's path relative to `dist/bundle` and its content,
  in sorted path order, the `build-id` file left out). The same sources give the same id in any checkout, so building
  again without a change does not ask for a restart. Files outside `dist/bundle` (the subagent definitions, say) are
  read when needed and are not part of the id. `xpi:pack` ships the file (the package's `files` include `dist`).
- `xpi-roost` `lib/version.ts` exports `ROOST_BUILD` (read once, when the process starts) and `buildOnDisk()` (reads the
  file again). The entry files are in `dist/bundle` and the daemon's, the host's and the shared chunks in
  `dist/bundle/chunks`, so both walk up from `import.meta.url` to the first directory that has a `build-id`, and stop
  at the first `package.json` (as `readVersion` does). Running from sources or an unbundled build, the walk ends at
  `packages/xpi-roost/package.json`: both are `undefined`, and everything in this spec that compares builds does
  nothing.
- "Stale" means: both ids are known and they differ. An unknown id is never stale.
- The id is not part of the protocol version. An old daemon without the field counts as unknown; the existing version
  warning still covers a real upgrade.

### 2. Who reports what (decision 2)

- The daemon's `status` answer gains `build`.
- A session's worker says its build in the `hello` it already sends (`agent: {name, version, build}`). The daemon
  copies it into the session's state when it binds the connection, and `list` rows carry `build`. `respawn` clears it,
  so a restarted row never shows the old process's build. A session that is not running has none.
- Clients compare against `buildOnDisk()`, never against their own `ROOST_BUILD`: a hub that has been open for hours is
  itself old.

### 3. Where it is said (decision 3)

- CLI: the existing one-time warning also fires for a stale daemon build. Both cases now name one fix:
  `xpi roost restart`. `xpi roost ls` adds one line on stderr when running sessions are stale (`2 sessions run an older
  build: xpi roost restart`).
- `xpi roost daemon status` prints `build` and marks a stale one.
- Hub: a line that stays (in the header's status text, not a message that fades) while the daemon, a running session
  or the hub itself is stale, naming `/restart`. The hub inside a session (`/agents`) leaves out "the hub itself": it
  restarts with its session.
- `/reload` (any session, roost or not): builtin:roost, which loads in every session, handles `session_start` with
  reason `reload`; if this process is stale it shows a notice: xpi's own code changed and `/reload` does not load it.
  In a roost session (`isRoostSession()`, not a bare `ROOST_JOB_ID`: an xpi started from the agent's shell inherits
  the variable) the notice names `/restart`; in a foreground session it gives the command
  to start this session again (`formatResumeCommand` with the session's `SessionManager`, imported from the
  interactive mode or moved to a shared module; not a fixed string). Core and `/reload` itself do not change.

### 4. `xpi roost restart` (decision 4)

- `xpi roost restart` (no argument):
  1. reads `status` (the old pid) and the list of running xpi sessions;
  2. sends `shutdown {keepWorkers: true}` and polls until that pid is gone (10 s, then it fails and says so;
     `daemon stop` does not wait today);
  3. connects with `connectOrStart`. Another client may have started the daemon in between (the hub reconnects by
     itself after 500 ms): that is fine, it is the installed code either way. `restart` then checks that `status.pid`
     is not the old one and that `status.build` is not stale, and fails if either is wrong. The new daemon's
     environment is its starter's, as for any daemon started on demand today. A session's worker gets the environment
     stored in its record, plus the roost location variables (`ROOST_AGENT_DIR`, `ROOST_HOME`, `ROOST_RUNTIME_DIR`,
     `ROOST_HOST_ENTRY`) from the daemon; the host process runs with the daemon's environment;
  4. asks for one `list`. A daemon adopts running hosts before it listens, so there is nothing to wait for: a session
     of step 1 whose row has `pid === null` was not adopted (its host was gone). It is reported as `ended while the
     daemon restarted`, left out, and counts as a failure for the exit code. Then one `respawn` request for the rest.
  Sessions that are not running are left alone; they load the installed code when they next start. Shell sessions are
  never restarted (as `respawn --all` today).
- `xpi roost restart <id|name>`: restarts that session only, without touching the daemon. It says so when the daemon
  is stale and was not restarted. A session that is not running is not started: it says `not running` and exits 1
  (`respawn` is the command that starts one).
- The `respawn` op gains two optional arguments: `ids: string[]` (restart exactly these running sessions, in this
  order; with it `all` and `id` are not allowed) and `last: {id: string, prompt?: string}` (this session, which must
  be in `ids`, is restarted after the others, with this prompt in place of the continue prompt). The CLI builds
  `ids`: all running xpi sessions, or with `--if-stale` only the stale ones.
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

- `/restart` in a roost session asks the daemon to restart this session. builtin:roost registers it in every session.
- In a peek, `/restart` restarts the peeked session: a new entry in the hub's `PEEK_COMMANDS` with its own case that
  sends `respawn {ids: [id]}` (the existing peek `/respawn` starts an ended session and does not restart a running
  one). Its row in builtin:roost's command table has class `hub`, so the peek's menu does not list it twice. In the
  hub's main input `/restart` restarts everything (section 6).
- In a foreground session `/restart` only prints how to do it by hand (quit, then the `formatResumeCommand` line).
- The agent may run `xpi roost restart` and `xpi roost restart <its own id|name>` from its shell tool. Nothing refuses
  it (unlike schedules: the owner decided the agent may restart).
- The daemon cannot tell that a caller is a session: `respawn` and `shutdown` are refused on a worker's own connection
  and allowed on a fresh one. So the CLI and `/restart` always open a new `DaemonClient` connection, and when
  `ROOST_JOB_ID` is set and that session is among those to restart they name it as `last`:
  - the restart of the sessions is one request, which the daemon finishes after the caller's process is gone;
  - the caller's session is restarted last;
  - when the caller's state is `working` (the agent ran the command in a tool call), `last.prompt` is: `xpi was
    restarted on the installed build, as this session asked with "xpi roost restart". The command that asked for it
    was cut short and shows no result: do not run it again. Carry on from where you were.` The cut-off tool call
    resumes with the synthetic "No result provided" error result, which is why the prompt says not to retry.
  - when the caller's state is not `working` (a person typed `/restart` in an idle session), no prompt is sent: the
    session comes back showing where it left off, as any restart of an idle session.
- `/restart all` in a roost session and `/restart` in the hub run the full `xpi roost restart`.

### 6. Attached terminals and the hub (decision 7)

- A terminal attached to a session when it restarts (by any of the above) attaches to its new process by itself.
  Today both attach paths (`xpi roost attach` and the hub's) see the host exit, and a restart looks like an end. The
  daemon marks the session's state `restarting: true` before it ends the host for a restart and clears it when the new
  host is up or the start failed; the host's exit message to attached clients carries the reason `restart`. Both
  attach paths then show `restarting…`, wait for the new host's socket up to 30 s, and attach again. If the session
  does not come back they end with the reason.
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
