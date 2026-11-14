# Tickets: spec 03, restart onto a rebuilt xpi

Spec: `.scratch/xpi-roost/03-restart.md` (approved 2026-11-14). Each PR: independent Opus review, green CI, the user
docs for what it adds.

## PR 1: the build id and the notices (branch `roost-build-id`)

- [ ] R1 the bundle build writes `dist/bundle/build-id` (decision 1); `xpi:pack` ships it
- [ ] R2 `lib/version.ts`: `ROOST_BUILD`, `buildOnDisk()`, `isStale(running, onDisk)`; unit tests
- [ ] R3 `status` gains `build`; the worker's `hello` carries its build (`agent.build`), copied into the state when the
      connection is bound, cleared by `respawn`, on `list` rows; `docs/protocol.md`
- [ ] R4 CLI: the warning covers a stale build and names `xpi roost restart` (the text is updated in PR 2 if the
      command lands later: until then it names the two existing commands); `ls` line; `daemon status` shows the build
- [ ] R5 hub: the status line notice
- [ ] R6 `/reload`: builtin:roost's notice on `session_start` reason `reload` in a stale process (roost and foreground
      wording, `formatResumeCommand`); no change in core
- [ ] R7 docs: `roost.md`, `cli.md`

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
