# Port inventory

Every source and test file of pi-roost (main `890cbe9`) and where it went. The spec is
`.scratch/xpi-roost/01-roost-core.md`; "decision N" below is the spec's numbering.

- **ported**: moved whole (paths, `ROOST_*` names and the `xpi-roost.*` global symbols changed, nothing else of
  substance).
- **split**: the part phase 1 keeps moved; the cut part was not copied (decision 6: never copied and switched off).
- **cut**: not ported, with the decision that cuts it.

Phase 1 was built in five PRs (core, command line, session side, hub, docs); "PR N" below says which one moved a file.
Phase 2 (spec `.scratch/xpi-roost/02-schedules.md`: schedules and the login service) brought back what phase 1 cut for
schedules; "phase 2" below marks those rows. Resume after an interruption (M38, `autoResume`) stays cut: phase 2
decision 1 keeps phase 1's behaviour, which is Claude Code's.

The code moved into `src/` (`src/lib`, `src/daemon`, `src/host`, `src/hub`), as in every other package of the monorepo, so the
root `tsc`, biome and check scripts cover it unchanged.

## lib/

| pi-roost | xpi-roost | |
|---|---|---|
| `lib/agent-client.ts` | `src/lib/agent-client.ts` | split: `Reporter` and `jobIdentity` only; `RoostAgent` (the protocol client class, M31), `call` and the peer items (`agentItems`, `ack` `exact`) cut, decision 6 |
| `lib/agents.ts` | | cut: starting a session from an agent definition (M18), decision 6 |
| `lib/atomic.ts` | `src/lib/atomic.ts` | ported |
| `lib/attach.ts` | `src/lib/attach.ts` | ported; `REPAINT_MARKER` cut (M14, dead with a current host; the session side does not repaint, decision 11). PR 2: the hardcoded Ctrl+Z scan replaced by the caller's matcher over whole keys (decision 11), `DetachScanner` holds a key split over reads (any kind) until whole, a lone ESC still sent at once; the runtime directory is checked before connecting |
| `lib/board.ts` | | cut: task board (M47), decision 6 |
| `lib/callers.ts` | `src/lib/callers.ts` | split: three caller kinds (Person, Session, Unregistered agent); the `Concierge` kind, the foreground/background session forms, the task and order action rows and the peer ops cut, decision 6. Phase 2: the schedule ops, the person's only |
| `lib/client.ts` | `src/lib/client.ts` | ported; `packageRoot`, `daemonEntry` and `hostEntry` replaced by `DaemonStart` (the agent directory and the two entry files come from the caller, decision 7). Phase 2: `daemonCommand` and `daemonLocation` (what the daemon runs, shared with the login service) and `daemonElsewhere` (`other_runtime_dir`) |
| `lib/clock.ts` | `src/lib/clock.ts` | ported (phase 2): the schedules' clock |
| `lib/comms.ts` | | cut: messages between sessions (M50), decision 6 |
| `lib/concierge-module.ts` | | cut: concierge (M44 to M46), decision 6 |
| `lib/concierge.ts` | | cut: concierge, decision 6 |
| `lib/config.ts` | `src/lib/config.ts` | split: the `"roost"` section of `settings.json` (decision 9); `roost.json`, its paths and writers, the `agentProfiles`, concierge, `autoResume`, `subagentAutoClose`, `defaultToAgentsView`, `dispatchAgent`, `agentMax*` and summary-model keys cut; a preset keeps `model`, `thinking` and `dir` |
| `lib/dispatch-input.ts` | `src/lib/dispatch-input.ts` | ported |
| `lib/dispatch.ts` | `src/lib/dispatch.ts` | split: launch building and the environment (M20) kept; agent definitions, worktree isolation, profiles and `refusedByDaemon` cut, decision 6 |
| `lib/events.ts` | `src/lib/events.ts` | split: event kinds `dispatch`, `state`, `reply`, `resume` (DM-5 restarts) and `removed`; message, notice and concierge kinds cut, decision 6. Phase 2: kind `schedule` (a run started as due, catch-up or now, or a slot skipped) |
| `lib/filter.ts` | `src/lib/filter.ts` | split: the `pr` and `a:` tokens cut (M16, M18), decision 6 |
| `lib/framing.ts` | `src/lib/framing.ts` | ported |
| `lib/heuristics.ts` | `src/lib/heuristics.ts` | ported |
| `lib/hostclient.ts` | `src/lib/hostclient.ts` | ported (the daemon and the attach tests need it; not named in T3's list) |
| `lib/identity.ts` | `src/lib/identity.ts` | split: `ROOST_*` names only; the `PI_*` fallbacks cut (decision 9) |
| `lib/ids.ts` | `src/lib/ids.ts` | ported (not named in T3's list) |
| `lib/job-events.ts` | `src/lib/job-events.ts` | ported |
| `lib/list-format.ts` | `src/lib/list-format.ts` | ported (PR 2); no subagent rows or `--subagents`, no "ready" group (decision 6) |
| `lib/locks.ts` | `src/lib/locks.ts` | ported |
| `lib/op.ts` | `src/lib/op.ts` | ported (not named in T3's list) |
| `lib/orphans.ts` | `src/lib/orphans.ts` | ported; matches `src/daemon/main.ts` and `src/host/main.ts`, test directories `xroost-*` |
| `lib/paths.ts` | `src/lib/paths.ts` | split: state in `<agent dir>/xpi-roost/`, the runtime directory keyed by the agent directory (decision 9); `~/.pi/agent/roost` not here. PR 4: `scratchDir` and `isScratchSession` (the `/bg` hand-off) by agent directory, exported by `xpi-roost/session` |
| `lib/pi-commands.ts` | `xpi-coding-agent/src/extensions/roost/commands.ts` | cut here (decision 6): the table of xpi's slash commands is `builtin:roost`'s (PR 4, T18); `SessionCommand` and `sessionCommandsFrom` moved to `src/lib/store.ts` |
| `lib/pi-resolve.ts` | | cut: decision 6 |
| `lib/pr.ts` | | cut: pull request status (M16), decision 6 |
| `lib/proc.ts` | `src/lib/proc.ts` | ported (not named in T3's list) |
| `lib/profiles.ts` | | cut: terminal-agent profiles (M30), decision 6 |
| `lib/project-config.ts` | | cut: a task workspace's project settings (M54 to M60), decision 6 |
| `lib/protocol-schema.ts` | `src/lib/protocol-schema.ts` | split: decision 4's eighteen ops; the peer, send, handback, spawn, watch, task and concierge schemas and the rows and fields that served them cut. Phase 2: `schedules`, `schedule-add`, `schedule-edit` (new), `schedule-rm`, `schedule-pause`, `schedule-run` |
| `lib/protocol.ts` | `src/lib/protocol.ts` | split: the capabilities and events of phase 1 |
| `lib/resume.ts` | `src/lib/resume.ts` | ported (PR 2): `ensureLive`, the starting frame (AT-1) and `resumePrompt` (M5a: a failed run attached to is respawned with "Continue where you left off."). Phase 1 cuts the daemon resuming on its own, not this |
| `lib/review.ts` | | cut: workspaces (M58), decision 6 |
| `lib/schedule.ts`, `lib/schedules.ts` | `src/lib/schedule.ts`, `src/lib/schedules.ts` | ported (phase 2, M39, M40) and changed: `weekly` and `manual` rules, a 5-minute floor that does not depend on when it is checked, 50 schedules, `edit`, the launch built by the client and stored, catch-up of the latest slot within 7 days, the skip rules, retention of three ended runs, an unreadable file set aside; profiles, `!` commands, agent definitions, worktree templates and subagent auto-close not (they need what phase 1 cut). See `porting.md`, Phase 2 |
| (new) | `src/lib/service.ts` | phase 2: the login service (`xpi roost daemon install\|uninstall`, the line in `daemon status`): a launchd agent or a systemd user unit, its files from pure functions, launchctl and systemctl injected |
| `lib/schema.ts` | `src/lib/schema.ts` | ported |
| `lib/store.ts` | `src/lib/store.ts` | split: agent, fan-out, profile, term, protocol, role, parent/root session, worktree, task, verify and setup fields and their helpers cut, decision 6; the record format is otherwise unchanged. Phase 2: `schedule` and `scheduleId` back |
| `lib/summarizer.ts` | `src/lib/recap.ts` | split (PR 3): the recap's list (`AwayLog`, `emptyAway`, `awayIsEmpty`, `recapList`) moves; the summary model's prompts and parsers are cut, decision 6 |
| `lib/task-diff.ts`, `lib/task-git.ts`, `lib/task-worktree-worker.ts` | | cut: workspaces, decision 6 |
| `lib/telemetry.ts` | | cut: telemetry (M34), decision 6 |
| `lib/term-modes.ts` | `src/lib/term-modes.ts` | ported |
| `lib/term-signals.ts` | | cut: profile jobs only (T3) |
| `lib/text-width.ts` | `src/lib/text-width.ts` | ported (PR 2), for `list-format.ts`: xpi-roost imports nothing of xpi, so not xpi-tui's widths |
| `lib/transcript.ts` | `src/lib/transcript.ts` | ported less `pathOf` and `neighboursOf` (the subagent tree of M19, decision 3) |
| `lib/usage.ts` | `src/lib/usage.ts` | ported |
| `lib/version.ts` | `src/lib/version.ts` | ported (reads this package's version) |
| `lib/view-model.ts` | `src/lib/view-model.ts` | split: the "ready" group, task/profile rows and the subagent tree cut; the title says xpi agents |
| `lib/watches.ts` | | cut: watches (M43), decision 6 |
| `lib/worker-state.ts` | `src/lib/worker-state.ts` | ported |
| `lib/workspace-env.ts` | `src/lib/workspace-env.ts` | ported (`__ROOST_ENV__` markers, `ROOST_PROBE_DIR`) |
| `lib/workspace-view.ts`, `lib/workspace.ts`, `lib/worktree.ts` | | cut: workspaces and worktree isolation (M10, M54 to M60), decision 6 |

## Processes, entry points and the rest

| pi-roost | xpi-roost | |
|---|---|---|
| `daemon/main.ts` | `src/daemon/main.ts` | split: decision 4's ops, `events` included; settings from `<agent dir>/settings.json` `"roost"`; DM-5 restart of a crashed agent process with its delays and budget, a session whose host is gone ends (no M38, phase 2 decision 1); phase 2's schedules (the tick, runs, retention, `schedules.json`); no board, workspaces, concierge, orders, watches, messages, peers, `handback`, profiles, PR polling, worktree isolation, agent-definition dispatch, subagent auto-close or telemetry |
| `host/main.ts` | `src/host/main.ts` | split: no telemetry, no profile jobs (term signals, `term.json`, the `input` op), no repaint marker; `fixSpawnHelper` kept (decision 8); a session gets its roost's location (decision 7) |
| `hub/agent-view.ts` | `src/hub/agent-view.ts` | split (PR 4), on xpi-tui: the list (pin, reorder, grouping, filter), peek with the reply box and the session's commands (M48, M61), attach (M21, M22), new session, stop, rm, rename, resume and the model choice (M23), usage (M24), marks and batches (M25), steer and follow-up (M28), presets (model, thinking, directory: M27), the log, the help. xpi supplies `connect`, `isDetachKey`/`detachKeyName` (decision 11) and `builtins` (T18; the "reply" class is new: an extension command a session's worker runs). Cut (decision 6): the task board, workspaces, review, concierge and standing orders, fan-out and `/compare`, agent definitions and profiles (`a:`, `/profile`), worktrees (`/worktree`), PR status (`#N`), the subagent rows (decision 3), Ctrl+N, Ctrl+Y, Ctrl+E, `?` questions; their keys gone from the help. The header reads "xpi agents". New (PR 4 review): `selfId` (a session's own row, marked and never attached, stopped or deleted), a failing `commands()` gives none, a rejected `savePreset`/`onGroupBy` is said. Phase 2: `/schedule` (add, or the list) and the `↻ <schedule>` row marker |
| `hub/overlay-host.ts`, `hub/task-editor.ts`, `hub/text.ts`, `hub/theme.ts` | `src/hub/` | ported (PR 4); the overlay host without the board's reads |
| `hub/roost-port.ts` | `src/hub/roost-port.ts` | split (PR 4): `subscribe`, `listen`, `position`, `jobs`, `events`; the task and concierge groups cut. Phase 2: the schedules group |
| `hub/overlays/log.ts`, `hub/overlays/usage.ts` | `src/hub/overlays/` | split (PR 4): the log without the message, report and notice kinds (M9, decision 6) and with phase 1's empty texts; usage ported |
| (new) | `src/hub/index.ts` | the `xpi-roost/hub` entry (`check-entry-graphs.mjs`: at most 80 files, never the daemon, the host or the command line) |
| `hub/overlays/compare.ts` | | cut: fan-out and `/compare` (M26), decision 6 |
| `hub/overlays/concierge.ts` | | cut: concierge, decision 6 |
| `hub/overlays/review.ts`, `hub/overlays/tasks.ts`, `hub/overlays/workspaces.ts` | | cut: task board and workspaces, decision 6 |
| `hub/overlays/schedules.ts` | `src/hub/overlays/schedules.ts` | ported (phase 2): each schedule with its rule, next run, last run or skip; run now, pause or resume, edit the rule, remove |
| `adapters/pi/worker.ts` | `xpi-coding-agent/src/extensions/roost/worker.ts`, `detach-keys.ts` | split (PR 3): the reports, `ReplyQueue` (without agent items), `usageOf`, `contextOf`, the commands for the peek; the detach keys follow the user's keybindings (decision 11). Cut: agent items and `handback` (M9), the `roost_*` agent tools, PR links (M16), pi-mobile (M11), the worktree and task notes (M10, M55), decision 6 |
| `adapters/pi/worker-extras.ts` | `xpi-coding-agent/src/extensions/roost/recap.ts` | split (PR 3): `registerRecap` without the summary model's rewrite; `attachSignal` only with the SIGUSR2 handler in (decision 11). Cut: `registerSummaries` (SM-2, DI-9 naming), `askSummaryModel`, the repaint on attach (M14, dead with a current host) |
| `adapters/pi/earlier-history.ts` | `xpi-coding-agent/src/extensions/roost/earlier-history.ts` | ported (PR 3), on xpi's own message components |
| `adapters/pi/index.ts` | `xpi-coding-agent/src/extensions/roost/index.ts`, `background.ts` | split (PR 3): the write lock (DM-8), `--bg` and `--bg-name`, the worker role; `--bg` takes the `"roost"` settings' model, thinking level and environment. Cut: `--agent`, `--worktree`, `--agents`, `--agents-cwd` (decision 6), the concierge role, the M32 double-load guard (one built-in, one path), `setJobEventBus` (NT-2, the hub's: PR 4 sets it when the hub opens, in `open-view.ts`). PR 4 adds `/agents` and the foreground role |
| `adapters/pi/foreground.ts` | `xpi-coding-agent/src/extensions/roost/foreground.ts`, `handoff.ts`, `view-state.ts`, `hub.lazy.ts` | split (PR 4): `/bg`, `/background`, `/bg-fork` and the left arrow (`leftArrowOpensAgents`); the client, the launch and the hub load when used. Each session gets a trust decision by `sessionTrust`'s rule. The dispatch goes with `requestOnce`, and a lost answer is checked against the list by session file before falling back (PR 4 review). Cut: the quit offer (BG-9), the footer hint and its daemon poll (BG-11), `defaultToAgentsView` (decision 6), peers (decision 5) |
| `adapters/pi/open-view.ts` | `xpi-coding-agent/src/extensions/roost/open-view.ts` | split (PR 4): `/agents` over the conversation (`fullscreen`) or in place of the editor; the commands and the event bus come in its options. Cut: `--agents`, `--agents-cwd` (decision 6) |
| `adapters/pi/hub-options.ts` | `xpi-coding-agent/src/extensions/roost/hub-options.ts`, `commands.ts` | split (PR 4): launch, shell launch, resume and xpi's session selector, presets and grouping written to the user's settings through `SettingsManager.setRoostSetting`, notify, the detach key, the daemon of the agent directory, the trust decision (`trustFor`), the command table (T18). Cut: worktrees, agents, profiles, the concierge's launch. Phase 2: `scheduleLaunch` (a schedule's launch with the hub's session directory) |
| `adapters/pi/hub-main.ts` | `xpi-coding-agent/src/extensions/roost/hub-main.ts` | ported (PR 4) as `xpi roost hub [dir]` (`runRoostCli`'s `hub` option); the view is disposed when it ends |
| `adapters/pi/agent-tools.ts` | | cut: the `roost_*` agent tools, decision 6 |
| `adapters/pi/api.ts` | | cut: the programmatic API went with the published package (decision 1: `xpi-roost` is not published) |
| `adapters/pi/concierge.ts` | | cut: concierge, decision 6 |
| `adapters/pi/mobile.ts` | | cut: pi-mobile (M11), decision 6 |
| `adapters/pi/peer-link.ts` | | cut: decision 5 |
| `adapters/pi/pr-links.ts` | | cut: M16, decision 6 |
| `adapters/pi/subagent-panel.ts`, `adapters/pi/transcript-view.ts` | | cut: decision 3 |
| `adapters/pi/task-start.ts`, `adapters/pi/tasks-command.ts` | | cut: task board and workspaces, decision 6 |
| `bin/pi-roost.ts` | `src/cli.ts` | ported (PR 2) as `runRoostCli`, run by `xpi roost <subcommand>` (decision 7; no `pi-roost` executable). Phase 2: `schedule list\|add\|edit\|run\|pause\|resume\|rm` (the launch built by the caller's `scheduleLaunch`) and `daemon install\|uninstall`. Cut: `review`, the raw `--json` op, `--version` (`xpi --version`), `list --subagents` (decisions 6, 7); `hub` runs the caller's `hub` option (PR 4). The detach key comes from the caller; without node-pty (`ptyInstalled: false`) only `respawn` and `attach` to a session that is not running are refused |
| `extensions/index.ts` | | cut: decision 6 |
| `sdk/python/roost_agent.py` | | cut: the Python SDK, decision 6 |
| `scripts/protocol-doc.ts` | `test/support/protocol-doc.ts` | ported; writes `docs/protocol.md` (`npm run docs:protocol` in this package) |
| `scripts/fix-dts.mjs`, `scripts/install-local.sh` | | cut: pi-roost's own packaging |
| `evals/*`, `stress/*`, `spikes/*` | | cut: decision 6 |
| `vitest.config.ts` | `vitest.config.ts` | ported (forks pool, the orphan sweep as global setup) |
| `vitest.evals.config.ts`, `tsconfig.json`, `tsconfig.build.json` | | cut: the monorepo's own configuration covers the package |

## test/

| pi-roost | xpi-roost | |
|---|---|---|
| `agent-view.test.ts` (and its snapshot) | `test/agent-view.test.ts` | split (PR 4): the tests of cut features removed (M13, M16, M18, M26, M30, M44 to M47, M55, M57 to M60, `/worktree`, the board's, review's, workspaces', concierge's and compare's pinned screens, the Ctrl+N and concierge layers); presets without agents and fan-out; xpi's commands from `test/support/builtins.ts`; a test of a "reply" command. Snapshots regenerated where the header ("xpi agents"), the help, the filter hint or the log's kinds changed |
| `fit-screen.test.ts`, `usage-overlay.test.ts` | `test/` | ported (PR 4) |
| `log-overlay.test.ts` | `test/log-overlay.test.ts` | split (PR 4): replies in place of messages; phase 1's empty texts |
| `roost-port.test.ts` | `test/roost-port.test.ts` | split (PR 4): the session and event rows |
| `hub-standalone.test.ts` | `xpi-coding-agent/test/roost-hub-pty.test.ts`, `roost-hub-options.test.ts` | rewritten (PR 4): `xpi roost hub` in a pty (built xpi, a fake model, a real daemon), its arguments and model list |
| (new) | `xpi-coding-agent/test/roost-hub-options.test.ts` | the trust decision of a session the hub starts, settings written back, the hub's options |
| (new) | `xpi-coding-agent/test/roost-commands.test.ts` | T18: every command of xpi and its built-in extensions has a class |
| `agents.test.ts` | | cut: M18, decision 6 |
| `atomic.test.ts` | `test/atomic.test.ts` | ported |
| `attach-keys.test.ts` | `test/attach-keys.test.ts` | ported; PR 2: rewritten for the caller's matcher (the key encodings are tested in coding-agent's `test/roost-cli.test.ts`) |
| `board.test.ts`, `task-diff.test.ts`, `task-git.test.ts`, `tasks-command.test.ts`, `tasks-overlay.test.ts`, `review.test.ts`, `review-overlay.test.ts`, `workspace.test.ts`, `workspace-view.test.ts`, `workspaces-overlay.test.ts`, `worktree.test.ts`, `project-config.test.ts` | | cut: task board, workspaces, worktree isolation, decision 6 |
| `callers.test.ts` | `test/callers.test.ts` | split: three caller kinds and eighteen ops |
| `callers-matrix.test.ts` (and its snapshot) | `test/callers-matrix.test.ts` | split: Person, Session, Unregistered agent; two unported ops shown as unknown; snapshot regenerated |
| `list-format.test.ts` | `test/list-format.test.ts` | ported (PR 2) without subagents; plus wide names, control characters and text-width cases |
| `cli-deps.test.ts` | | cut: the bundle check (`build-coding-agent-bundle.mjs`: only the host imports node-pty) and `check-entry-graphs.mjs` (each entry forbids the others) cover it; its layer and adapter tests have nothing to check here |
| (new) | `test/cli.test.ts` | `xpi roost` against a real daemon: every command on a shell session, the agent directory over another roost's variables, `daemon stop` with and without `--keep-workers`, `log --follow`, `attach` in a pty (an ended session started first, detach, without node-pty) |
| (new) | `test/cli-version.test.ts` | the version warning (the CLI's version mocked, the daemon real) |
| (new) | `test/resume.test.ts` | `resumePrompt` and the respawn `ensureLive` asks for |
| `client-order.test.ts` | `test/client-order.test.ts` | ported |
| `comms.test.ts`, `tool-fields.test.ts`, `watches.test.ts` | | cut: messages, agent tools, watches, decision 6 |
| `compare-overlay.test.ts` | | cut: M26, decision 6 |
| `concierge.test.ts`, `concierge-module.test.ts`, `concierge-overlay.test.ts` | | cut: concierge, decision 6 |
| `config.test.ts` | `test/config.test.ts` | split: rewritten for the `"roost"` section and the user-only keys |
| `daemon.test.ts` | `test/daemon.test.ts` | split: the tests of M11, M26, M30, M31's protocol client, M34, M35's agent part, M38, M39, M40, `peer_register`, `autoResume` and the conformance suite removed whole; host-gone and killed-host tests now expect the session to end. Phase 2 adds its own schedule tests (runs, skips, catch-up, retention, the file) |
| `dispatch-input.test.ts` | `test/dispatch-input.test.ts` | ported |
| `dispatch.test.ts` | `test/dispatch.test.ts` | ported (imports made static, `ROOST_JOB_ID`) |
| `earlier-history.test.ts` | `xpi-coding-agent/test/roost-earlier-history.test.ts` | ported (PR 3) |
| `reply-queue.test.ts` | `xpi-coding-agent/test/roost-reply-queue.test.ts` | ported (PR 3) without the agent items (M9) |
| `reporter.test.ts` | `xpi-coding-agent/test/roost-reporter.test.ts` | ported (PR 3) |
| `worker-wiring.test.ts` | `xpi-coding-agent/test/roost-worker-wiring.test.ts` | ported (PR 3); plus the reports and replies against a fake daemon, and the detach keys wired to a fake xpi |
| (new) | `xpi-coding-agent/test/roost-detach-keys.test.ts` | the detach keys with default and rebound keybindings |
| (new) | `xpi-coding-agent/test/roost-session.test.ts` | the write lock, an ordinary start (no daemon contacted), a subagent child, `--bg` (messages, settings, a session under a real daemon), SIGUSR2 |
| `entry-check.test.ts` | `test/entry-check.test.ts` | split: the cases of unported ops removed |
| `evals-judge.test.ts` | | cut: `evals/`, decision 6 |
| `events.test.ts` | `test/events.test.ts` | split: cut kinds removed |
| `foreground.test.ts` | `xpi-coding-agent/test/roost-foreground.test.ts` | split (PR 4): the left arrow, `/bg`, `/bg-fork` and the trust decision; the quit offer and footer tests cut with them |
| `framing.test.ts` | `test/framing.test.ts` | ported |
| `host.test.ts` | `test/host.test.ts` | split: the profile part of M61 removed; a decision 7 test added (a session's location variables) |
| `identity.test.ts` | `test/identity.test.ts` | split: `ROOST_*` only; the `roost.json` path cases removed (decision 9) |
| `lib-core.test.ts` | `test/lib-core.test.ts` | ported; tests added for the paths by agent directory (decision 9) |
| `mobile.test.ts` | | cut: M11, decision 6 |
| `orphans.test.ts` | `test/orphans.test.ts` | ported |
| `pi-commands.test.ts` | `xpi-coding-agent/test/roost-commands.test.ts` | rewritten (PR 4, T18) for `builtin:roost`'s table |
| `pr.test.ts` | | cut: M16, decision 6 |
| `profiles.test.ts` | | cut: M30, decision 6 |
| `protocol-doc.test.ts` | `test/protocol-doc.test.ts` | split: the Python SDK and the task/order action checks removed; the import graph checks that `src/` loads no xpi package |
| `request-once.test.ts` | `test/request-once.test.ts` | split: the `refusedByDaemon` assertion removed (worktree isolation, M10, decision 6) |
| `schedule.test.ts`, `schedules.test.ts`, `schedules-overlay.test.ts` | `test/schedule.test.ts`, `test/schedules.test.ts`, `test/schedules-overlay.test.ts` | ported (phase 2) with the changes of the rows above |
| (new) | `test/service.test.ts` | phase 2: the login service's files, and install, uninstall and status with a fake launchctl and systemctl |
| `schema.test.ts` | `test/schema.test.ts` | ported |
| `stress-attach.test.ts` | `test/stress-attach.test.ts` | ported |
| `subagent-panel.test.ts` | | cut: decision 3 |
| `summaries.test.ts` | `test/job-events.test.ts`, `test/recap.test.ts` | split: the job events part moved (with a first-sighting case added); the away log moved with the recap (PR 3, plus a case); the summary model cut, decision 6 |
| `telemetry.test.ts` | | cut: M34, decision 6 |
| `term-modes.test.ts` | `test/term-modes.test.ts` | ported |
| `transcript.test.ts` | `test/transcript.test.ts` | split: the M19 view and tree removed (decision 3) |
| `usage.test.ts` | `test/usage.test.ts` | ported |
| `view-model.test.ts` | `test/view-model.test.ts` | ported (the title says xpi agents; imports made static) |
| `worker-state.test.ts` | `test/worker-state.test.ts` | ported |
| `workspace-env.test.ts` | `test/workspace-env.test.ts` | ported |
| `support/global-setup.ts` | `test/support/global-setup.ts` | ported; sweeps again after the suite |
| `support/clock.ts` | `test/support/clock.ts` | ported (phase 2) |
| `support/overlay-host.ts` | `test/support/overlay-host.ts` | split (PR 4): without the board's task and workspace builders |
| `support/overlay-keys.ts`, `support/roost-port.ts` | `test/support/` | ported (PR 4) |
| (new) | `test/support/builtins.ts` | PR 4: a copy of `builtin:roost`'s command table for the hub's tests |
| `fixtures/agent-py.py`, `fixtures/agent-ts.ts`, `fixtures/fake-agent.mjs` | | cut: the protocol clients and terminal-agent profiles (M30, M31), decision 6 |
| `fixtures/ask-extension.ts` | | cut: only pi-roost's manual M2 check used it; the worker's dialog tests drive a fake xpi |
| | `test/agent-dirs.test.ts` | new: two agent directories, two daemons, no shared socket, job or roster; each reads its own `settings.json` (decision 9) |

## Docs

| pi-roost | xpi-roost | |
|---|---|---|
| `docs/porting.md` | `docs/porting.md` | split (PR 5): rewritten in English for phase 1 (decision 15 of the spec); the steps, settings, constants and ops of cut features left out, with a table of what was left out and why. Phase 2 adds its section (schedules, the login service, the decision on resume) |
| `docs/protocol.md` | `docs/protocol.md` | split (PR 1): phase 1's ops, generated from the schemas; phase 2's schedule ops |
| `README.md` | `README.md`, `xpi-coding-agent/docs/roost.md`, `xpi-coding-agent/docs/cli.md` | rewritten: the package README for developers, the user guide and the CLI reference in the coding agent's docs |
| `docs/profiles.md` | | cut: terminal-agent profiles (M30), decision 6 |
| `docs/summary-model.md` | | cut: the summary model, decision 6 |
| `docs/plans/*`, `docs/agents/*`, `GLOSSARY.md`, `CHANGELOG.md`, `CLAUDE.md` | | not ported: pi-roost's own records; the terms are in the spec, the history in pi-roost's repository |

## Environment variables

Only `ROOST_*` is read (decision 9). The renames of what phase 1 keeps:

| pi-roost | xpi-roost |
|---|---|
| `PI_JOB_ID` | `ROOST_JOB_ID` (pi-roost already set both) |
| `PI_JOB_TOKEN` | `ROOST_JOB_TOKEN` (both before) |
| `PI_DAEMON_SOCK` | `ROOST_SOCKET` (both before) |
| `PI_JOB_DIR` | `ROOST_JOB_DIR` (both before) |
| `PI_ROOST_RESTORE` | `ROOST_RESTORE` |
| `PI_ROOST_HOME` | `ROOST_HOME` |
| `PI_ROOST_RUNTIME_DIR` | `ROOST_RUNTIME_DIR` |
| `PI_ROOST_HOST_ENTRY` | `ROOST_HOST_ENTRY` |
| `PI_ROOST_PARENT_PID` | `ROOST_PARENT_PID` (tests only, M78) |
| `PI_ROOST_PROBE_DIR` | `ROOST_PROBE_DIR` (the workspace environment probe) |
| `PI_ROOST_CLEANUP_DAYS`, `PI_ROOST_CLEANUP_CHECK_MS` | `ROOST_CLEANUP_DAYS`, `ROOST_CLEANUP_CHECK_MS` |
| `PI_ROOST_REAP_MINUTES`, `PI_ROOST_REAP_CHECK_MS` | `ROOST_REAP_MINUTES`, `ROOST_REAP_CHECK_MS` |
| `PI_ROOST_SHELL_KEEP_MS` | `ROOST_SHELL_KEEP_MS` |
| `PI_ROOST_RESUME_DELAYS_MS` | `ROOST_RESUME_DELAYS_MS` (the DM-5 restart delays) |
| `PI_ROOST_SCHEDULE_TICK_MS` | `ROOST_SCHEDULE_TICK_MS` (phase 2, tests) |
| `__PI_ROOST_ENV__`, `__PI_ROOST_END__` (probe markers, not variables) | `__ROOST_ENV__`, `__ROOST_END__` |

New: `ROOST_AGENT_DIR`, the agent directory a roost belongs to (decision 7). The client that starts the daemon sets
it with `ROOST_HOME`, `ROOST_RUNTIME_DIR` and `ROOST_HOST_ENTRY`; a session also gets `XPI_CODING_AGENT_DIR`.

Gone with their features: `PI_ROOST_CONFIG_DIR` and `ROOST_CONFIG_DIR` (`roost.json`, decision 9),
`PI_ROOST_CONCIERGE_*`, `PI_ROOST_WATCH_TTL_MS`, `PI_ROOST_PR_POLL_MS`, `PI_ROOST_GH`,
`PI_ROOST_PREPARED_MS`, `PI_ROOST_HAND_MERGE_MS`, `PI_ROOST_FG_CLAIM_GRACE_MS`, `PI_ROOST_AUTO_CLOSE_MS`,
`PI_ROOST_CHILD`, `ROOST_ROLE`, `ROOST_TASK_ID`, `ROOST_WORKTREE`, `ROOST_BRANCH`, `ROOST_BASE`,
`ROOST_VERIFY_LOG`, `ROOST_TELEMETRY`, `ROOST_PI_PACKAGE`, `ROOST_EVAL_DIR`.
