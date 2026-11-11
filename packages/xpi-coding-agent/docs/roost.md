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
| `xpi roost ls [--all] [--cwd <dir>] [--json]` | List sessions: waiting first, then working, then ended ones (`--all` includes those ended over 48 hours ago) |
| `xpi roost logs <id\|name>` | Print the session's screen |
| `xpi roost log [-n <count>] [--follow] [<id\|name>]` | What happened lately: started, finished, waiting, replied, stopped |
| `xpi roost reply <id\|name> <text>` | Send a reply. A working session gets it as a follow-up once its turn ends; an idle one starts a turn |
| `xpi roost attach <id\|name>` | Open the session's TUI in this terminal |
| `xpi roost stop <id\|name>` / `rm <id\|name>` | Stop it; `rm` also deletes its record |
| `xpi roost respawn <id\|name>` | Start an ended session again |

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

## The hub

The hub lists the sessions the daemon runs and lets you start, watch, answer and open them. `/agents` opens it in a
session (over the conversation, or in place of the editor with `"fullscreen": false`); `xpi roost hub [dir]` opens it in
a terminal of its own, with new sessions starting in `dir` (default: the current directory). A foreground xpi is not in
the list until it is handed over with `/bg`; subagents are not listed (see `/subagents` in their session).

Rows are grouped by state (needs input, working, completed; pinned first) or by directory. Each row shows its name, what
it is doing or its last result, its model and context use, what it spent, and its age.

| Key | What it does |
|---|---|
| type, Enter | Start the typed task as a new session in the hub's directory (`@dir task`: in that directory; `! command`: a shell command as a session) |
| Ctrl+Enter | Start the typed task and attach to it |
| Enter or → | Attach to the selected session (its own TUI); the [detach keys](#attach-and-detach) bring you back |
| Space | Peek: its task, directory, state, model, cost, queued replies and the end of its transcript, with a reply box |
| in a peek: Enter / Alt+Enter | Send the reply: it joins the current work (as in xpi), or waits for it to end |
| in a peek: `/…` | Act on that session: `/stop`, `/respawn`, `/rm`, `/pin`, `/rename`, `/attach`, `/model`, `/thinking`, `/name`, `/compact`, `/continue`, `/log`, `/transcript`, the session's own commands, and xpi's (see below) |
| Ctrl+X | Stop; again within 2 s deletes (on a group header: the group) |
| Ctrl+T, Ctrl+R | Pin or unpin (pinned sessions are never stopped for being idle), rename |
| Ctrl+O | Mark the row (on a header: the group); typed text, `/model`, `/thinking`, Ctrl+X and Ctrl+T then act on every marked session |
| Shift+↑ Shift+↓, Alt+↑ Alt+↓ | Move the row within its group, jump to the previous or next group |
| Alt+1…9 | Attach to row N of this directory |
| Ctrl+S | Group by state or by directory (saved to your settings) |
| Ctrl+F, `s:` `n:` `o:` | Filter by name, state or result |
| Ctrl+L, Ctrl+P, Shift+Tab | The model for new sessions (in a peek: for that session), the next enabled model, the next thinking level |
| Ctrl+G | Write the task or reply in `$VISUAL` / `$EDITOR` |
| ? | All keys |
| Esc, Ctrl+C twice | Close the peek, clear the input, unmark, then leave the hub (sessions keep running) |

The hub's own commands, typed in the input:

| Command | What it does |
|---|---|
| `/model [provider/model]`, `/thinking [level]` | The model and thinking level of new sessions (bare: pick; `default` resets) |
| `/preset [name]` | Apply a saved choice of model, thinking level and directory for new sessions; `/preset save <name>`, `/preset rm <name>`, `/preset off` |
| `/resume` | Open a past session in the background (xpi's session list: search, this directory or all) |
| `/usage` | What the sessions spent: today, in all, by model and by session |
| `/log` | What happened lately: starts, questions, results, replies, newest first |

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
| the left arrow on an empty prompt | `/bg`; with no saved conversation yet, it just opens the hub |

`/bg` waits up to ten seconds for a running tool to finish (the left arrow again skips the wait), interrupts the turn,
and the session continues in the background with "Continue where you left off." and your prompt. It leaves the
session file first, so only the daemon's session writes to it. In the hub the moved session is shown in bold, with
"Your conversation moved to the background" above the list; Esc goes into it. `/bg` refuses while a dialog is open,
during compaction, and without a session file (`--no-session`).

The session keeps this xpi's current model and thinking level, and gets this xpi's trust decision for the folder by
the rule [above](#start-a-session). `"leftArrowOpensAgents": false` turns the left arrow off. In a session the daemon
runs, the left arrow detaches instead (see [Attach and detach](#attach-and-detach)).

## Settings

The `roost` block of `settings.json` (see [Settings](settings.md#background-sessions)):

| Setting | Default | Applies to |
|---|---|---|
| `dispatchModel` | the session default | the model of a session `--bg` or the hub starts, unless the command line gives `--model` or `--provider` |
| `dispatchThinking` | the session default | its thinking level, unless the command line gives `--thinking` |
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
| `reapIdleMinutes` | `60` | a session idle, not attached and not pinned this long is stopped; it starts again on attach or reply |
| `cleanupDays` | `30` | records of sessions that ended this many days ago are removed (`0` keeps them) |

The environment keys are read from your own settings only: a project's `.pi/settings.json` cannot choose which of your
environment reaches its sessions. Whatever the lists say, a session gets the variables that say where its roost is,
so `xpi roost` inside it reaches the same daemon.

## Where things are

- **State**: `<agent dir>/xpi-roost/`: one directory per session in `jobs/` (its record, its state, its last screen,
  its command list), the order of the list, the event log and the daemon's log. The agent directory is `~/.pi/agent` unless `XPI_CODING_AGENT_DIR` says
  otherwise.
- **Sockets**: `$XDG_RUNTIME_DIR/xpi-roost-<key>` or `/tmp/xpi-roost-<uid>/<key>`, one per agent directory.
- **One daemon per agent directory**. It starts on demand with the first command that needs it and stops with
  `xpi roost daemon stop`. An xpi with another agent directory has a daemon and sessions of its own.

Each xpi session also holds a lock next to its session file (`<file>.lock`) while it is open, so the daemon never
starts a session on a file another xpi has open.

## Requirements

- **macOS or Linux.** On Windows `--bg`, `/agents`, `/bg` and `xpi roost` say background sessions are not supported
  (use WSL).
- **The npm installation of xpi** (`npm install -g xpi-coding-agent`). A standalone binary has no Node runtime for the
  daemon and says so.
- **node-pty**, an optional dependency installed with xpi. On Linux it compiles during the install and needs python3,
  make and a C++ compiler. Without it `--bg` and `xpi roost respawn` say how to reinstall it.

After an upgrade, a running daemon still has the old code: run `xpi roost daemon stop --keep-workers`, then
`xpi roost respawn --all`. Every command says so when the versions differ.

## Not there yet

- Sessions resuming on their own after an interruption, schedules, and messages between sessions.
