# 03: Rename every package to `xpi-*` with a committed script

**What to build:** all packages carry xin-pi names: `@earendil-works/pi-ai` → `xpi-ai`, `pi-agent-core` → `xpi-agent-core`, `pi-tui` → `xpi-tui`, `pi-coding-agent` → `xpi-coding-agent`, `pi-codemode` → `xpi-codemode`, `pi-mcp` → `xpi-mcp`, `pi-schema` → `xpi-schema`, `pi-telemetry` → `xpi-telemetry`, `pi-evals` → `xpi-evals` (unscoped), each directory renamed to match (`packages/xpi-ai`, ...). Done by a script in `scripts/` that is committed and reusable on code ported from upstream.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `scripts/xpi-rename.mjs`: one mapping table; renames package names in every `package.json` (name, deps, peerDeps, exports untouched), import specifiers in `.ts`/`.tsx`/`.js`/`.mjs`/`.json` (incl. subpath imports like `@earendil-works/pi-ai/oauth`), tsconfig `paths`, build scripts, the bundle/esbuild configs, `scripts/*.mjs` lists; `--check` mode exits non-zero if any old name remains outside CHANGELOGs; idempotent
- [ ] Directories renamed with `git mv` (history kept); root workspaces and build chains updated
- [ ] Literal `PI_*` env names used by the app become `XPI_*` where they are app config (record the list and any kept on purpose); `piConfig.name: "xpi"` already from 01
- [ ] Not renamed on purpose (record in Comments): CHANGELOG history, the LICENSE notice, upstream URLs in docs that point to the original project
- [ ] LICENSE keeps the original copyright line and adds the owner's; root README says xin-pi is based on pi by earendil-works
- [ ] `npm install`, `npm run build`, `npm run check` green; `scripts/xpi-rename.mjs --check` passes; the dev launcher runs `xpi`; one haiku Agent call still works
- [ ] Commits: the script; the mechanical run (script output only); manual fixes

## Comments
