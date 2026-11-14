# Spec 01: protected paths

Status: approved by the owner on 2026-11-15 (Grills 1 and 2 in `decisions.md`, all as recommended).

## Problem

A model can read `.env` or a private key and send it to the provider, or edit `.git/` or `node_modules/` by mistake.
`examples/extensions/protected-paths.ts` shows the idea, but it is an example, not a feature: it matches by
substring (`foo.environment` matches `.env`), blocks writes only, and cannot be configured.

## Goal

A built-in that blocks file tools from reading secrets and from writing protected paths, on by default, configured
with gitignore patterns.

Not in this spec: parsing `bash`, `powershell` or codemode `exec` commands (decision 6); prompts or approval modes;
network or process restrictions.

## Design

### 1. Settings (decisions 2, 7, 8)

```json
{
  "protect": {
    "secret": ["config/credentials.json", "!.env.local"],
    "readOnly": ["vendor/"]
  }
}
```

- Both are lists of gitignore patterns (the `ignore` package). The effective list of a level is: its defaults, then
  the user's entries, then the project's entries, read in order; the last match wins and `!pattern` negates, so an
  entry can undo a default.
- Defaults:
  - `secret`: `.env`, `.env.*`, `!.env.example`, `!.env.sample`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`,
    `!*.pub`.
  - `readOnly`: `.git/`, `node_modules/`.
- **Core change, `settings-manager.ts`:** `protect.secret` and `protect.readOnly` of the two layers are concatenated
  (user first), the way `mergeDefaultTools` treats `defaultTools`, instead of the project replacing the user's list.
  A malformed value (not an array of strings) replaces, as there.
- Trust: an untrusted project's settings are not loaded (today's behaviour), so it adds and removes nothing; a test
  pins this. A trusted project can add and remove.
- Schema next to `ChecksSettingsSchema` in `core/settings-schema.ts`; defaults in `core/settings-defaults.ts`;
  `npm run generate:schemas` regenerates `schemas/settings.schema.json`.
- Read with `pi.getSettings()` at each call, never cached, so a settings change applies to the next call.

### 2. What is checked (decisions 3, 6)

At the `tool_call` event (codemode's nested calls emit it too, so a script is covered):

- `effect` `read` or `write`, and the input has a string `path` (`read`, `write`, `edit`, `grep`, `find`, `ls`, and
  any extension or MCP tool that names its target `path`). `exec` tools and tools without a `path` are not checked.
- A `path` with a scheme (`name://...`) is skipped: the scheme's extension owns it.
- `grep` and `find` are checked on their `path` like any read: `grep` with `path: ".env"` is blocked; `grep` over a
  directory is not, even if the directory contains a secret (decision 3).
- Levels: a `secret` match blocks `read` and `write`; a `readOnly` match blocks `write`. A path matching both is a
  secret.

### 3. Matching (decision 4)

- Resolve with `resolveToCwd(path, ctx.cwd)` (the tools' own resolver: `~`, `@`, relative paths).
- Candidates: the resolved path, and its real path (`realpath` of the path, or of its nearest existing ancestor
  joined with the rest, for a file that does not exist yet). A call is blocked if any candidate matches.
- A candidate inside `ctx.cwd` is matched as its path relative to `ctx.cwd`; a candidate outside is matched as its
  absolute path without the leading `/` (a pattern without a slash, such as `id_rsa*`, matches at any depth, so
  `~/.ssh/id_rsa` matches; an anchored pattern such as `config/x` only matches inside the project).
- A directory pattern (`.git/`) matches the directory and everything under it.
- Case: case-insensitive on macOS and Windows, case-sensitive elsewhere (`ignore`'s `ignorecase`).
- A pattern list the `ignore` package rejects is reported once per session as a warning notification and that entry is
  skipped; the defaults still apply.

### 4. A blocked call (decisions 5, 11)

- The handler returns `{ block: true, reason }`. Reasons, written for the model:
  - secret: `` `<path>` is protected (secret): it cannot be read or written. If it is needed, ask the user. ``
  - read-only: `` `<path>` is protected (read-only): it cannot be written. If a change is needed, ask the user. ``
- With a UI, a `warning` notification: `protect: blocked <read|write> of <path> (<level>)`. Without one (print mode,
  subagents), only the reason.

### 5. `/protect` (decision 10)

- `/protect`: a notification with the state (on or off for this session) and the effective lists of both levels.
- `/protect off`, `/protect on`: for this session only, in memory; a new or resumed session starts on. Subagents and
  other sessions are not affected (decision 9).

### 6. Where it runs (decisions 1, 9)

- `builtin:protect`, registered with the other built-ins, loaded by default; `"-builtin:protect"` turns it off.
- Subagents, workflow agents and roost sessions load built-ins and get the same rules.

### 7. The example

`examples/extensions/protected-paths.ts` stays as an example of the `tool_call` API; its header says the built-in
`protect` does this for real.

## Tests

- Unit (`test/protect-match.test.ts`): the default lists (`.env` blocked, `.env.example` not, `foo.environment` not,
  `id_rsa.pub` not, `.git/config` write blocked and read allowed); user and project entries in order, `!` undoing a
  default; a path outside the project (`~/.ssh/id_rsa`); a symlink to `.env` under another name; a new file under
  `.git/`; case on darwin; a scheme path skipped; a bad pattern skipped.
- Settings (`test/settings-manager.test.ts`): the two lists concatenate across layers; an untrusted project's list is
  ignored.
- Suite (`test/suite/protect.test.ts`, faux provider): a direct `read` of `.env` is blocked with the reason; a nested
  codemode `write` to `.git/x` is blocked; `/protect off` lets it through and `/protect on` restores it; `grep` over the
  project is not blocked.
- A real Haiku check by hand (the lead runs it): asked to print `.env`, the model gets the reason and does not get the
  content through `read`.

## Docs

New `docs/protect.md` (what, defaults, levels, matching, the bash caveat, `/protect`); `docs/settings.md` (the
`protect` block and the built-in list), `docs/porting.md` (a row for the component), `docs/subagent.md` (built-ins in
children), `docs/xin-pi.md`, both READMEs, `docs/extensions.md` if the example's text changes, `docs.json`.
