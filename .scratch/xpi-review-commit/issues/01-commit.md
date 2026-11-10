# 01: `/commit` built-in extension

Spec: `../02-commit.md`, decisions 1 and 8-12 in `../decisions.md`.

**What to build:** a built-in extension `builtin:commit` with one command `/commit [hint]`. It reads the staged diff,
asks a small model for a message through `ctx.complete` with a schema, opens the message in an editor for the owner,
and runs `git commit` with the accepted text.

**Blocked by:** None (can start immediately)

**Status:** in review

- [x] `src/extensions/commit/`, registered with the other built-in extensions; can be turned off like them
- [x] Staged diff only; with nothing staged, `ui.confirm` to stage tracked changes (`git add -u`); untracked never
- [x] Lockfiles as stat only; diff capped at about 60k characters, the rest as per-file stat
- [x] Context: the commit section of `AGENTS.md`/`CLAUDE.md` when present, last 20 commit subjects, the `hint`
- [x] `ctx.complete({ model, schema, purpose: "commit" })`, schema `{ type, scope?, summary, body? }`; `type: "custom"`
      means `summary` is the whole subject (repo convention differs)
- [x] Setting `commit.model` (default `haiku`) in the settings schema, defaults and manager
- [x] `ui.editor` with the message; empty or cancel commits nothing; print mode prints the message and commits only with
      `--yes`
- [x] `git commit -F <temp file>`; never `--no-verify`, `--amend`, push; a failing hook's output is shown, no retry
- [x] A `ctx.complete` error is shown with its kind; nothing is committed
- [x] Tests (faux provider, temp git repo): propose and commit; edited message used; cancel; nothing staged + stage offer
      (accept and decline); untracked file not staged; failing pre-commit hook shown; large diff capped; hint reaches
      the prompt; `--yes` in print mode; model setting used
- [x] Docs: `packages/xpi-coding-agent/docs/slash-commands.md`, `docs/settings.md` (`commit.model`), the built-in
      extensions list wherever it is documented, `docs/xin-pi.md`, `README.md` if it lists built-ins

## Comments

- Registered in `src/extensions/index.ts` as `commit` (not replaceable); off with `-builtin:commit`. Skipped in subagent
  children (`XPI_SUBAGENT_DEPTH`), like `/upstream`.
- Settings: `commit.model` is in the schema, `SETTINGS_DEFAULTS.commit.model` and the generated JSON schema. No
  `SettingsManager` getter: the extension reads `pi.getSettings().commit?.model` (the manager has no relay or upstream
  getter either), so a getter would have no caller.
- Repo rules: sections of `AGENTS.md` (else `CLAUDE.md`) at the repo root whose heading mentions "commit"; when no
  heading does, the paragraphs mentioning it; capped at 4000 characters. Documented in `slash-commands.md`.
- Print mode with nothing staged prints a message and stops (no stage offer, since there is no UI).
- `docs/xin-pi.md` said "Two built-in extensions" while listing three; now "Four" with the commit entry.
