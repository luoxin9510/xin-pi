# Tickets: spec 01, protected paths

Spec: `.scratch/xpi-protect/01-protect.md`. One PR (branch `protect`): independent Opus review, green CI, the docs, a
real Haiku check before merge.

- [x] P1 settings: schema and defaults for `protect.secret` and `protect.readOnly`; the two layers concatenate in
      `settings-manager.ts`; the trust rule pinned; `npm run generate:schemas`
      Done: `protect.secret`/`readOnly` in schema and defaults; `mergeProtect` concatenates layers; trust and merge tests in `test/settings-manager.test.ts`; schemas regenerated.
- [x] P2 matching: `extensions/protect/match.ts` (resolve, real path, inside/outside the project, levels, case, bad
      patterns); unit tests
      Done: `extensions/protect/match.ts`; `test/protect-match.test.ts` (15 tests, incl. Windows forms and simulated win32).
- [x] P3 `builtin:protect`: `tool_call` handler (read/write effects, `path`, schemes skipped), block reasons, warning
      notification, `/protect` with `off`/`on`; registered with the built-ins; suite tests with a faux provider
      Done: `extensions/protect/index.ts`, registered in `extensions/index.ts`; `test/suite/protect.test.ts` (6 tests, faux provider).
- [x] P4 the example's header points to the built-in
      Done: header of `examples/extensions/protected-paths.ts` and the two example tables point to the built-in.
- [x] P5 docs: `protect.md`, `settings.md`, `porting.md`, `subagent.md`, `xin-pi.md`, both READMEs, `docs.json`
      Done: `protect.md`, `settings.md`, `slash-commands.md`, `porting.md`, `subagent.md`, `xin-pi.md`, both READMEs, `docs.json`, `extensions.md`.
- [x] P6 the real Haiku check (the lead runs it)

      (Done: recorded in PR #116, "Real Haiku check (P6)".)