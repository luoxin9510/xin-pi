# 01: `/commit` built-in extension

Spec: `../02-commit.md`, decisions 1 and 8-12 in `../decisions.md`.

**What to build:** a built-in extension `builtin:commit` with one command `/commit [hint]`. It reads the staged diff,
asks a small model for a message through `ctx.complete` with a schema, opens the message in an editor for the owner,
and runs `git commit` with the accepted text.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `src/extensions/commit/`, registered with the other built-in extensions; can be turned off like them
- [ ] Staged diff only; with nothing staged, `ui.confirm` to stage tracked changes (`git add -u`); untracked never
- [ ] Lockfiles as stat only; diff capped at about 60k characters, the rest as per-file stat
- [ ] Context: the commit section of `AGENTS.md`/`CLAUDE.md` when present, last 20 commit subjects, the `hint`
- [ ] `ctx.complete({ model, schema, purpose: "commit" })`, schema `{ type, scope?, summary, body? }`; `type: "custom"`
      means `summary` is the whole subject (repo convention differs)
- [ ] Setting `commit.model` (default `haiku`) in the settings schema, defaults and manager
- [ ] `ui.editor` with the message; empty or cancel commits nothing; print mode prints the message and commits only with
      `--yes`
- [ ] `git commit -F <temp file>`; never `--no-verify`, `--amend`, push; a failing hook's output is shown, no retry
- [ ] A `ctx.complete` error is shown with its kind; nothing is committed
- [ ] Tests (faux provider, temp git repo): propose and commit; edited message used; cancel; nothing staged + stage offer
      (accept and decline); untracked file not staged; failing pre-commit hook shown; large diff capped; hint reaches
      the prompt; `--yes` in print mode; model setting used
- [ ] Docs: `packages/xpi-coding-agent/docs/slash-commands.md`, `docs/settings.md` (`commit.model`), the built-in
      extensions list wherever it is documented, `docs/xin-pi.md`, `README.md` if it lists built-ins

## Comments
