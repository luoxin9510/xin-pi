# Tickets: spec 01, protected paths

Spec: `.scratch/xpi-protect/01-protect.md`. One PR (branch `protect`): independent Opus review, green CI, the docs, a
real Haiku check before merge.

- [ ] P1 settings: schema and defaults for `protect.secret` and `protect.readOnly`; the two layers concatenate in
      `settings-manager.ts`; the trust rule pinned; `npm run generate:schemas`
- [ ] P2 matching: `extensions/protect/match.ts` (resolve, real path, inside/outside the project, levels, case, bad
      patterns); unit tests
- [ ] P3 `builtin:protect`: `tool_call` handler (read/write effects, `path`, schemes skipped), block reasons, warning
      notification, `/protect` with `off`/`on`; registered with the built-ins; suite tests with a faux provider
- [ ] P4 the example's header points to the built-in
- [ ] P5 docs: `protect.md`, `settings.md`, `porting.md`, `subagent.md`, `xin-pi.md`, both READMEs, `docs.json`
- [ ] P6 the real Haiku check (the lead runs it)
