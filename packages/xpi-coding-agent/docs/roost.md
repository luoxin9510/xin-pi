# Background Sessions

A background session is an ordinary xpi session that runs without a terminal. A daemon keeps it running in a
pseudo-terminal of its own, so it goes on after the terminal that started it closes. You list your sessions, read
their screens, reply to them, and attach to one to use its whole TUI, then detach and leave it running.

```bash
xpi --bg "run the tests and fix what fails"
xpi roost hub
xpi roost ls
xpi roost reply <id> "use pnpm, not npm"
xpi roost attach <id>
```

In a session, `/agents` (or the left arrow on an empty prompt) opens [the hub](#the-hub), where you start sessions,
peek at them, reply and attach; `/bg` [hands the conversation you are in](#hand-a-conversation-over) to the daemon.

The built-in `roost` extension provides `--bg`, `/agents`, `/bg`, `/bg-fork` and the session side; `xpi roost` is the
command line. They need macOS or Linux and the npm installation of xpi (see [Requirements](#requirements)).
`-builtin:roost` in `extensions` turns the extension off: then there is no `--bg`, no `/agents` or `/bg`, and a
session the daemon runs neither reports nor takes replies.

## Start a session

```bash
xpi --bg "<task>"
xpi --bg "<task>" --bg-name "nightly tests"
```

`--bg` hands the task to the daemon as a new session in the current directory and exits. It prints the session's id
and how to reach it:

```
backgrounded · 3f9c2a1e · run the tests and fix what fails
  xpi roost attach 3f9c2a1e   open it (ctrl+z detaches)
  xpi roost logs 3f9c2a1e     its screen
  xpi roost stop 3f9c2a1e     stop it
  xpi roost ls --json         list all
```

The detach key shown is the one bound to `app.suspend` in your keybindings (`ctrl+z` by default; the action is named
when nothing is bound). The name defaults to the first six words of the task; `--bg-name` sets it. The session runs the same xpi with the
flags that choose its extensions and model (`-e`, `--no-extensions`, `--model`, `--provider`, `--thinking`,
`--session-dir`, `--offline`). `xpi --session <file> --bg "<task>"` continues that session in the background.

The session also gets this xpi's answer about the project folder's trust, as `--approve` or `--no-approve`, so it never
waits at the trust question where nobody sees it: answer the question (or pass `--approve`) when you run `xpi --bg`.
The answer is part of the session's command: every later start of that session (`respawn`, a reply to a finished
session, a restart after a crash) uses it without asking again, also an answer given for one run only. In a folder that
has nothing to trust yet, the session gets `--no-approve` unless you passed `--approve` or a decision is stored, so
project extensions that appear later do not load in it unasked.

Every session the hub starts, resumes or is handed (`/bg`, `/bg-fork`) gets a decision by the same rule. In the folder
of the xpi the hub runs in, that is this xpi's answer and command line, as for `--bg`. In any other folder (a session
started with `@dir`, a preset's directory, a resumed session from elsewhere) and in `xpi roost hub`, which has no
session of its own, only a stored decision counts: without one the session gets `--no-approve`, and its project
extensions, skills and context files do not load. To run sessions in a folder with its project resources, store a
decision there first: run xpi in it once and answer the question, or use `/trust`.

The `roost` settings choose a new session's model, thinking level and environment; see [Settings](#settings).

The whole task is the value of `--bg`: quote it as one argument. For a task that starts with `-` or `@`, write
`--bg="<task>"`. Nothing else may be sent with it, because this xpi
would send it to the model itself before exiting, so `--bg` refuses other messages, `@file` arguments, `-p`, `--mode`
and redirected input or output (it needs a terminal). It also refuses `--no-session`: a background session needs a
session file. It does not start the daemon's session when roost cannot run here; it says why instead (see
[Requirements](#requirements)). Each of these stops xpi before anything starts.

## Work with sessions

| Command | What it does |
|---|---|
| `xpi roost ls [--all] [--cwd <dir>] [--json]` | List sessions: pinned first, then waiting, working and ended ones (`--all` includes those ended over 48 hours ago; `--cwd` one directory's; `--json` for programs) |
| `xpi roost logs <id\|name>` | Print the session's screen |
| `xpi roost log [-n <count>] [--follow] [<id\|name>]` | What happened lately: started, finished, waiting, replied, stopped |
| `xpi roost reply <id\|name> <text>` | Send a reply. A working session gets it as a follow-up once its turn ends; an idle one starts a turn |
| `xpi roost attach <id\|name>` | Open the session's TUI in this terminal |
| `xpi roost stop <id\|name>` / `rm <id\|name>` | Stop it; `rm` also deletes its record |
| `xpi roost respawn <id\|name>` | Start an ended session again, or restart a running xpi session (a running shell session is left alone); `--all` restarts every running xpi session, and reaped ones load the new code when they start again |

A session is named by its id, a unique prefix of it, or its name. The full list, with the daemon's own commands, is in
[CLI](cli.md#background-session-commands).

A reply that is one of `/name <name>`, `/model <provider/id>`, `/thinking <level>` or `/compact` changes the session
at once instead of becoming a prompt. A reply to an ended session starts it again first.

## Attach and detach

`xpi roost attach` shows the session's own TUI, as it is now: its transcript, editor, dialogs and subagent panel. You
type into it as into any xpi session. Several terminals can attach to one session; the latest takes over.

While attached, the keys that would end or freeze the session detach instead, and the session keeps running:

| Key (default) | Keybinding | Detaches |
|---|---|---|
| `ctrl+z` | `app.suspend` | at once, also while a dialog is open |
| `ctrl+c` twice | `app.clear` | on the second press within a second; the first still clears the editor |
| `ctrl+d` twice | `app.exit` | on an empty editor; the first press says to press again |
| `left` | (fixed) | on an empty editor |
| `/quit` or `/exit`, submitted | | the editor is cleared |

They follow your [keybindings](keybindings.md): a rebound `app.suspend`, `app.clear` or `app.exit` detaches with the
new key. While a dialog is open only `app.suspend` detaches; the dialog keeps its other keys. xpi's own pickers
(`/tree`, `/resume`, the settings list) are not dialogs in this sense: while one is open, the left arrow (with the
editor empty) and a double `app.clear` detach too. To end a session, use `xpi roost stop`.

Attaching to an ended session starts it again first; one that failed is told to continue where it left off. When
something happened while nobody watched, a dim line in the transcript says what: turns finished, tools used, the last
question asked. It is not part of the model's context.

In fullscreen xpi, scrolling a session's transcript to its top loads the conversation from before its latest
compaction, a few messages at a time.

## When a session ends

A session ends when its xpi exits or is stopped; its row stays, as done, failed or stopped, until you delete it (or
`cleanupDays` after it ended). A session whose xpi crashes while it works is restarted on its own, with "Continue where
you left off.", up to three times in a row. A shell command's row goes away five minutes after the command ends. When
the machine restarts, or a session's host process dies, the session ends and does not resume on its own: reply to it,
attach, or `xpi roost respawn` it to start it again from its session file.

## Schedules

A schedule starts a new background session on a time rule: "every weekday at 9, review yesterday's commits", "every 2
hours, check the deploy". Each run is a session of its own in the list, like one started with `xpi --bg`.

```bash
xpi roost schedule add standup weekdays 09:00 "summarise yesterday's commits"
xpi roost schedule add deploy every 2h "check the deploy" --cwd ~/work/site --thinking low
xpi roost schedule list
```

In the hub, `/schedule <name> <when> <task>` adds one and `/schedule` alone lists them; see [The hub](#the-hub).

| Command | What it does |
|---|---|
| `xpi roost schedule add <name> <when> <task> [--cwd <dir>] [--model <m>] [--thinking <t>]` | Add a schedule for the current directory (or `--cwd`) and print its next run |
| `xpi roost schedule list [--json]` | Every schedule: its rule, next run, last run (or why it was skipped), directory and task |
| `xpi roost schedule run <name>` | Run it now, also when it is paused or `manual`; its next run does not move |
| `xpi roost schedule pause <name>` / `resume <name>` | Stop and start its slots; a resumed `every` counts from now |
| `xpi roost schedule edit <name> [--when <when>] [--task <task>] [--model <m>] [--thinking <t>]` | Change it; what you leave out keeps its value, and `--model default` or `--thinking default` goes back to the settings' |
| `xpi roost schedule rm <name>` | Remove it; its runs stay in the list until you remove them |

Rules are in local time:

| Rule | Runs |
|---|---|
| `every <n>m`, `every <n>h`, `every <n>d` | every n minutes, hours or days, counted from when it was added, resumed or its rule edited |
| `daily HH:MM` | every day at that time |
| `weekdays HH:MM` | Monday to Friday |
| `weekly <mon..sun> HH:MM` | one day a week |
| `cron "<minute hour day month weekday>"` | a cron rule: lists, ranges and steps; Sunday is 0 or 7; when both day fields are given, either matches |
| `manual` | only when you run it |

Two runs are never less than five minutes apart: `every` under `5m` is refused, and so is a cron rule with two times
of day under five minutes apart (`*/2 * * * *`, or `1,58 0,23 * * *`, whose 23:58 and 00:01 are three minutes apart). Names are a letter or
digit, then up to 39 of letters, digits, `_`, `.` and `-`. A task is at most 64 KiB, and there are at most 50
schedules. A cron rule that never matches a date (`0 9 31 2 *`) is refused.

Clock changes follow local time: on the day clocks go back, a rule for a time in the repeated hour (`daily 01:30`)
may run twice; on the day they go forward, one for a time in the skipped hour (`daily 02:30`) does not run that day.
`every 1d` is 24 hours, so it moves by an hour against the clock across a change; `daily HH:MM` keeps the time.

**What a run is.** A new session named after the schedule (`standup`, `standup (2)`), with a new session file in the
session directory xpi would use for that folder; `xpi roost ls` shows it as `standup (2) ← standup`. It starts with
what the schedule was made with: the directory, the model and thinking level (the flags, else the `roost` settings'
`dispatchModel` and `dispatchThinking`), this xpi's executable, and your environment as `add` or the last `edit` saw
it, filtered by the `roost` settings (see [Settings](#settings)). It is stored with the schedule, readable by you only.
So edit a schedule after changing a key or variable it needs: `xpi roost schedule edit <name>` with no flags builds
the launch again in your current terminal. The trust decision is the one stored for the directory (see
[Understand project trust](security.md#understand-project-trust)); without one the run starts with `--no-approve`, so it never waits at the trust question.

**When runs happen.** Only while the agent directory's daemon runs: it looks every 15 seconds. Any `xpi roost`
command (other than `daemon ...` and `schedule list`), the hub and `xpi --bg` start the daemon; `xpi roost daemon stop`
stops the schedules with it. A slot missed while the daemon was off or the machine slept runs once when it is back, if
it fell within the last seven days, marked as a catch-up in `schedule list` and `xpi roost log`; older ones are
dropped.

**Start the daemon at login.** So schedules run without opening xpi after a restart, `xpi roost daemon install`
registers a login service for this agent directory: a launchd agent in `~/Library/LaunchAgents` on macOS, a systemd
user unit in `~/.config/systemd/user` on Linux, named by the agent directory's key (`dev.xpi.roost.<key>`,
`xpi-roost-<key>.service`). It starts the daemon once per login and never again: `xpi roost daemon stop` is not undone
until the next login, and launchd or systemd leaves the sessions alone when the daemon exits. On Linux it also starts the daemon at
once when none is running; on macOS loading it starts one, which exits when a daemon already runs.
`xpi roost daemon uninstall` removes it; the daemon keeps running, so schedules do too. On macOS, unloading the
service stops the daemon it started (its sessions keep running, as with `daemon stop --keep-workers`), so uninstall
waits for it to stop and starts it again as any `xpi roost` command would, outside the service; installing again
likewise restarts that daemon under the new service. `xpi roost daemon status` says whether the service is installed.
`install` and `uninstall` refuse to run as root: run them as yourself, not with `sudo`. Notes:

- The service runs the xpi that installed it (its Node and its daemon file, by path) with the location of the roost
  and nothing else of your environment: the runs of schedules carry the environment they were made with, not the
  service's. After moving xpi, or upgrading it to another path (another Node version manager's directory, say), run
  `xpi roost daemon install` again; `daemon status` says so when the file no longer matches this xpi.
- Its output goes to `<agent dir>/xpi-roost/service.log`; the daemon's own log stays in `daemon.log`.
- On Linux a user unit starts when you log in and stops when your last session ends. To keep the daemon (and the
  schedules) running without a login, enable lingering: `loginctl enable-linger $USER`.
- The service keeps the runtime directory (where the sockets are) that the installing terminal had: `ROOST_RUNTIME_DIR`,
  else `$XDG_RUNTIME_DIR`, else `/tmp`, and `ROOST_HOME` likewise. A terminal that resolves another one (another
  `ROOST_RUNTIME_DIR`, or no `XDG_RUNTIME_DIR` as in some `su` or `ssh` shells) does not find that daemon's sockets and
  cannot start a second one for the same state: `xpi roost daemon status` and the other commands say the daemon runs
  with another runtime directory (`other_runtime_dir`). Use the same variables there, or install again from the
  environment you use.

**Skipped slots.** A slot is skipped while the schedule's previous run is still working, starting or about to restart
after a crash; a previous run that waits for your answer does not hold it back (the new run starts, the old one stays
in the list waiting). A slot is also skipped when the directory is gone, or when the xpi it was made with has moved
(`run xpi roost schedule edit <name> to update it`). `schedule list` shows the last skip and why; `xpi roost log` and the hub's `/log` too. A run notifies as any session
does when it needs input or finishes; a catch-up or a skipped slot does not notify.

**Old runs.** Each schedule keeps its three newest ended runs that are not pinned; older ones are removed as
`xpi roost rm` would. Their session files stay, and `/resume` finds them when the schedule uses the default session
directory. A run that ended on a question counts as ended once its process is gone (it was reaped, or it exited),
unless it is the schedule's latest run, which stays in the list as Needs input. A run you start again by replying, or
one with a reply or a crash restart waiting, counts as running until it ends again. An old run whose worker still
waits idle is removed once idle reaping has stopped it (at once when `reapIdleMinutes` is `0`). A removed schedule's
runs stay until you remove them; a schedule added again under the same name does not take them over.

**The schedules file.** The daemon keeps the schedules in `<agent dir>/xpi-roost/schedules.json`. When it cannot read
the file, it moves it to `schedules.json.bad-<time>`, starts with none and says so in `schedule list` and its log.
Entries it cannot run (edited by hand, or from a newer xpi) are left in the file as they are, and `schedule list`
counts them.

**Inside a background session**, `xpi roost schedule add`, `edit` and `run` refuse (the session's environment has
`ROOST_JOB_ID`); `list`, `pause`, `resume` and `rm` work, and so does `/schedule` in a hub opened there with
`/agents`, where you are the one typing. `/schedule` is the hub's command only: an ordinary xpi session has none, so it
is not confused with a timer inside one session. This keeps a model from adding schedules by accident, not on
purpose: it could clear the variable. The daemon takes the schedule operations from people only, never from a
session's connection.

## The hub

The hub lists the sessions the daemon runs and lets you start, watch, answer and open them. `/agents` opens it in a
session (over the conversation, or in place of the editor with `"fullscreen": false`); `xpi roost hub [dir]` opens it in
a terminal of its own, with new sessions starting in `dir` (default: the current directory). A foreground xpi is not in
the list until it is handed over with `/bg`; subagents are not listed (see `/subagents` in their session).

New sessions and `/resume` use the session directory of the xpi the hub runs in (`--session-dir`, else
`XPI_CODING_AGENT_SESSION_DIR`, else the `sessionDir` setting). The hub reads a project's settings (its default model,
and in `xpi roost hub` its theme and `sessionDir`) only as far as the sessions it starts there would trust the folder.

In a session the daemon runs, `/agents` marks that session's own row "this session" and refuses to attach to it, stop,
delete or restart it, or run xpi's commands in it: leave the hub to use it.

Until the daemon's list arrives the hub says it is connecting to the background service (and reconnecting, after the
daemon went away). A daemon that accepts the connection but does not answer the first requests (subscribe, list) within 10 s
is dropped: the hub shows `background service: ... did not answer` and tries again. Rows are grouped by state (needs input, working, completed; pinned first) or by directory. Each row shows its name, what
it is doing or its last result, its model and context use, what it spent, and its age. A schedule's run shows
`↻ <schedule>` before what it is doing.

| Key | What it does |
|---|---|
| ↑ ↓, PgUp PgDn, Home End | Move through the list |
| type, Enter | Start the typed task as a new session in the hub's directory (`@dir task`: in that directory; `! command`: a shell command as a session) |
| Ctrl+Enter | Start the typed task and attach to it |
| Enter or → | Attach to the selected session (its own TUI); the [detach keys](#attach-and-detach) bring you back. Enter on a group header folds the group |
| Space | Peek: its task, directory, state, model, cost, queued replies and the end of its transcript, with a reply box |
| in a peek: Enter / Alt+Enter | Send the reply: it joins the current work (as in xpi), or waits for it to end |
| in a peek: 1…9 | On an empty reply, fill in the session's numbered choice |
| in a peek: `/…` | Act on that session: `/stop`, `/respawn`, `/rm`, `/pin`, `/rename`, `/attach`, `/model`, `/thinking`, `/name`, `/compact`, `/continue`, `/log`, `/transcript`, the session's own commands, and xpi's (see below) |
| Ctrl+X | Stop; again within 2 s deletes (on a group header: the group) |
| Ctrl+T, Ctrl+R | Pin or unpin (pinned sessions are never stopped for being idle), rename |
| Ctrl+O | Mark the row (on a header: the group); typed text, `/model`, `/thinking`, Ctrl+X and Ctrl+T then act on every marked session |
| Shift+↑ Shift+↓, Alt+↑ Alt+↓ | Move the row within its group, jump to the previous or next group |
| Alt+1…9 | Attach to row N of this directory |
| Ctrl+S | Group by state or by directory (saved to your settings; the hub says when it cannot write them) |
| Ctrl+F, `s:` `n:` `o:` | Filter by name, state or result |
| Ctrl+L, Ctrl+P, Shift+Tab | The model for new sessions (Ctrl+L in a peek: for that session), the next enabled model (Shift+Ctrl+P: the previous one), the next thinking level; Ctrl+P and Shift+Tab only outside a peek |
| Tab | Complete: `/` the commands, `@` paths |
| Ctrl+G, Ctrl+J | Write the task or reply in `$VISUAL` / `$EDITOR`; a new line |
| ? | All keys |
| Esc, Ctrl+C twice | Close the peek, clear the input, unmark, then leave the hub (sessions keep running); Esc, Ctrl+C or `q` closes an overlay |

The hub's own commands, typed in the input:

| Command | What it does |
|---|---|
| `/model [provider/model]`, `/thinking [level]` | The model and thinking level of new sessions (bare: pick; `default` resets) |
| `/preset [name]` | Apply a saved choice of model, thinking level and directory for new sessions; `/preset save <name>`, `/preset rm <name>`, `/preset off` |
| `/resume` | Open a past session in the background (xpi's session list: search, this directory or all) |
| `/usage` | What the sessions spent: today, in all, by model and by session |
| `/log` | What happened lately: starts, questions, results, replies, schedules' runs (catch-ups marked) and skipped slots (a missing directory too), newest first |
| `/schedule <name> <when> <task>` | Add a [schedule](#schedules) in the hub's directory (the text stays in the input when the daemon refuses it): a new session on the rule, with the model and thinking level chosen for new sessions (else the `roost` settings'). The launch is built as `xpi roost schedule add` builds it: the trust decision stored for the directory only, your environment as the hub's process has it, filtered by the `roost` settings, and the hub's session directory |
| `/schedule` | The schedules: rule, next run, last run with its result (done, failed, needs input, ...; while the run is still listed) or skip. Enter runs the selected one now, `p` pauses or resumes it, `e` edits its rule (the launch is built again here, with its stored task, model and thinking), `x` twice removes it, `r` reloads |
| `/exit` | Leave the hub (also `/quit`) |

xpi's own commands typed in a peek run in that session's xpi: those that show something (`/session`, `/export`,
`/hotkeys`, ...) show its screen in the hub; those that open a picker (`/tree`, `/settings`, `/resume`, ...) attach
to it so you can use the picker; `/quit` asks twice. An extension command, `/subtask` or `/review` goes to the session
as a reply and its xpi runs it. A shell command's session takes no replies; attach to type into it.

The hub uses your keybindings for the detach key only; its other keys are fixed (listed in AGENTS.md's exemptions).

## Hand a conversation over

| Command | What it does |
|---|---|
| `/bg [prompt]` (also `/background`) | Hand this conversation to the daemon and open the hub on it; you get a fresh session here |
| `/bg-fork [prompt]` | Copy this conversation into a new background session; this one carries on |
| the left arrow on an empty prompt | `/bg`; with no saved conversation yet, it just opens the hub (while the first turn still runs, `/bg` asks you to wait for the first reply) |

When a turn is running, `/bg` waits up to ten seconds for a running tool to finish (the left arrow again skips the
wait), interrupts the turn, and the session continues in the background with "Continue where you left off." and your
prompt; an idle conversation starts there with your prompt, if you gave one. It leaves the
session file first, so only the daemon's session writes to it. When the daemon refuses, or its answer is lost and its
list shows nothing running on the file, you are back in the conversation. When neither the answer nor the list comes,
`/bg` does not go back (a session may run on the file): it says so, and `/agents` shows whether it does. In the hub
the moved session is shown in bold, with
"Your conversation moved to the background" above the list; Esc goes into it. `/bg` refuses while a dialog is open,
during compaction, and without a session file (`--no-session`).

The session keeps this xpi's current model and thinking level, and gets this xpi's trust decision for the folder by
the rule [above](#start-a-session). `"leftArrowOpensAgents": false` turns the left arrow off. In a session the daemon
runs, the left arrow detaches instead (see [Attach and detach](#attach-and-detach)).

## Settings

The `roost` block of `settings.json` (see [Settings](settings.md#background-sessions)):

| Setting | Default | Applies to |
|---|---|---|
| `dispatchModel` | the session default | the model of a session `--bg` or the hub starts, unless the command line gives `--model` or `--provider`; also of a schedule made without `--model` or edited with `--model default` (stored with it) |
| `dispatchThinking` | the session default | its thinking level, unless the command line gives `--thinking`; likewise for a schedule (`--thinking`, `--thinking default`) |
| `presets` | none | the hub's saved choices for new sessions (`/preset`) |
| `leftArrowOpensAgents` | `true` | the left arrow on an empty prompt hands the conversation over and opens the hub |
| `groupBy` | `"state"` | how the hub groups its rows (Ctrl+S changes it) |
| `fullscreen` | `true` | `/agents` covers the conversation; `false`: in place of the editor |
| `rowDetails` | `true` | each row shows its model and context use |
| `notify` | `"auto"` | how the hub makes the terminal notify when a session needs input or finishes: `"osc9"`, `"osc777"`, `"bell"` or `"off"` |
| `inheritEnv` | `true` | the session starts with this shell's environment; `false`: only the login basics, `LC_*` and `envAllowList` |
| `envAllowList` | `[]` | variables carried even when `inheritEnv` is off or `envDenyList` names them |
| `envDenyList` | `[]` | variables never carried; `"PREFIX*"` names a prefix |
| `workspaceEnv` | `"shell"` | the session directory's own environment on top: what its shell's cd hooks set (direnv, mise, fnm), `"direnv"` only, or `"off"` |
| `reapIdleMinutes` | `60` | a session idle, not attached and not pinned this long is stopped; it starts again on attach or reply (your settings only) |
| `cleanupDays` | `30` | records of sessions that ended this many days ago are removed (`0` keeps them; your settings only) |

The environment keys are read from your own settings only: a project's `.pi/settings.json` cannot choose which of your
environment reaches its sessions. Whatever the lists say, a session gets the variables that say where its roost is,
so `xpi roost` inside it reaches the same daemon.

## Where things are

- **State**: `<agent dir>/xpi-roost/`: one directory per session in `jobs/` (its record, its state, its last screen,
  its command list), the running hosts (`roster.json`), the schedules (`schedules.json`), the event log
  (`events.jsonl`) and the daemon's log (`daemon.log`). The agent directory is `~/.pi/agent` unless `XPI_CODING_AGENT_DIR` says
  otherwise.
- **Sockets**: `$ROOST_RUNTIME_DIR`, else `$XDG_RUNTIME_DIR/xpi-roost-<key>`, else `/tmp/xpi-roost-<uid>/<key>`, one
  per agent directory.
- **One daemon per agent directory**. It starts on demand with the first command that needs it (or at login, see
  [Start the daemon at login](#schedules)) and stops with
  `xpi roost daemon stop`, which stops the sessions too (a session that has not ended after a few seconds is killed;
  `--keep-workers` leaves them running). An xpi with another agent directory has a daemon and sessions of its own.

Each xpi session also holds a lock next to its session file (`<file>.lock`) while it is open, so the daemon never
starts a session on a file another xpi has open.

## Requirements

- **macOS or Linux.** On Windows `--bg`, `/agents`, `/bg` and `xpi roost` say background sessions are not supported
  (use WSL).
- **The npm installation of xpi** (`npm install -g xpi-coding-agent`). A standalone binary has no Node runtime for the
  daemon and says so.
- **node-pty**, an optional dependency installed with xpi. On Linux it compiles during the install and needs python3,
  make and a C++ compiler. Without it `--bg`, `/bg`, `/bg-fork`, `xpi roost respawn` and attaching to a session that
  is not running say how to reinstall it.

## After xpi is rebuilt or upgraded

Three kinds of processes keep running the xpi they started with: the daemon, each session's host, and the xpi inside
each session. `/reload` reads extensions, skills and settings again; it does not load xpi's own code or its built-in
extensions.

xpi tells a rebuilt install from the one a process runs by its **build id**, so a rebuild at the same version is
noticed too. The bundle build writes it to `dist/bundle/build-id`: one line, the first 16 hex digits of a SHA-256
over the bundle's files (their paths and contents), so the same sources give the same id in any checkout and building
again without a change does not ask for a restart. A process reads its own id when it starts and the installed one
again when it compares. When either is unknown (xpi run from the sources, or a daemon from before build ids) nothing
is compared and nothing is reported.

What it says:

- **The command line**: `xpi --bg` and the `xpi roost` commands other than `hub`, `daemon logs` and `daemon stop`
  warn once when the daemon's version or build is not the installed one. `xpi roost ls` adds a line on stderr when
  running sessions run an older build (`2 sessions run an older build: ...`), and `xpi roost daemon status` prints the
  daemon's `build` and marks an older one.
- **The hub**: a line under the title, for as long as the daemon, a running session or (in `xpi roost hub`, which is a
  process of its own) the hub itself runs an older build. The hub inside a session (`/agents`) restarts with its
  session and leaves itself out.
- **`/reload`**: in a session that runs an older build than the installed one it says that xpi's own code changed and
  `/reload` does not load it. In a session the daemon runs it says to restart the session (`xpi roost respawn <id>`
  from outside); in an ordinary session, to quit and start it again with the command it prints (the one that resumes
  this session).

To move everything to the installed code, run `xpi roost daemon stop --keep-workers`, then
`xpi roost respawn --all`. Running only the second leaves the daemon on the old code.

## Not in this version

Background sessions came from pi-roost; this version has its daemon, `xpi roost`, the hub, the session side and
schedules. Not here: sessions resuming on their own after a machine restart (left out: restarting unattended can repeat
half-done work; reply to a session or `xpi roost respawn` it instead); a schedule whose task is a shell command or an
agent definition; messages between sessions and watches (with agent teams, later); subagents in the hub (each session
shows its own); the task board and workspaces, the concierge, worktree isolation, pull request status, fan-out and
`/compare`, sessions from agent definitions, terminal agents other than xpi, the summary model, pi-mobile and telemetry.
The list, with the decision behind each, is in [Left out](../../xpi-roost/docs/porting.md#left-out). pi-roost's state
and `roost.json` are not read: its sessions do not appear here.

## Port background sessions

To bring background sessions into another agent harness, start from [Porting xpi features](porting.md#roost-core):
the roost core, the session side, the hub, schedules and the login service are separate entries there, each with its
dependencies and a link to the detailed guide, [Porting roost](../../xpi-roost/docs/porting.md).
