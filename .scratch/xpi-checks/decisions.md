# Decisions: checks after edits

## Grill 1 (2026-11-14). Accepted by the owner on 2026-11-14 ("都按照推荐做")

1. When: once per turn, at `turn_end`, when the turn ran a tool that changes things; the new errors go to the model
   as a message before its next request (a turn with tool calls always has one).
2. What: the commands named in settings (`checks.commands`); off when none. Built-in parsers for the common formats.
3. New: compared with the previous check over the whole project, with a baseline before the first change.
4. Trigger: any `write` or `exec` tool in the turn (bash and codemode too); read-only turns never.
5. Subagents: yes, same settings.
6. Limits: 60 s per command (a timeout is one line, skipped), at most 20 errors per message, a collapsed line in the
   TUI.

Naming (author): the feature is `checks` (setting `checks`, `builtin:checks`), because `settings-diagnostics.ts`
already means problems with settings files.

After the spec's first review (author's corrections, no decision changed): effects come from `tool_call` (by id),
not from the turn's results; no check when every result of the turn terminates the run (no next request); abort also
by `ctx.signal`; the wait for the baseline is bounded and a command without one reports nothing once; the message is a
`display: true` entry returned with the earlier entries; a status line while checks run; `docs/xin-pi.md` and the
READMEs in the docs list.
