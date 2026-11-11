# Port inventory

Every source and test file of pi-roost (main `890cbe9`) and where it went. The spec is
`.scratch/xpi-roost/01-roost-core.md`; "decision N" below is the spec's numbering.

- **ported**: moved whole (paths, `ROOST_*` names and the `xpi-roost.*` global symbols changed, nothing else of
  substance).
- **split**: the part phase 1 keeps moved; the cut part was not copied (decision 6: never copied and switched off).
- **cut**: not ported, with the decision that cuts it.
- **later**: in phase 1 but moved by a later PR of the five (decision 12 of the grill: core, command line, session
  side, hub, docs).

The code moved into `src/` (`src/lib`, `src/daemon`, `src/host`), as in every other package of the monorepo, so the
root `tsc`, biome and check scripts cover it unchanged.

## lib/

| pi-roost | xpi-roost | |
|---|---|---|
| `lib/agent-client.ts` | `src/lib/agent-client.ts` | split: `Reporter` and `jobIdentity` only; `RoostAgent` (the protocol client class, M31), `call` and the peer items (`agentItems`, `ack` `exact`) cut, decision 6 |
| `lib/agents.ts` | | cut: starting a session from an agent definition (M18), decision 6 |
| `lib/atomic.ts` | `src/lib/atomic.ts` | ported |
| `lib/attach.ts` | `src/lib/attach.ts` | ported; `REPAINT_MARKER` cut (M14, dead with a current host; the session side does not repaint, decision 11) |
| `lib/board.ts` | | cut: task board (M47), decision 6 |
| `lib/callers.ts` | `src/lib/callers.ts` | split: three caller kinds (Person, Session, Unregistered agent); the `Concierge` kind, the foreground/background session forms, the task and order action rows and the peer ops cut, decision 6 |
| `lib/client.ts` | `src/lib/client.ts` | ported; `packageRoot`, `daemonEntry` and `hostEntry` replaced by `DaemonStart` (the agent directory and the two entry files come from the caller, decision 7) |
| `lib/clock.ts` | | cut: the clock of schedules and watches, decision 6 |
| `lib/comms.ts` | | cut: messages between sessions (M50), decision 6 |
| `lib/concierge-module.ts` | | cut: concierge (M44 to M46), decision 6 |
| `lib/concierge.ts` | | cut: concierge, decision 6 |
| `lib/config.ts` | `src/lib/config.ts` | split: the `"roost"` section of `settings.json` (decision 9); `roost.json`, its paths and writers, the `agentProfiles`, concierge, `autoResume`, `subagentAutoClose`, `defaultToAgentsView`, `dispatchAgent`, `agentMax*` and summary-model keys cut; a preset keeps `model`, `thinking` and `dir` |
| `lib/dispatch-input.ts` | `src/lib/dispatch-input.ts` | ported |
| `lib/dispatch.ts` | `src/lib/dispatch.ts` | split: launch building and the environment (M20) kept; agent definitions, worktree isolation, profiles and `refusedByDaemon` cut, decision 6 |
| `lib/events.ts` | `src/lib/events.ts` | split: event kinds `dispatch`, `state`, `reply`, `resume` (DM-5 restarts) and `removed`; message, notice, schedule and concierge kinds cut, decision 6 |
| `lib/filter.ts` | `src/lib/filter.ts` | split: the `pr` and `a:` tokens cut (M16, M18), decision 6 |
| `lib/framing.ts` | `src/lib/framing.ts` | ported |
| `lib/heuristics.ts` | `src/lib/heuristics.ts` | ported |
| `lib/hostclient.ts` | `src/lib/hostclient.ts` | ported (the daemon and the attach tests need it; not named in T3's list) |
| `lib/identity.ts` | `src/lib/identity.ts` | split: `ROOST_*` names only; the `PI_*` fallbacks cut (decision 9) |
| `lib/ids.ts` | `src/lib/ids.ts` | ported (not named in T3's list) |
| `lib/job-events.ts` | `src/lib/job-events.ts` | ported |
| `lib/list-format.ts` | | later: PR 2 (`xpi roost ls`) |
| `lib/locks.ts` | `src/lib/locks.ts` | ported |
| `lib/op.ts` | `src/lib/op.ts` | ported (not named in T3's list) |
| `lib/orphans.ts` | `src/lib/orphans.ts` | ported; matches `src/daemon/main.ts` and `src/host/main.ts`, test directories `xroost-*` |
| `lib/paths.ts` | `src/lib/paths.ts` | split: state in `<agent dir>/xpi-roost/`, the runtime directory keyed by the agent directory (decision 9); `~/.pi/agent/roost`, `scratchDir` (the `/bg` hand-off, PR 4) not here |
| `lib/pi-commands.ts` | | cut: decision 6 (the table of xpi's slash commands is `builtin:roost`'s, PR 4); `SessionCommand` and `sessionCommandsFrom` moved to `src/lib/store.ts` |
| `lib/pi-resolve.ts` | | cut: decision 6 |
| `lib/pr.ts` | | cut: pull request status (M16), decision 6 |
| `lib/proc.ts` | `src/lib/proc.ts` | ported (not named in T3's list) |
| `lib/profiles.ts` | | cut: terminal-agent profiles (M30), decision 6 |
| `lib/project-config.ts` | | cut: a task workspace's project settings (M54 to M60), decision 6 |
| `lib/protocol-schema.ts` | `src/lib/protocol-schema.ts` | split: decision 4's eighteen ops; the peer, send, handback, spawn, watch, schedule, task and concierge schemas and the rows and fields that served them cut |
| `lib/protocol.ts` | `src/lib/protocol.ts` | split: the capabilities and events of phase 1 |
| `lib/resume.ts` | | later: PR 2 (`attach` starts an ended session first, AT-1) |
| `lib/review.ts` | | cut: workspaces (M58), decision 6 |
| `lib/schedule.ts`, `lib/schedules.ts` | | cut: schedules (M39, M40) are phase 2, decision 6 |
| `lib/schema.ts` | `src/lib/schema.ts` | ported |
| `lib/store.ts` | `src/lib/store.ts` | split: agent, fan-out, profile, schedule, term, protocol, role, parent/root session, worktree, task, verify and setup fields and their helpers cut, decision 6; the record format is otherwise unchanged |
| `lib/summarizer.ts` | | later: the recap without the summary model (PR 3); the summary model cut, decision 6 |
| `lib/task-diff.ts`, `lib/task-git.ts`, `lib/task-worktree-worker.ts` | | cut: workspaces, decision 6 |
| `lib/telemetry.ts` | | cut: telemetry (M34), decision 6 |
| `lib/term-modes.ts` | `src/lib/term-modes.ts` | ported |
| `lib/term-signals.ts` | | cut: profile jobs only (T3) |
| `lib/text-width.ts` | | later: PR 2, with `list-format.ts` (or xpi-tui's widths) |
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
| `daemon/main.ts` | `src/daemon/main.ts` | split: decision 4's ops, `events` included; settings from `<agent dir>/settings.json` `"roost"`; DM-5 restart of a crashed agent process with its delays and budget, a session whose host is gone ends (no M38); no board, workspaces, concierge, orders, schedules, watches, messages, peers, `handback`, profiles, PR polling, worktree isolation, agent-definition dispatch, subagent auto-close or telemetry |
| `host/main.ts` | `src/host/main.ts` | split: no telemetry, no profile jobs (term signals, `term.json`, the `input` op), no repaint marker; `fixSpawnHelper` kept (decision 8); a session gets its roost's location (decision 7) |
| `hub/agent-view.ts`, `hub/overlay-host.ts`, `hub/roost-port.ts`, `hub/task-editor.ts`, `hub/text.ts`, `hub/theme.ts`, `hub/overlays/log.ts`, `hub/overlays/usage.ts` | | later: PR 4 (split there as decision 6 says) |
| `hub/overlays/compare.ts` | | cut: fan-out and `/compare` (M26), decision 6 |
| `hub/overlays/concierge.ts` | | cut: concierge, decision 6 |
| `hub/overlays/review.ts`, `hub/overlays/tasks.ts`, `hub/overlays/workspaces.ts` | | cut: task board and workspaces, decision 6 |
| `hub/overlays/schedules.ts` | | cut: schedules, decision 6 |
| `adapters/pi/worker.ts`, `adapters/pi/worker-extras.ts`, `adapters/pi/earlier-history.ts` | | later: PR 3 (`builtin:roost`, the session side; split there) |
| `adapters/pi/index.ts`, `adapters/pi/foreground.ts`, `adapters/pi/hub-main.ts`, `adapters/pi/hub-options.ts`, `adapters/pi/open-view.ts` | | later: PR 3 and PR 4 (`builtin:roost`, `/bg`, the hub's options) |
| `adapters/pi/agent-tools.ts` | | cut: the `roost_*` agent tools, decision 6 |
| `adapters/pi/api.ts` | | cut: the programmatic API went with the published package (decision 1: `xpi-roost` is not published) |
| `adapters/pi/concierge.ts` | | cut: concierge, decision 6 |
| `adapters/pi/mobile.ts` | | cut: pi-mobile (M11), decision 6 |
| `adapters/pi/peer-link.ts` | | cut: decision 5 |
| `adapters/pi/pr-links.ts` | | cut: M16, decision 6 |
| `adapters/pi/subagent-panel.ts`, `adapters/pi/transcript-view.ts` | | cut: decision 3 |
| `adapters/pi/task-start.ts`, `adapters/pi/tasks-command.ts` | | cut: task board and workspaces, decision 6 |
| `bin/pi-roost.ts` | | later: PR 2 (`xpi roost <subcommand>`, decision 7; no `pi-roost` executable) |
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
| `agent-view.test.ts`, `fit-screen.test.ts`, `hub-standalone.test.ts`, `log-overlay.test.ts`, `roost-port.test.ts`, `usage-overlay.test.ts` | | later: PR 4 |
| `agents.test.ts` | | cut: M18, decision 6 |
| `atomic.test.ts` | `test/atomic.test.ts` | ported |
| `attach-keys.test.ts` | `test/attach-keys.test.ts` | ported |
| `board.test.ts`, `task-diff.test.ts`, `task-git.test.ts`, `tasks-command.test.ts`, `tasks-overlay.test.ts`, `review.test.ts`, `review-overlay.test.ts`, `workspace.test.ts`, `workspace-view.test.ts`, `workspaces-overlay.test.ts`, `worktree.test.ts`, `project-config.test.ts` | | cut: task board, workspaces, worktree isolation, decision 6 |
| `callers.test.ts` | `test/callers.test.ts` | split: three caller kinds and eighteen ops |
| `callers-matrix.test.ts` (and its snapshot) | `test/callers-matrix.test.ts` | split: Person, Session, Unregistered agent; two unported ops shown as unknown; snapshot regenerated |
| `cli-deps.test.ts`, `list-format.test.ts` | | later: PR 2 |
| `client-order.test.ts` | `test/client-order.test.ts` | ported |
| `comms.test.ts`, `tool-fields.test.ts`, `watches.test.ts` | | cut: messages, agent tools, watches, decision 6 |
| `compare-overlay.test.ts` | | cut: M26, decision 6 |
| `concierge.test.ts`, `concierge-module.test.ts`, `concierge-overlay.test.ts` | | cut: concierge, decision 6 |
| `config.test.ts` | `test/config.test.ts` | split: rewritten for the `"roost"` section and the user-only keys |
| `daemon.test.ts` | `test/daemon.test.ts` | split: the tests of M11, M26, M30, M31's protocol client, M34, M35's agent part, M38, M39, M40, `peer_register`, `autoResume` and the conformance suite removed whole; host-gone and killed-host tests now expect the session to end |
| `dispatch-input.test.ts` | `test/dispatch-input.test.ts` | ported |
| `dispatch.test.ts` | `test/dispatch.test.ts` | ported (imports made static, `ROOST_JOB_ID`) |
| `earlier-history.test.ts`, `reply-queue.test.ts`, `reporter.test.ts`, `worker-wiring.test.ts` | | later: PR 3 (adapter tests move to `xpi-coding-agent`, decision 13) |
| `entry-check.test.ts` | `test/entry-check.test.ts` | split: the cases of unported ops removed |
| `evals-judge.test.ts` | | cut: `evals/`, decision 6 |
| `events.test.ts` | `test/events.test.ts` | split: cut kinds removed |
| `foreground.test.ts` | | later: PR 4 (`/bg`) |
| `framing.test.ts` | `test/framing.test.ts` | ported |
| `host.test.ts` | `test/host.test.ts` | split: the profile part of M61 removed; a decision 7 test added (a session's location variables) |
| `identity.test.ts` | `test/identity.test.ts` | split: `ROOST_*` only; the `roost.json` path cases removed (decision 9) |
| `lib-core.test.ts` | `test/lib-core.test.ts` | ported; tests added for the paths by agent directory (decision 9) |
| `mobile.test.ts` | | cut: M11, decision 6 |
| `orphans.test.ts` | `test/orphans.test.ts` | ported |
| `pi-commands.test.ts` | | cut: decision 6 (the table's test comes with PR 4, T18) |
| `pr.test.ts` | | cut: M16, decision 6 |
| `profiles.test.ts` | | cut: M30, decision 6 |
| `protocol-doc.test.ts` | `test/protocol-doc.test.ts` | split: the Python SDK and the task/order action checks removed; the import graph checks that `src/` loads no xpi package |
| `request-once.test.ts` | `test/request-once.test.ts` | split: the `refusedByDaemon` assertion removed (worktree isolation, M10, decision 6) |
| `schedule.test.ts`, `schedules.test.ts`, `schedules-overlay.test.ts` | | cut: schedules (phase 2), decision 6 |
| `schema.test.ts` | `test/schema.test.ts` | ported |
| `stress-attach.test.ts` | `test/stress-attach.test.ts` | ported |
| `subagent-panel.test.ts` | | cut: decision 3 |
| `summaries.test.ts` | `test/job-events.test.ts` | split: the job events part moved (with a first-sighting case added); the away log goes with the recap (PR 3); the summary model cut, decision 6 |
| `telemetry.test.ts` | | cut: M34, decision 6 |
| `term-modes.test.ts` | `test/term-modes.test.ts` | ported |
| `transcript.test.ts` | `test/transcript.test.ts` | split: the M19 view and tree removed (decision 3) |
| `usage.test.ts` | `test/usage.test.ts` | ported |
| `view-model.test.ts` | `test/view-model.test.ts` | ported (the title says xpi agents; imports made static) |
| `worker-state.test.ts` | `test/worker-state.test.ts` | ported |
| `workspace-env.test.ts` | `test/workspace-env.test.ts` | ported |
| `support/global-setup.ts` | `test/support/global-setup.ts` | ported; sweeps again after the suite |
| `support/clock.ts` | | cut: with schedules and watches |
| `support/overlay-host.ts`, `support/overlay-keys.ts`, `support/roost-port.ts` | | later: PR 4 |
| `fixtures/agent-py.py`, `fixtures/agent-ts.ts`, `fixtures/fake-agent.mjs` | | cut: the protocol clients and terminal-agent profiles (M30, M31), decision 6 |
| `fixtures/ask-extension.ts` | | later: PR 3, if the worker's dialog tests use it |
| | `test/agent-dirs.test.ts` | new: two agent directories, two daemons, no shared socket, job or roster; each reads its own `settings.json` (decision 9) |

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
| `__PI_ROOST_ENV__`, `__PI_ROOST_END__` (probe markers, not variables) | `__ROOST_ENV__`, `__ROOST_END__` |

New: `ROOST_AGENT_DIR`, the agent directory a roost belongs to (decision 7). The client that starts the daemon sets
it with `ROOST_HOME`, `ROOST_RUNTIME_DIR` and `ROOST_HOST_ENTRY`; a session also gets `XPI_CODING_AGENT_DIR`.

Gone with their features: `PI_ROOST_CONFIG_DIR` and `ROOST_CONFIG_DIR` (`roost.json`, decision 9),
`PI_ROOST_CONCIERGE_*`, `PI_ROOST_SCHEDULE_TICK_MS`, `PI_ROOST_WATCH_TTL_MS`, `PI_ROOST_PR_POLL_MS`, `PI_ROOST_GH`,
`PI_ROOST_PREPARED_MS`, `PI_ROOST_HAND_MERGE_MS`, `PI_ROOST_FG_CLAIM_GRACE_MS`, `PI_ROOST_AUTO_CLOSE_MS`,
`PI_ROOST_CHILD`, `ROOST_ROLE`, `ROOST_TASK_ID`, `ROOST_WORKTREE`, `ROOST_BRANCH`, `ROOST_BASE`,
`ROOST_VERIFY_LOG`, `ROOST_TELEMETRY`, `ROOST_PI_PACKAGE`, `ROOST_EVAL_DIR`.
