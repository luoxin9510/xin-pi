# xpi-roost

Background sessions for xpi: a daemon that runs xpi sessions (and plain shell commands) in PTYs, a host process per
session that holds its PTY and a headless mirror of its screen, and the library both use. Ported from pi-roost, phase 1
of `.scratch/xpi-roost/01-roost-core.md`. Private: it ships inside the `xpi-coding-agent` bundle, never on its own.

This package is the core only. The `xpi roost` commands, the bundle entries, `builtin:roost` (`xpi --bg`, `/bg`) and
the hub come in the next PRs of the spec.

## Layout

- `src/lib/`: the shared library (protocol, client, paths, store, callers, the attach loop, ...).
- `src/daemon/main.ts`: the daemon. One per agent directory; started on demand by `DaemonClient.connectOrStart`.
- `src/host/main.ts`: the PTY host of one session.
- `docs/protocol.md`: how sessions and controllers talk to the daemon, with the op reference generated from the
  schemas (`npm run docs:protocol`).
- `docs/port-inventory.md`: every pi-roost file and where it went, and the renamed environment variables.

It imports nothing of xpi. The caller gives the agent directory and the paths of the two entry files:

```ts
// src/lib/client.ts
const client = await DaemonClient.connectOrStart({ agentDir, daemonEntry, hostEntry });
```

## Where a roost is

- State: `<agent dir>/xpi-roost/` (jobs, roster, the event feed, the daemon's log).
- Sockets and the daemon's lock: `$XDG_RUNTIME_DIR/xpi-roost-<key>`, or `/tmp/xpi-roost-<uid>/<key>`, where `<key>` is
  a hash of the agent directory. A temporary agent directory therefore gets a daemon of its own.
- `ROOST_HOME` and `ROOST_RUNTIME_DIR` override both. Only `ROOST_*` names are read.
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
stops by itself, and the suite's global setup sweeps leftovers before and after (M78). No test starts another test
runner, and none calls a model: sessions are shell commands and fake workers.
