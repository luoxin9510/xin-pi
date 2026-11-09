# 07: Docs, repo conventions and the upstream-merge procedure

**What to build:** the knowledge moves with the code. `packages/pipipi/README.md` and `docs/porting.md` (updated for the native capability), AGENTS.md note for the package, and a root `docs/xin-pi.md` that lists what xin-pi changed in upstream-owned files and how to merge upstream. A dry-run merge proves the procedure.

**Blocked by:** 06

**Status:** ready-for-agent

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [ ] README and porting guide moved; layer 4 rewritten (no wrapper, no proxy, controller instead); "Keeping up with pi" points at the xin-pi merge procedure
- [ ] `docs/xin-pi.md`: product line, `xpi` command and env names (`XPI_CODING_AGENT_DIR`), the upstream-owned files we changed (spec "Merge-cost budget") with one line why each, the procedure for porting from upstream (rename script, /upstream), how to run offline vs real-model pipipi tests
- [ ] Root `AGENTS.md`: one short section for `packages/pipipi` (indent/lint via `npm run check`, test scripts, real-model suites by hand); no company information anywhere
- [ ] Dry run of porting: pick one small upstream commit since the fork point, apply it with the rename script on a throwaway branch, `npm run check` green
- [ ] `npm run check` green (docs-only changes need no check, but the AGENTS.md change is verified by reading)

## Comments
