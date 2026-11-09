# 02: Slim: remove chord, durable, env and the apps

**What to build:** xin-pi no longer carries packages it does not use. `packages/chord`, `packages/durable`, `packages/env`, `apps/p2` and `apps/p3` are deleted, and everything that referenced them is cleaned, so the repo builds, checks and runs `xpi` exactly as before.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] First verify and record in Comments: nothing in coding-agent, ai, agent, tui, codemode, mcp, schema, telemetry, evals imports the removed packages at runtime or in tests (grep incl. examples, scripts, docs that are executed)
- [ ] Deleted: the five directories; root `package.json` workspaces (incl. `packages/chord/test/examples/...`), `build` / `build:offline` chains, scripts referencing them (`scripts/*.mjs`, `release-packages`, browser smoke, entry graphs), root and examples `tsconfig` paths, `package-lock.json` regenerated with `npm install`
- [ ] CHANGELOG / docs mentions left alone unless they are build inputs
- [ ] `npm run build`, `npm run check` green; `./xpi-test.sh --help` (or the dev launcher from 01) runs; the pipipi tracer check from 01 still passes (one haiku call)
- [ ] One commit for the deletion, one for the cleanup

## Comments
