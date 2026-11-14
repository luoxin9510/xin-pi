# Decisions: protected paths

## Grill 1 (2026-11-15). Accepted by the owner on 2026-11-15 ("按照推荐就可以了")

1. Form: a built-in extension `builtin:protect`, on by default with a default list; `"-builtin:protect"` in
   `extensions` turns it off, like the other built-ins.
2. Default list: `.env` and `.env.*` (not `.env.example` or `.env.sample`), `.git/`, private keys (`*.pem`, `*.key`,
   `id_rsa*`, `id_ed25519*`), `node_modules/`.
3. Two levels: secrets (`.env`, keys) can be neither read nor written, because reading sends them to the provider;
   `.git/` and `node_modules/` can be read but not written. A search rooted above a secret (`grep`/`find` over the
   project) is not blocked: ripgrep honours `.gitignore`, where `.env` normally is.
4. Matching: the path is resolved to an absolute path, symlinks followed, and matched as a glob, not as a substring;
   paths outside the project are matched too (`~/.ssh/id_rsa`).
5. On a match: the call is blocked with a reason for the model; no prompt (prompts would hang subagents and
   unattended roost sessions).
6. `bash` and codemode's `exec` are not parsed; the docs say the feature is a backstop.

## Grill 2 (2026-11-15). Accepted by the owner on 2026-11-15 ("都按照推荐")

7. Settings: two glob lists, `protect.secret` (no read, no write) and `protect.readOnly` (no write). Entries are
   added after the defaults; `"!<pattern>"` removes one, as in the other resource lists.
8. A project's settings may add entries; removing one with `!` takes effect only in a trusted project.
9. Subagents, workflow agents and roost sessions get the same rules, without exception.
10. `/protect` shows the rules in force; `/protect off` and `/protect on` turn the protection off and on for this
    session only. Only the user can run a command; a new session starts with the protection on.
11. A blocked call: the model gets the reason; with a UI, a warning notification; in print mode and in subagents only
    the model is told.

Facts found while writing the spec (author):

- An untrusted project's `.pi/settings.json` is not loaded at all (see spec 01 of `xpi-checks`), so decision 8 holds
  without code: an untrusted project can neither add nor remove. A trusted project can do both.
- Settings layers deep-merge with the project replacing arrays, so a project list would replace the user's. The lists
  are concatenated instead (user, then project), as `defaultTools` already is (a small change in
  `settings-manager.ts`).
- Patterns are gitignore patterns (the `ignore` package, already a dependency): last match wins and `!` negates, so
  "defaults, then user, then project" is one list read in order.
