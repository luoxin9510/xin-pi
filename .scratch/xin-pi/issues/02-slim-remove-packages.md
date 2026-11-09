# 02: Slim: remove chord, durable, env and the apps

**What to build:** xin-pi no longer carries packages it does not use. `packages/chord`, `packages/durable`, `packages/env`, `apps/p2` and `apps/p3` are deleted, and everything that referenced them is cleaned, so the repo builds, checks and runs `xpi` exactly as before.

**Blocked by:** 01

**Status:** closed (done 2026-11-09)

- [x] First verify and record in Comments: nothing in coding-agent, ai, agent, tui, codemode, mcp, schema, telemetry, evals imports the removed packages at runtime or in tests (grep incl. examples, scripts, docs that are executed)
- [x] Deleted: the five directories; root `package.json` workspaces (incl. `packages/chord/test/examples/...`), `build` / `build:offline` chains, scripts referencing them (`scripts/*.mjs`, `release-packages`, browser smoke, entry graphs), root and examples `tsconfig` paths, `package-lock.json` regenerated with `npm install`
- [x] CHANGELOG / docs mentions left alone unless they are build inputs
- [x] `npm run build`, `npm run check` green; `./xpi-test.sh --help` (or the dev launcher from 01) runs; the pipipi tracer check from 01 still passes (one haiku call)
- [x] One commit for the deletion, one for the cleanup

## Comments

- 2026-11-09: done in efe76f6bf (deletion) and a7d051a25 (cleanup: root workspaces/build chains, tsconfig paths, vitest base, scripts incl. entry-graphs/browser-smoke/install-lock/preview-packages, husky, CI workflows env/env-daemons/p2-cloud-bundle removed, ci.yml/build-binaries.yml edited, lockfile). Nothing kept imported the removed packages (only comments/docs in mcp and coding-agent shell.ts mention them). Verified: `npm run build`, `npm run check` green; one haiku Agent call through the built xpi returned OK.
