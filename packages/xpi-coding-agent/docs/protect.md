# Protected paths

A model can read `.env` or a private key and send it to the provider, or edit `.git/` or `node_modules/` by mistake.
The built-in `protect` extension blocks the file tools from both: secrets cannot be read or written, and a few paths
cannot be written. It is on by default and configured with gitignore patterns.

It is a backstop against mistakes, not a sandbox (see [What it does not cover](#what-it-does-not-cover)).

Not part of it: parsing `bash`, `powershell` or codemode `exec` commands, prompts or approval modes, network or process
restrictions.

## What is blocked

Two levels, each a list of patterns:

| Level | Blocks | Default patterns |
|---|---|---|
| `secret` | read and write | `.env`, `.env.*`, `!.env.example`, `!.env.sample`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `!*.pub` |
| `readOnly` | write | `.git/`, `node_modules/` |

A path in both lists is a secret.

The check runs at `tool_call`, so codemode's nested calls are covered too. It applies to a tool whose effect is `read` or
`write` and whose input has a string `path`: `read`, `write`, `edit`, `grep`, `find`, `ls`, and any extension or MCP tool
that names its target `path`. Tools with an `exec` effect (`bash`, `powershell`) and tools without a `path` are not
checked.

A blocked call returns a reason to the model, for example:

```
`.env` is protected (secret): it cannot be read or written. If it is needed, ask the user.
```

or, for a read-only path, `` `.git/config` is protected (read-only): it cannot be written. If a change is needed, ask the user. ``
With a UI you also get a warning notification, `protect: blocked read of .env (secret)`. In print mode and in subagents
only the model is told. There is no prompt, so unattended sessions never wait.

## Settings

```json
{
  "protect": {
    "secret": ["config/credentials.json", "!.env.local"],
    "readOnly": ["vendor/"]
  }
}
```

Both lists are in `.pi/settings.json` or `~/.pi/agent/settings.json`; see [Settings](settings.md#protect). The patterns
are gitignore patterns. The effective list of a level is read in order: the defaults, then the user's entries, then the
project's entries. The last match wins and `!pattern` undoes an earlier one, so `!.env.local` above lets `.env.local`
through.

The user's and the project's lists are concatenated, not replaced: a project adds to your entries. A project's
`.pi/settings.json` is loaded only when the project is trusted, so a repository you did not trust adds and removes
nothing. Settings are read at each call, so a change applies to the next one.

An entry that is not a string is skipped, with one warning notification per session; the rest of the list and the
defaults still apply.

## How a path is matched

- The path is resolved the way the tools resolve it (`~`, a leading `@`, relative to the working directory).
- Two forms are tested: the resolved path and its real path (symlinks followed). For a file that does not exist yet,
  the real path is that of its nearest existing ancestor plus the rest. A call is blocked if either form matches, so a
  symlink named `notes.txt` that points to `.env` is a secret.
- Inside the project (the session's working directory) the path is matched relative to it; outside, as the absolute
  path without its leading `/`. A pattern without a slash, such as `id_rsa*`, matches at any depth, so `~/.ssh/id_rsa`
  is a secret too. An anchored pattern such as `config/credentials.json` matches only inside the project.
- The project root itself is never matched: `ls .` and a `grep` without a path are allowed.
- A directory pattern also matches a file of that name: `.git/` blocks writing `.git` when it is a file, as in a git
  worktree, and `vendor/` blocks a file named `vendor`.
- Case does not matter on macOS and Windows, and does on Linux.
- On Windows the drive's colon is dropped (`C:\Users\x\.ssh\id_rsa` is matched as `C/Users/x/.ssh/id_rsa`), UNC paths
  drop their leading `\\`, a `\\?\` path drops its prefix and then its drive colon (`\\?\C:\x` is matched as
  `C/x`), and separators are `/`.
- Gitignore rules hold, including their limit: a file under an excluded directory cannot be re-included, so
  `!node_modules/keep.js` has no effect after `node_modules/`.
- A path with a scheme (`name://...`) is skipped: the scheme's extension owns it.

## What it does not cover

- **`bash`, `powershell` and codemode `exec`** are not parsed. `cat .env` in a shell command is not blocked.
- **Searches over a directory.** `grep` and `find` are checked on their `path` like any read: `grep` with
  `path: ".env"` is blocked, but a `grep` over the project is not, even if the project contains a secret. The tool runs
  ripgrep with `--hidden`, and ripgrep applies `.gitignore` only inside a git repository: in a folder that is not a
  repository, or where `.env` is not ignored, a search over the project prints `.env` lines.
- **File-backed schemes.** A scheme can resolve to a local file; the path is skipped before that, so a file-backed scheme
  is a known gap.
- **Extensions that rewrite `input.path`.** Built-in extensions load before yours, so a `tool_call` handler of a user
  extension that changes `input.path` after protect has run gets past it.
- **`--no-extensions`** drops every built-in, protect included.

## /protect

- `/protect` shows whether protection is on for this session and the effective lists of both levels.
- `/protect off` and `/protect on` switch it for this session only, in memory. A new or resumed session, a `/reload` and a fork start with
  protection on again. Subagents and other sessions are not affected; each has its own switch.

Only you can run a command, so the model cannot turn protection off. Turn the extension off for good with
`-builtin:protect` in `extensions`.

Subagents, workflow agents and roost sessions load the built-ins and follow the same rules; see
[Protect in subagents](subagent.md#protect-in-subagents).

Source: `src/extensions/protect/` (`match.ts`, `index.ts`). Tests, run singly from `packages/xpi-coding-agent`:
`test/protect-match.test.ts` and `test/suite/protect.test.ts`.
