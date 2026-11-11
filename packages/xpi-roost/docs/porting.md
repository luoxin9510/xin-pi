# Porting roost

How background sessions work in xin-pi, for an engineer who rebuilds them in another host agent. It replaces
pi-roost's `docs/porting.md` (written in Chinese against pi-roost v0.1.21, main `890cbe9`), cut to what xin-pi's
phase 1 has: the daemon, the PTY host, `xpi roost`, the hub and the session side. Everything pi-roost had beyond that
is listed in [Left out of phase 1](#left-out-of-phase-1) with the decision that cut it; pi-roost's own document stays in
its repository for those parts.

The code: `packages/xpi-roost` (the core, the command line and the hub) and `builtin:roost`
(`packages/xpi-coding-agent/src/extensions/roost/`, the adapter). The spec and its decisions are
`.scratch/xpi-roost/01-roost-core.md` and `.scratch/xpi-roost/decisions.md`; "decision N" below is the spec's
numbering. `port-inventory.md` lists every pi-roost file and where it went, `protocol.md` every op. The user guide is
`packages/xpi-coding-agent/docs/roost.md`.

## The architecture in one picture

```text
 xpi (/agents, xpi roost hub) ──┐                       ┌── host ── PTY ── xpi, worker role (session A)
 xpi (any foreground session) ──┼── unix socket ── daemon ── host ── PTY ── xpi, worker role (session B)
 xpi roost <command> ───────────┘   (JSON lines)        └── host ── PTY ── sh -lc "npm test"
                                                           ↑ host socket (binary frames)
```

| Part | Files | Processes | Knows the host agent? |
|---|---|---|---|
| daemon | `xpi-roost/src/daemon/main.ts` | one per user and agent directory, started on demand | no |
| host | `xpi-roost/src/host/main.ts` | one per session; holds the PTY and a headless mirror of the screen | no (node-pty, `@xterm/headless`, `@xterm/addon-serialize`) |
| command line | `xpi-roost/src/cli.ts` (`runRoostCli`), run by `xpi roost` | short-lived | no: the caller gives the agent directory, the entry files and the detach key |
| library | `xpi-roost/src/lib/` | | no |
| hub | `xpi-roost/src/hub/` | inside xpi (`/agents`) or its own terminal (`xpi roost hub`) | draws with `xpi-tui` only; everything about xpi comes in `AgentViewOptions` |
| adapter | `xpi-coding-agent/src/extensions/roost/` (`builtin:roost`) | loaded in every xpi process | yes: the only part that does |

A background session is an ordinary interactive xpi running in a pseudo-terminal that a host process holds. Attaching
passes a real terminal through to it, so the user sees xpi's own TUI; detaching leaves the process running. The
adapter inside that xpi reports its state and takes replies; it does not change how xpi works.

Decision 1 keeps the core free of the host agent: `xpi-roost` imports nothing of xpi except `xpi-tui`, and that only
under `src/hub/` (`test/protocol-doc.test.ts` checks the import graph; `scripts/check-entry-graphs.mjs` keeps each
entry from loading the others). To port roost, keep `xpi-roost` as it is, rewrite the adapter, and give the hub a TUI
library that offers what `xpi-tui` gives it (or rewrite the hub against `RoostPort`, `src/hub/roost-port.ts`, its only
seam to the daemon).

## What the host agent must have

Marked ★: without it the design does not work.

### Process and command line

| | What | In xpi | Used for |
|---|---|---|---|
| C1 ★ | The interactive TUI runs in a PTY | `xpi` | the worker is that process |
| C2 ★ | Continue a session from its file: `--session <file>` | `--session` | starting, restarting and respawning a worker |
| C3 ★ | A first prompt on the command line after `--` | positional message | a new session's task |
| C4 ★ | A session file path can be chosen before the first write | `SessionManager.create(cwd, dir).getSessionFile()`; xpi writes the file with its first reply | the daemon accepts a file that does not exist yet |
| C5 | Extensions loaded from the command line | `-e`, `--no-extensions` | a worker loads what its starter loaded (`passthroughArgs`, `lib/dispatch.ts`) |
| C6 | Flags of an extension | `pi.registerFlag` | `xpi --bg "<task>"`, `--bg-name` |
| C7 | No blocking question at start in an unattended terminal | `--approve` / `--no-approve` for project trust | a worker must never wait where nobody sees it (`sessionTrust`, `background.ts`) |

### Extension API used by the adapter

Events (`pi.on`): `session_start`, `session_shutdown` (the write lock, the worker's connection), `agent_start`,
`agent_settled` (a turn's end: done, waiting or failed), `message_end` (the last answer, errors),
`tool_execution_start` and `tool_execution_end` (the current tool; `/bg` waits for one to end), `ui_prompt_start` and
`ui_prompt_end` (a dialog is open), `session_info_changed` (a rename), `model_select` and `thinking_level_select`,
`session_tree`, `session_before_compact`, `session_compact` and `session_compact_failed`.

Calls:

| Call | For |
|---|---|
| `pi.sendUserMessage(text, { deliverAs })` | a reply: steer into the running turn, a follow-up after it, or a new turn when idle (M28) |
| `pi.registerCommand`, `pi.registerFlag`, `pi.getFlag` | `/agents`, `/bg`, `/background`, `/bg-fork`; `--bg`, `--bg-name` |
| `pi.getCommands`, `pi.events.emit` | the hub's command menu; `agents:job_needs_input` and `agents:job_completed` on the event bus (NT-2) |
| `pi.setSessionName`, `pi.setThinkingLevel`, the model registry, `pi.getThinkingLevel` | `/name`, `/model`, `/thinking` sent as replies; the model and level a hand-off keeps |
| `pi.appendEntry` | the recap line on attach (not in the model's context) |
| `ctx.sessionManager.getSessionFile()`, `getSessionName()`, `getBranch()`, `getEntries()` | where the session is, its name, its first message, its spend (M24) |
| `ctx.isIdle()`, `ctx.waitForIdle()`, `ctx.abort()`, `ctx.shutdown()`, `ctx.compact()` | delivery, the hand-off, `--bg`'s exit, `/compact` |
| `ctx.switchSession(file, { withSession })` | the hand-off: leave the file, then let the daemon start its one writer |
| `ctx.ui.custom()` with a TUI that can stop and start | the hub over the conversation, and giving the terminal away while attached |
| `ctx.ui.onTerminalInput(fn)` | the left arrow on an empty prompt; the detach keys of an attached session |
| `ctx.getContextUsage()`, `ctx.modelRegistry` | the context column (M8), the model list, subscription use |
| `ctx.isProjectTrusted()` | the trust a session started from here gets |

If the host agent has no `switchSession`, the hand-off can only happen after the foreground process exits (it holds the
write lock). If its TUI cannot be embedded, run the hub as its own program, as `xpi roost hub` does: the protocol is
the same.

## What to copy and what to rewrite

Copy `packages/xpi-roost` whole; it has no xpi in it. What carries the host agent's names or formats:

| Where | What |
|---|---|
| `lib/paths.ts` `roostHome()`, `runtimeDir()` | `<agent dir>/xpi-roost/`; `$XDG_RUNTIME_DIR/xpi-roost-<key>` or `/tmp/xpi-roost-<uid>/<key>`, `<key>` a hash of the agent directory. Keep socket paths short: a unix socket path has a limit of about 104 bytes |
| `lib/paths.ts` `SESSION_AGENT_DIR_ENV` | the variable a worker reads its agent directory from (`XPI_CODING_AGENT_DIR`) |
| `lib/identity.ts` `JOB_ENV` | `ROOST_JOB_ID`, `ROOST_JOB_TOKEN`, `ROOST_SOCKET`, `ROOST_JOB_DIR`; `JOB_ENV_NAMES` (with `ROOST_RESTORE`) is never inherited by another job or by the daemon |
| `lib/dispatch.ts` `VALUE_FLAGS`, `BOOL_FLAGS`, `PATH_FLAGS` | the flags a worker repeats: `-e`, `--extension`, `--model`, `--provider`, `--thinking`, `--session-dir`, `-ne`, `--no-extensions`, `--offline`; relative paths made absolute |
| `lib/dispatch.ts` `buildLaunch()` | a worker's argv: `[execPath, cli, --session <file>, ...passthrough, --model, --thinking, --approve or --no-approve, --, task]` (a shell command runs as `$SHELL -lc <command>`) |
| `lib/store.ts` `taskArg()`, `respawnCommand()`, `SESSION_RESTORED_FLAGS` | a task starting with `@` gets a space (xpi reads `@x` as a file); a respawn drops the first prompt of a written session and `--model`, `--provider`, `--thinking`, then passes the worker's last reported model and level |
| `lib/heuristics.ts` `QUESTION_PHRASES` | the phrases that make a last answer a question |
| `lib/config.ts` | the `"roost"` settings keys, their defaults and the user-only keys |

Rewrite the adapter (`builtin:roost`) for the host agent. Give the hub what `AgentViewOptions` asks: `connect`,
`launch` and `launchShell`, `isDetachKey` and `detachKeyName`, models, presets, resume, `builtins` (the host agent's
slash commands, each with how a peek runs it: `hub`, `screen`, `picker`, `confirm`, `reply`), `selfId` in a session the
daemon runs.

## Building it, step by step

pi-roost was built in milestones; this is the order phase 1 keeps, with the milestone ids that the code's comments
use.

### 1. Daemon, host and command line (M1)

1. **Directories.** The runtime directory is `0700`; each level that exists (two under `/tmp`) must be a directory of
   this user's, not a link (`checkLevels`, `lib/paths.ts`). Sockets are `0600`. This is the security boundary: one
   user trusts their own processes.
2. **Atomic writes** (`lib/atomic.ts`): a temporary file, `fsync`, `rename`, `fsync` of the directory. All JSON state
   goes through it.
3. **Process identity** (`lib/proc.ts`): pids are reused, so a process is its pid and its start time (`ps -o lstart=`).
4. **Locks** (`lib/locks.ts`): created with `O_EXCL`, holding `{pid, token, at}`; stale only when the holder is gone,
   and a fresh empty file (two seconds) is not stale. `daemon.lock` (runtime directory) and `state.lock` (state
   directory) keep one daemon per agent directory; `<session file>.lock` is the session write lock (DM-8).
5. **Layout** (`lib/store.ts`, `lib/paths.ts`). One writer per file:

   ```text
   <agent dir>/xpi-roost/
     daemon.log         JSON lines
     roster.json        live hosts by job, {hostPid, hostToken}: a restarted daemon takes them over
     events.jsonl       the event feed (`events` op, the hub's /log, `xpi roost log`)
     scratch/           hand-off sessions of /bg, never written
     state.lock
     jobs/<id>/
       job.json         fixed at dispatch: id, name, cwd, sessionFile, command, env, model, thinking, origin, kind
       state.json       written by the daemon only
       worker.json      the host: its worker's pid
       exit.json        the host: {code, signal, at}
       attached.json    the host: who is attached
       screen.txt       the host: the screen as text
       commands.json    the worker: its slash commands, for the peek (M61)
       host.log
   <runtime dir>/daemon.sock  daemon.lock  host-<id>.sock
   ```

6. **The daemon protocol** (`lib/protocol.ts`, `lib/protocol-schema.ts`, `protocol.md`): JSON lines over a unix
   socket. A request is `{id, op, args}`, an answer `{id, ok, result}` or `{id, ok: false, error, code}`, and pushed
   events are `{event}`. Every op has a schema that the daemon checks at its entry; `lib/callers.ts` says who may call
   it (a Person, a Session, an unregistered agent). Limits: a request line of 4 MiB, 1024 connections, 256 requests in
   flight, 16 MiB of unread events.
7. **The host** (`host/main.ts`, argument: the job id). It starts `job.json`'s command with node-pty in the job's working
   directory (`cwd`), with the job's environment, `TERM=xterm-256color` and the job's identity (a shell job gets none). The
   output also feeds an `@xterm/headless` terminal (scrollback 1000) whose text goes to `screen.txt`. Its socket speaks
   binary frames (`lib/framing.ts`): `[type u8][length u32 BE][payload]`, at most 16 MiB, types `HELLO`, `DATA`,
   `RESIZE`, `DETACHED`, `CONTROL`, `REPLY`. The first frame is `HELLO {role: "attach" | "control", cols, rows}`. One
   attach at a time; a new one takes over (`DETACHED {reason: "takeover"}`). Control ops: `snapshot`, `status`,
   `detach`, `terminate` (SIGTERM, SIGKILL after 5 s), `terminate-idle`, `command`. node-pty's prebuilt
   `spawn-helper` can lose its execute bit; the host sets it again (`fixSpawnHelper`), node-pty's scripts do not.
8. **The daemon** (`daemon/main.ts`). It takes its locks, loads the jobs, takes over the hosts that `roster.json` names
   and that are still the same processes, ends the others, and listens. A client that finds no daemon starts one
   (`DaemonClient.connectOrStart`: `spawn(process.execPath, [daemonEntry], { detached: true })`, then pings for up to
   three seconds), without the job identity in its environment. Every second it checks the hosts. `shutdown` without
   `keepWorkers` (and `rm`) terminates hosts and waits six seconds; a host still there then is killed with SIGKILL, and
   its session with it, but only while the host's pid is still that host (its start token, or this daemon's child
   before the token was read) and the session's is that host's child; the daemon log says so. A session whose host
   is already gone (an orphan) is not killed by the daemon. `dispatch` refuses a
   relative or missing directory, an empty command, a relative session file, and a file that is locked or already run
   by a job (`locked`); a taken name gets ` (2)`. Each job gets a random token, given to its worker by the host.
9. **The command line** (`src/cli.ts`): `ls`/`list` (`--all`, `--cwd`, `--json`), `logs`, `log` (`-n`, `--follow`),
   `attach`, `reply`, `stop`, `rm`, `respawn` (`--all`), `daemon status|logs|stop` (`--keep-workers`), `hub`. A daemon
   of another version gets a warning with the way out: `xpi roost daemon stop --keep-workers`, then
   `xpi roost respawn --all`.
10. **The attach loop** (`lib/attach.ts`): raw mode, bytes passed through. The caller's matcher says which whole key
    detaches (decision 11: xpi passes its `app.suspend` binding); a key split over reads is held until whole; a
    bracketed paste is text. On the way out it resets the terminal (`TERMINAL_RESET`: keyboard protocols, bracketed
    paste, mouse, cursor).

Check: `xpi --bg "write hello world"` returns at once; `xpi roost ls` shows it after the terminal closed;
`xpi roost attach <id>` shows its TUI and the detach key leaves it running; after `kill` of the daemon, the next
command starts one that takes the hosts over.

### 2. The worker reports (M2)

A process is a worker when its environment has `ROOST_JOB_ID`, `ROOST_JOB_TOKEN` and `ROOST_SOCKET` (`jobIdentity`,
`lib/agent-client.ts`; `isRoostSession`, `xpi-roost/session`). The worker keeps the identity and takes the token out
of the environment (`worker.ts`), so the tools the session runs do not inherit it; a process started inside the session still has
`ROOST_JOB_ID` (the hub uses it as `selfId`).

1. **State** (`lib/worker-state.ts`, `WorkerTracker`, pure): a turn starts → working; a tool starts or ends (nested
   tools ignored); a turn ends → failed (an error, not aborted), waiting on a question (the last answer asks, with its
   numbered choices), or done; a dialog → waiting on a dialog (a custom one only after two seconds); five seconds
   after a start with no turn and no message → waiting for a first prompt. `ROOST_RESTORE=1` (a respawn) restores the
   state from the session's last answer.
2. **Reporter** (`lib/agent-client.ts`): a whole snapshot each time, one request in flight, a state change at once,
   row text at most every 15 seconds, reconnect with backoff (half a second, doubling to five), a last flush of half a
   second at shutdown.
3. **The daemon's `report`**: checks the token, binds the connection as the job's worker, clips every field.
4. **How a session ends** (`finalize`): a shell job ends done on exit status 0, else failed, and its row goes after
   five minutes. A reaped session keeps its state, marked reaped. A stop → stopped. A host found dead at the daemon's
   start: a working session is failed when it reported within 48 hours, else stopped; any other keeps its state (a
   blocked one not waiting on a question becomes done). A host that vanished → failed. A crashed worker
   that was working restarts with "Continue where you left off." after 1, 5 and 15 seconds, three times in a row at
   most; a worker that has run for over a minute and reports a state other than working resets the count (DM-5). Otherwise the worker's last word stands (failed, a
   question), else done.

### 3. Replies (M3, M28)

The daemon queues each reply in `state.json` (`pendingReplies`, numbered, at most 50) until the worker acks it, so a
restart loses nothing. A connected worker gets `deliver`; otherwise the reply is saved for the session's next start,
and an ended session is respawned for it. The worker's `ReplyQueue` (`worker.ts`) delivers in order: steer or follow-up
while a turn runs (M28), a new turn when idle; it waits while a dialog is open or compaction runs. `/name`, `/model`,
`/thinking` and `/compact` act at once. Request ids (M36, M51): `requestOnce` (`lib/client.ts`) resends a reply or a
dispatch with the same id after a lost answer, and the daemon takes it once; a caller that gets `lost` must not undo
what the request may have done (the hand-off checks the list before going back, see step 5).

### 4. Attach and detach (M4, M21, M22, AT-5)

- On attach the host replays its screen (M21, `serialize` without scrollback) instead of making the TUI redraw; several
  terminals can take turns (M22). `attached.json` records it, and when the worker reported `attachSignal: true` the
  host sends it SIGUSR2. The worker sends `attachSignal: true` only once its SIGUSR2 handler is installed (by the
  recap, `recap.ts`): without one, SIGUSR2 ends the process.
- The detach keys of an attached session (`detach-keys.ts`, decision 11): `app.suspend` once (also in a dialog),
  `app.clear` twice within a second, `app.exit` twice on an empty editor, the left arrow on an empty editor (a fixed key,
  AGENTS.md's exemption), a submitted `/quit` or `/exit`. Key releases are skipped. The worker asks its host to
  `detach`.
- `ensureLive` (`lib/resume.ts`): attaching to an ended session respawns it first (a failed one with "Continue where
  you left off.") and waits for its host socket (15 s).
- The recap: one dim line in the transcript, not in the model's context, about what happened while nobody watched.
- Earlier history (M53, `earlier-history.ts`): in fullscreen xpi, scrolling to the top loads the messages from before
  the latest compaction, a few at a time, drawn with xpi's own message components.

### 5. The hand-off (M5)

`foreground.ts`, with the client and the launch in `handoff.ts` (loaded when used):

1. `/bg`, `/background`, or the left arrow on an empty prompt editor (`leftArrowOpensAgents`).
2. While a tool runs, wait up to ten seconds for it (the left arrow again skips the wait), interrupt the turn, and make
   the first prompt "Continue where you left off." (plus the user's prompt).
3. `ctx.switchSession(scratch)`: the process leaves the file (its `session_shutdown` releases the write lock) for a
   session in `scratch/` that is never written. In `withSession`, dispatch the file (`origin: "adopt"`) with
   `requestOnce`; open the hub on the new row; then switch to a fresh session beside the moved one.
4. Back to the original only when nothing runs on it: a refusal, or a lost answer and a list without a running job on
   the file. With no answer and no list, stay out of the file and say so.
5. `/bg-fork`: copy the session file and dispatch the copy (`origin: "fork"`); this session carries on.
6. A hand-off passes the model and thinking level the session uses now, not the flags it was started with, and the
   trust decision by `xpi --bg`'s rule (`sessionTrust`).

The hub opened after the switch belongs to the new runtime: the old runtime's API is stale. `view-state.ts` keeps the
API of the runtime that loaded the extension last, and the hub reads it at each call.

### 6. The hub (M6, M8, M23 to M25, M27, M28, M48, M61, M79)

- Data, all in the library: `lib/view-model.ts` (groups: pinned, needs input, working, completed; or by directory;
  icons, ages, order), `lib/filter.ts` (`s:` `n:` `o:`), `lib/dispatch-input.ts` (`task`, `@dir task`, `! command`,
  `/model`, `/thinking`, `/resume`), `lib/usage.ts`, `lib/job-events.ts` (notifications: OSC 9, OSC 777, BEL, the
  terminal title).
- Drawing: `src/hub/agent-view.ts` with one view (the list or a row's peek) and one layer at a time (help, picker,
  rename, an overlay; M79), `overlay-host.ts` and `overlays/` (log, usage), `task-editor.ts` (xpi's editor for the
  task and the reply, M17). All daemon calls go through `RoostPort` (`roost-port.ts`).
- Until the daemon's first list arrives the hub says it is connecting and shows no counts or groups (which would read
  as "no sessions"); after a dropped connection it says it is reconnecting until the next list.
- Attaching from the hub: stop the TUI, run the attach loop, start the TUI and redraw.
- A model change in a peek counts when the worker reports it: the hub says "now uses …" or, after eight seconds,
  "model switch failed (credentials? envAllowList): still …".
- The peek's commands: the hub's own (`/stop`, `/respawn`, `/rm`, `/pin`, `/rename`, `/attach`, `/model`, `/thinking`,
  `/name`, `/compact`, `/continue`, `/log`, `/transcript`), the session's (`commands.json`), and the host agent's built
  ins as `builtins` classes them (`commands.ts` in the adapter).

### 7. Idle sessions and old records (M7, M15)

Every 30 seconds the daemon stops sessions that are idle, not pinned, not in a dialog, with no reply queued, not
attached and idle for `reapIdleMinutes` (default 60); they are marked reaped and start again on a reply or an attach.
It checks again after reading the host's state, and the host itself refuses to stop an attached session
(`terminate-idle`), since an attach may come in between. `cleanupDays` (default 30, `0` keeps them) removes the records
of sessions that ended that long ago, except pinned ones, ones still waiting and ones with replies queued.

### 8. The environment of a session (M20)

`lib/workspace-env.ts`, `lib/dispatch.ts`: a session starts with the starter's environment (`inheritEnv`), less
`envDenyList` (`"PREFIX*"` names a prefix), plus `envAllowList`; or with only the login basics, `LC_*` and
`envAllowList`. On top comes what the directory's shell hooks set (`workspaceEnv`: `"shell"`, `"direnv"` or `"off"`).
These four keys are the user's only. The roost's location variables (`ROOST_AGENT_DIR`, `ROOST_HOME`,
`ROOST_RUNTIME_DIR`, `ROOST_HOST_ENTRY`) and `XPI_CODING_AGENT_DIR` always reach the session, so roost inside it
reaches the same daemon (decision 7).

## Settings

The `"roost"` section of `settings.json` (decision 9), read by the adapter and the hub through xpi's settings and by
the daemon from `<agent dir>/settings.json` itself. A project's section is merged over the user's, except the
user-only keys. `roost.json` is not read.

| Key | Default | Who reads it |
|---|---|---|
| `leftArrowOpensAgents` | `true` | the foreground role |
| `reapIdleMinutes` | `60` | the daemon (user settings) |
| `cleanupDays` | `30` (0 to 3650; `0` keeps) | the daemon (user settings) |
| `dispatchModel`, `dispatchThinking` | the session default | `--bg`, the hub |
| `inheritEnv`, `envAllowList`, `envDenyList`, `workspaceEnv` | `true`, `[]`, `[]`, `"shell"` | `--bg`, the hand-off, the hub (user only) |
| `groupBy` | `"state"` | the hub (Ctrl+S writes it to the user's file) |
| `fullscreen`, `rowDetails` | `true`, `true` | the hub |
| `notify` | `"auto"` (`"osc9"`, `"osc777"`, `"bell"`, `"off"`) | the hub |
| `presets` | none; `{name: {model, thinking, dir}}`, merged by name, a project's wins; `/preset save` writes the user's | the hub |

## Constants

| Constant | Value | Where |
|---|---|---|
| Frame size | 16 MiB | `lib/framing.ts` `MAX_FRAME` |
| Host scrollback | 1000 lines | `host/main.ts` |
| Terminate | SIGTERM, then SIGKILL after 5 s | `host/main.ts` |
| A stop waits for a host | 6 s; then `shutdown` and `rm` SIGKILL it (a restart answers busy) | `daemon/main.ts` `WAIT_MS` |
| Starting a daemon | 3 s of pings | `lib/client.ts` `connectOrStart` |
| Host check | every 1 s | `daemon/main.ts` `checkHosts` |
| Reaping check | every 30 s | `REAP_CHECK_MS` |
| Crash restarts | after 1, 5, 15 s; reset after 60 s up | `RESUME_DELAYS_MS`, `CRASH_RESET_MS` |
| Recent work at startup | 48 h | `RECENT_MS` |
| A shell job's row | 5 min after it ends | `SHELL_KEEP_MS` |
| Queued replies | 50 | `MAX_PENDING` |
| Ended rows in `xpi roost ls` | 48 h (`--all` for older) | `src/cli.ts` |
| First prompt wait | 5 s | `FIRST_PROMPT_MS` |
| A custom dialog counts | after 2 s | `CUSTOM_DIALOG_MS` |
| Report request timeout, last flush | 4 s, 0.5 s | `lib/agent-client.ts` |
| Respawn before attach | 15 s for the host socket | `lib/resume.ts` |
| `/bg` waits for a tool | 10 s | `foreground.ts` `TOOL_WAIT_MS` |
| Double press to detach | 1 s | `detach-keys.ts` `DOUBLE_PRESS_MS` |

The daemon also reads tuning variables, for tests: `ROOST_REAP_MINUTES`, `ROOST_REAP_CHECK_MS`, `ROOST_CLEANUP_DAYS`,
`ROOST_CLEANUP_CHECK_MS`, `ROOST_RESUME_DELAYS_MS`, `ROOST_SHELL_KEEP_MS`, `ROOST_STOP_WAIT_MS`; and `ROOST_PARENT_PID` marks a test's
processes (M78).

## Build and packaging

`xpi-roost` builds with `tsc -p tsconfig.build.json` before the coding agent. The coding agent's bundle
(`scripts/build-coding-agent-bundle.mjs`) inlines it and writes two more entry files, `roost-daemon.js` and
`roost-host.js`, next to its chunks; `getRoostEntries()` (`src/config.ts`) finds them, or `xpi-roost/daemon` and
`xpi-roost/host` when unbundled. `@xterm/*` is inlined into the host; node-pty stays external, an
`optionalDependencies` entry that only the host imports (the build fails otherwise), allowed to run its install script
(it compiles on Linux; decision 8). A standalone binary has no Node runtime for the daemon and says roost needs the npm
installation.

## Tests

`packages/xpi-roost/test` runs on vitest with real daemons, hosts and PTYs, shell commands and fake workers, no model
(`npm run test:roost`, CI's `test (roost)` job on Linux after `npm rebuild node-pty`). The adapter's tests are
`packages/xpi-coding-agent/test/roost-*.test.ts`, with a fake xpi and a fake daemon socket; `roost-session.test.ts`
starts a real daemon for `--bg`, and `roost-hub-pty.test.ts` drives the built `xpi roost hub` in a PTY with a fake
model. Test processes carry `ROOST_PARENT_PID` and a home under `<tmp>/xroost-*`; the suite's global setup sweeps what a
killed run left (M78), and no test starts another test runner. Before a merge that changes what a session does, a
real-model check (spec item 14): start a background session on a small model, reply, attach and detach, in a temporary
agent directory.

## Known limits

- macOS and Linux only (decision 10): Unix PTYs and sockets.
- A session interrupted by a machine restart, or by its host's death, ends; it does not resume on its own (M38 is
  phase 2). A reply or `respawn` starts it again.
- After an upgrade the running daemon and hosts keep their old code until `xpi roost daemon stop --keep-workers` and
  `xpi roost respawn --all`.
- A crashed session is restarted three times in a row at most; then a reply starts it.
- The hub's keys are fixed (AGENTS.md's exemption); only the detach key follows the user's keybindings.
- pi-roost's state in `~/.pi/agent/roost/` is never read (decision 9): its sessions do not appear.

## Left out of phase 1

Not copied (rather than copied and switched off): the code is not in xin-pi (decision 6). "Grill N" is the item in `decisions.md`.

| What | pi-roost | Decision |
|---|---|---|
| Schedules (`/schedule`, `xpi roost schedule`) | M39, M40 | decision 6 (phase 2); Grill 5 |
| Resume after an interruption (`autoResume`) | M38 | decision 6 (phase 2); Grill 5 |
| Messages between sessions, peers, `handback`, `send`, `spawn` | M9, M50 | decision 6 (with agent teams); Grill 5 |
| Watches | M43 | decision 6 (with agent teams); Grill 5 |
| The `roost_*` agent tools and the `agentMax*` limits | M9 | decision 6 (with agent teams) |
| A foreground session in the hub (`peer_register`) | M9 | decision 5; Grill 15 |
| Subagents in the hub, the subagent panel and transcript view, `list --subagents` | M12, M13, M19 | decision 3; Grill 4 |
| The task board and workspaces (`/tasks`, `/workspaces`, `xpi roost review`, verify, merge, PRs from tasks) | M47, M52, M54 to M60, M64 to M66 | decision 6 (only if the owner asks); Grill 5 |
| The concierge and standing orders | M44 to M46 | decision 6 (only if the owner asks); Grill 5 |
| Worktree isolation (`--worktree`, `worktreeIsolation`) | M10 | decision 6 (only if the owner asks); Grill 5, 16 |
| Pull request status | M16 | decision 6 (only if the owner asks) |
| Fan-out and `/compare` | M26 | decision 6 (only if the owner asks); Grill 5 |
| Sessions from agent definitions (`--agent`, `dispatchAgent`, `<agent> <prompt>`, `a:`) | M18 | decision 6; Grill 17 |
| Terminal-agent profiles, the protocol client class, the Python SDK | M30, M31 | decision 6; Grill 10 |
| pi-mobile | M11 | decision 6; Grill 5 |
| Telemetry | M34 | decision 6; Grill 5 |
| The summary model (row summaries, automatic names, the recap's rewrite) | M7 | decision 6 |
| `defaultToAgentsView` | | decision 6 |
| `/bg`'s quit offer and the footer hint with its daemon poll | BG-9, BG-11 | left out with the foreground role (PR 4, T19 notes in `issues/01-roost-core.md`) |
| `--agents`, `--agents-cwd` (xpi's `--agents` defines subagents) | | decision 6 (never, as they are); Grill 16 |
| A preset's `worktree`, `agent`, `fanout` fields | M27 | decision 6 |
| `lib/pi-resolve.ts`, `lib/pi-commands.ts`, `extensions/index.ts`, `spikes/`, `evals/`, `stress/` | | decision 6 (not ported) |
| `roost.json` and the `PI_ROOST_*`, `PI_JOB_ID`, `PI_DAEMON_SOCK` names | | decision 9; Grill 8 |
| Roost in the standalone binaries, Windows | | decisions 8, 10; Grill 7, 9 |
