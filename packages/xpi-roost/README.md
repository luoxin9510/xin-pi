# xpi-roost

Background sessions for xpi: a daemon that runs xpi sessions (and plain shell commands) in PTYs, a host process per
session that holds its PTY and a headless mirror of its screen, and the library both use. Ported from pi-roost, phase 1
of `.scratch/xpi-roost/01-roost-core.md`. Private: it ships inside the `xpi-coding-agent` bundle, never on its own.

It has the core, the `xpi roost` commands and the hub. The session side, `builtin:roost` (`xpi --bg`, `/agents`, `/bg`,
`/bg-fork`, the worker role in a session the daemon runs), lives in `xpi-coding-agent/src/extensions/roost/`.

## Layout

- `src/lib/`: the shared library (protocol, client, paths, store, callers, the attach loop, ...).
- `src/daemon/main.ts`: the daemon. One per agent directory; started on demand by `DaemonClient.connectOrStart`.
- `src/host/main.ts`: the PTY host of one session. The only module that loads node-pty.
- `src/cli.ts`: `runRoostCli(argv, options)`, the `xpi roost` commands (user docs: coding-agent's `docs/cli.md`).
- `src/index.ts`: what xpi imports (the client, the CLI, the settings merge, the detach-key scanner, and for the session
  side `Reporter`, `jobIdentity`, `WorkerTracker`, `buildLaunch`, the recap's list).
- `src/session.ts` (`xpi-roost/session`): what every xpi session loads, the session write lock (DM-8),
  `isRoostSession` and the scratch-session check of `/bg`. Files and the environment only: it reaches no client
  (`check-entry-graphs.mjs` enforces it).
- `src/hub/` (`xpi-roost/hub`): the hub (pi-roost's agent view, cut to phase 1: no task board, workspaces, review,
  concierge, schedules, fan-out or agent definitions), its overlays (log, usage), the overlay host, the task editor and
  the daemon port. It draws with `xpi-tui`, the one xpi package this library imports, and only here. Everything it
  cannot know comes in `AgentViewOptions`: `connect` (the daemon), `isDetachKey` and `detachKeyName`, `launch` and
  `launchShell`, models, presets, resume, and `builtins`, xpi's slash commands with how a peek runs each
  (`BuiltinHow`: hub, screen, picker, confirm, reply). The process that shows it must carry the roost's location
  variables (xpi's adapter sets them, as `xpi roost` does).
- `docs/protocol.md`: how sessions and controllers talk to the daemon, with the op reference generated from the
  schemas (`npm run docs:protocol`).
- `docs/port-inventory.md`: every pi-roost file and where it went, and the renamed environment variables.

It imports nothing of xpi. The caller gives the agent directory and the paths of the two entry files:

```ts
// src/lib/client.ts
const client = await DaemonClient.connectOrStart({ agentDir, daemonEntry, hostEntry });
```

`xpi roost` (`coding-agent/src/extensions/roost/cli.ts`) calls `runRoostCli` with those, plus `xpi roost hub` (the `hub` option), the detach key as a
matcher (`isDetachKey(key)`, built from the user's `app.suspend` binding; the attach loop cuts the input into whole
keys, asks the matcher about each and treats a bracketed paste as text), its name for the help, and the hint printed
when the daemon cannot load node-pty. The CLI process takes on the given roost's location variables, so it reaches
that agent directory's daemon even from inside another roost's session.

## Build

`npm run build` (`tsc -p tsconfig.build.json`) writes `dist/`; the root build runs it before coding-agent's. Exports:
`.` (the library), `./session` (the write lock), `./hub` (the hub), `./daemon` and `./host` (the two entry files).
Coding-agent's tests import `.`, `./session` and `./hub` from source (vitest aliases); the daemon and host entries they start come from `dist/`. The coding-agent bundle inlines the package:
`roost-daemon.js` and `roost-host.js` are built from `dist/daemon/main.js` and `dist/host/main.js` next to the bundle's
chunks, `@xterm/*` inlined into the host, node-pty left external (an optional dependency of `xpi-coding-agent`).
Unbundled runs resolve `xpi-roost/daemon` and `xpi-roost/host`, so build this package first.

## Where a roost is

- State: `<agent dir>/xpi-roost/` (jobs, roster, the event feed, the daemon's log).
- Sockets and the daemon's lock: `$XDG_RUNTIME_DIR/xpi-roost-<key>`, or `/tmp/xpi-roost-<uid>/<key>`, where `<key>` is
  a hash of the agent directory. A temporary agent directory therefore gets a daemon of its own.
- `ROOST_HOME` and `ROOST_RUNTIME_DIR` override both, unless `ROOST_AGENT_DIR` names another agent directory than the
  one given. A session carries its roost's three variables, so a process inside it that asks for another agent
  directory gets that directory's daemon, never its session's. Only `ROOST_*` names are read.
- A client checks each level of the runtime directory (a directory of its own, not a link) before it connects. The
  daemon also locks the state directory, so one agent directory never has two daemons (a client that works out another
  runtime directory is told where the running one is).
- Settings: the `"roost"` section of `<agent dir>/settings.json`, read by the daemon itself (`reapIdleMinutes`,
  `cleanupDays`, the environment keys, ...). `roost.json` is not read.

macOS and Linux only.

## Tests

The tests start real daemons, hosts and PTYs, so they are kept out of the root `npm test`, `./test.sh` and CI's
`test (other)` (the package has no `test` script). Run them from this directory:

```bash
npm run test:roost                                  # the whole suite, about a minute
node ../../node_modules/vitest/dist/cli.js --run test/daemon.test.ts
```

CI runs them in the `test (roost)` job on Linux, after `npm rebuild node-pty` (the install there skips scripts, and
node-pty has no Linux prebuild). On macOS node-pty's prebuilt helper is used; the host makes it executable
(`fixSpawnHelper`).

Test processes are marked (`ROOST_PARENT_PID`, a home under `<tmp>/xroost-*`): a daemon or host whose test run is gone
stops by itself, and the suite's global setup sweeps what a killed run left before and after (M78). A test that is
interrupted can still leave a process for a moment, so check after a run
(`ps -axo pid,ppid,etime,command | grep -E "xroost|src/(daemon|host)/main"`). No test starts another test runner, and
none calls a model: sessions are shell commands and fake workers.
