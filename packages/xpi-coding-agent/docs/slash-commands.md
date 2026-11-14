# Slash commands

Type `/` in Pi's terminal editor to search the commands available in the current session. This page lists the built-in commands in the current Pi release.

Extensions, prompt templates, and skills can add commands. The command menu in Pi is therefore the exact reference for the resources loaded in your session.

## Models and settings

| Command | Description |
|---|---|
| `/settings` | Open settings |
| `/model [provider/model]` | Select a model |
| `/thinking [level]` | Set the thinking level |
| `/scoped-models` | Configure the models used by interactive cycling |
| `/login [provider]` | Add provider authentication |
| `/logout` | Remove provider authentication |
| `/llama` | Manage models on the configured llama.cpp router |

## Sessions and context

| Command | Description |
|---|---|
| `/new` | Start a new session |
| `/resume` | Resume another session |
| `/name [name]` | Set the session display name, or show the current name when omitted |
| `/session` | Show current session information and statistics |
| `/tree` | Navigate the session tree |
| `/fork` | Create a new session from an earlier user message |
| `/clone` | Duplicate the current session at its current position |
| `/compact [instructions]` | Compact the current context, optionally with custom instructions |
| `/import <path>` | Import a JSONL session, preserving its ID and working directory |

## Export and share

| Command | Description |
|---|---|
| `/copy` | Copy the last assistant message |
| `/export [path]` | Export the session as HTML or JSONL |
| `/share` | Upload the session and return a viewer link |
| `/bug [description]` | Prepare a private bug report for the Pi developers |

Review a session before exporting or sharing it. Sessions can contain prompts, tool arguments, command output, file contents, and credentials exposed during the conversation.

## Runtime and project

| Command | Description |
|---|---|
| `/trust` | Save a project trust decision for future Pi processes |
| `/mcp` | Manage MCP servers: sign in, reconnect, enable or disable, and change exposure |
| `/reload` | Reload keybindings, extensions, skills, templates, themes, and context files |
| `/hotkeys` | Show active keyboard shortcuts |
| `/changelog` | Show changelog entries |
| `/quit` | Quit Pi |

## Subagents and workflows

Added by the built-in `subagent` extension (see [Subagents](subagent.md)); absent with `-builtin:subagent`.

| Command | Description |
|---------|-------------|
| `/subagents` | Pick one of the session's subagents and open its screen |
| `/subagents stop` | Stop every running subagent and script of the session |
| `/subagents worktrees` | List the kept subagent worktrees of the checkout and remove the ones you pick |
| `/subtask <task>` | Start a fork: a copy of this conversation that does a side task in the background and reports back |
| `/tasks` | Open the agent team's task list (id, status, owner, subject, blockers), which refreshes as the files change; needs [agent teams](subagent.md#agent-teams) on |
| `/sg [import \| export [--apply] \| merge <branch> \| status \| sbx ls]` | [shadow-git](shadow-git.md#agents-in-xpi): import, export, merge and status for the shadow-git workspace this session is in; only registered there |
| `/workflows` | List saved workflows and this session's workflow runs; Enter runs a workflow, acts on a run that is going (its agents, pause or resume, stop), or relaunches one that stopped or failed |
| `/<workflow name> [args]` | Run a saved workflow with no model turn; `args` is JSON or text |
| `/review [target]` | Built-in workflow: review the uncommitted changes (no target), a branch (changes since it diverged), a commit, or `#N` (a GitHub PR) with parallel read-only `reviewer` agents and a verifier; returns ranked findings and edits nothing. A `review.js` of your own hides it. See [Built-in workflows](subagent.md#built-in-workflows) |

## Background sessions

Added by the built-in `roost` extension (see [Background Sessions](roost.md)); absent with `-builtin:roost`. macOS and
Linux with the npm installation of xpi.

| Command | Description |
|---------|-------------|
| `/agents` | Open the hub: the sessions the daemon runs; start, peek, reply, attach, stop. Also in a session the daemon runs |
| `/bg [prompt]` | Hand this conversation to the daemon and open the hub on it; a running turn is interrupted and continues there. Also `/background`; the left arrow on an empty prompt does it too (`roost.leftArrowOpensAgents`) |
| `/bg-fork [prompt]` | Copy this conversation into a new background session; this one carries on |

`/bg`, `/background` and `/bg-fork` are not there in a session the daemon runs (it is in the background already).

## Upstream

| Command | Description |
|---------|-------------|
| `/upstream` | Report what upstream pi has that xin-pi does not (built-in `upstream` extension) |
| `/handover [instructions]` | [Relay](relay.md): give the work to the worker model now, without a plan from the lead |
| `/handback` | [Relay](relay.md): wake the lead now; the worker reports where things stand |
| `/relay` | [Relay](relay.md): show who has the work, the round and the two models |

## Commit

| Command | Description |
|---------|-------------|
| `/commit [hint] [--yes]` | Draft a commit message for the staged changes with a small model, edit it, and commit (built-in `commit` extension) |

`/commit` reads `git diff --cached`. With nothing staged it offers to stage tracked changes (`git add -u`); untracked
files are never added. Lockfiles appear only in the `--stat` summary and the diff text is capped at about 60k
characters; files beyond the cap are named. The model also gets the last 20 commit subjects, your `hint` (for example
`fixes #12`) and the commit rules of the repo: the sections of `AGENTS.md` (else `CLAUDE.md`) at the repo root whose
heading mentions "commit", or, when no heading does, the paragraphs that mention it. The message opens in an editor;
an empty message or cancel commits nothing. Without a UI (print mode) it prints the message and commits only with
`--yes`. The commit runs your hooks and is never `--no-verify`, `--amend` or pushed; when a hook fails its output is
shown and nothing is retried. The model is the `commit.model` [setting](settings.md#commit) (default `haiku`); a
failed model call shows its error kind and commits nothing.

## Commands added by resources

- Extensions can register commands with their own arguments and completion behavior.
- Each prompt template is available under its template name.
- Skills are available as `/skill:name` when skill commands are enabled.

Use `/reload` after adding or changing a discovered command resource. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md), and [Skills](skills.md) for their loading and naming rules.
