# Tickets: spec 03, restart onto a rebuilt xpi

Spec: `.scratch/xpi-roost/03-restart.md` (approved 2026-11-14). Each PR: independent Opus review, green CI, the user
docs for what it adds.

## PR 1: the build id and the notices (branch `roost-build-id`)

- [x] R1 the bundle build writes `dist/bundle/build-id` (decision 1); `xpi:pack` ships it
      Done: `scripts/build-coding-agent-bundle.mjs` writes `dist/bundle/build-id` after the bundle is built: SHA-256 over each file's relative path (with `/`), its length and its content, in sorted path order, `build-id` left out; the first 16 hex digits. `xpi:pack` ships it with `dist`.
- [x] R2 `lib/version.ts`: `ROOST_BUILD`, `buildOnDisk()`, `isStale(running, onDisk)`; unit tests
      Done: `lib/version.ts`: `readBuildId(start?)` (walks up to the first `build-id`, stops at the first `package.json`), `ROOST_BUILD`, `buildOnDisk(start?)`, `isStale`; exported from `xpi-roost` and `xpi-roost/session`. Tests: `test/build-id.test.ts` (5).
- [x] R3 `status` gains `build`; the worker's `hello` carries its build (`agent.build`), copied into the state when the
      connection is bound, cleared by `respawn`, on `list` rows; `docs/protocol.md`
      Done: `status.build`, `hello.agent.build` (kept on the connection, written to the state with the report that binds it, cleared by `respawn`), `JobRow.build` (running sessions only); xpi's worker sends it. `lib/protocol-schema.ts`, `docs/protocol.md` regenerated (`npm run docs:protocol`). Tests: `test/daemon.test.ts` ("spec 03").
- [x] R4 CLI: the warning covers a stale build and names `xpi roost restart` (the text is updated in PR 2 if the
      command lands later: until then it names the two existing commands); `ls` line; `daemon status` shows the build
      Done: `cli.ts`: the one-time warning for a stale build (same version) names the two existing commands, as does `xpi --bg`; `ls` prints `N sessions run an older build: ...` on stderr; `daemon status` has a `build` line. Tests: `test/cli-version.test.ts` (3 new).
- [x] R5 hub: the status line notice
      Done: `AgentView` asks `status` on connect and on each resync, compares with `buildOnDisk()`, and shows a warning line under the title while the daemon, a running session or (option `standalone`, set by `xpi roost hub`) the hub is stale. `RoostPort.daemon.status`. Tests: `test/agent-view.test.ts` (4 new).
- [x] R6 `/reload`: builtin:roost's notice on `session_start` reason `reload` in a stale process (roost and foreground
      wording, `formatResumeCommand`); no change in core
      Done: `extensions/roost/stale.ts` and a `session_start` handler in `index.ts` (reason `reload`); `formatResumeCommand` moved to `utils/resume-command.ts` (the interactive mode re-exports it). Tests: `test/roost-stale.test.ts` (6), the import-list test in `test/roost-session.test.ts`.
- [x] R7 docs: `roost.md`, `cli.md`
      Done: `docs/roost.md` ("After xpi is rebuilt or upgraded"), `docs/cli.md`.

## PR 2: restart (branch `roost-restart`)

- [ ] R8 `xpi roost restart [<id|name>] [--if-stale]` (decision 4): stop keeping sessions, wait, start, restart
      sessions; output and exit code
- [ ] R9 the daemon's `respawn` op: `ids` and `last: {id, prompt?}` (decision 6); the request finishes after the
      caller's death; `restarting` in the state and the host's `restart` exit reason
- [ ] R10 `/restart` and `/restart all` in a session (builtin:roost, a new connection, `last` with the prompt only
      when working), the foreground wording, the peek's `/restart` in `PEEK_COMMANDS`, the row of class `hub` in the
      command table (`test/roost-commands.test.ts`)
- [ ] R11 hub `/restart`, and what it says about itself afterwards (decision 7)
- [ ] R12 attach: a terminal follows its session through a restart (decision 7)
- [ ] R13 tests per the spec: integration, PTY, the real Haiku check
- [ ] R14 docs: `roost.md` section, `cli.md`, `protocol.md`, hub help, the repository's `AGENTS.md`; R4's warning text
      names `xpi roost restart`
