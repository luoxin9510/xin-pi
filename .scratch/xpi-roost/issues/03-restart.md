# Tickets: spec 03, restart onto a rebuilt xpi

Spec: `.scratch/xpi-roost/03-restart.md` (approved 2026-11-14). Each PR: independent Opus review, green CI, the user
docs for what it adds.

## PR 1: the build id and the notices (branch `roost-build-id`)

- [ ] R1 the bundle build writes `dist/bundle/build-id` (decision 1); `xpi:pack` ships it
- [ ] R2 `lib/version.ts`: `ROOST_BUILD`, `buildOnDisk()`, `isStale(running, onDisk)`; unit tests
- [ ] R3 `status` gains `build`; the worker's first report carries its build, stored in the state, on `list` rows;
      `docs/protocol.md`
- [ ] R4 CLI: the warning covers a stale build and names `xpi roost restart` (the text is updated in PR 2 if the
      command lands later: until then it names the two existing commands); `ls` line; `daemon status` shows the build
- [ ] R5 hub: the status line notice
- [ ] R6 `/reload`: the notice after reloading in a stale process (roost and foreground wording)
- [ ] R7 docs: `roost.md`, `cli.md`

## PR 2: restart (branch `roost-restart`)

- [ ] R8 `xpi roost restart [<id|name>] [--if-stale]` (decision 4): stop keeping sessions, wait, start, restart
      sessions; output and exit code
- [ ] R9 the daemon's `respawn` op: caller-last ordering and the caller's prompt when the request comes from a session
      (decision 6); the whole restart survives the caller's death
- [ ] R10 `/restart` and `/restart all` in a session (builtin:roost), the foreground wording, the row in the hub's
      command table (`test/roost-commands.test.ts`)
- [ ] R11 hub `/restart`, and what it says about itself afterwards (decision 7)
- [ ] R12 attach: a terminal follows its session through a restart (decision 7)
- [ ] R13 tests per the spec: integration, PTY, the real Haiku check
- [ ] R14 docs: `roost.md` section, `cli.md`, `protocol.md`, hub help, the repository's `AGENTS.md`; R4's warning text
      names `xpi roost restart`
