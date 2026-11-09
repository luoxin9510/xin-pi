# 07: Docs, repo conventions and the upstream-merge procedure

**What to build:** the knowledge moves with the code. `packages/pipipi/README.md` and `docs/porting.md` (updated for the native capability), AGENTS.md note for the package, and a root `docs/xin-pi.md` that lists what xin-pi changed in upstream-owned files and how to merge upstream. A dry-run merge proves the procedure.

**Blocked by:** 06

**Status:** closed (done 2026-11-09)

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [x] README and porting guide moved; layer 4 rewritten (no wrapper, no proxy, controller instead); "Keeping up with pi" points at the xin-pi merge procedure
- [x] `docs/xin-pi.md`: product line, `xpi` command and env names (`XPI_CODING_AGENT_DIR`), the upstream-owned files we changed (spec "Merge-cost budget") with one line why each, the procedure for porting from upstream (rename script, /upstream), how to run offline vs real-model pipipi tests
- [x] Root `AGENTS.md`: one short section for `packages/pipipi` (indent/lint via `npm run check`, test scripts, real-model suites by hand); no company information anywhere
- [x] Dry run of porting: pick one small upstream commit since the fork point, apply it with the rename script on a throwaway branch, `npm run check` green
- [x] `npm run check` green (docs-only changes need no check, but the AGENTS.md change is verified by reading)

## Comments

### Done

- `docs/xin-pi.md` rewritten as the single doc: product line (`xpi`, `xpi-*` packages, `XPI_*` incl. `XPI_CODING_AGENT_DIR`, removed packages), built-ins `subagent` and `upstream`, core changes of the codemode background controller file by file, "Keeping up with pi" (porting via `/upstream` + `scripts/xpi-rename.mjs`, the no-alias rule and how to translate an old `@earendil-works/*` extension), offline vs real-model test scripts.
- `packages/xpi-coding-agent/docs/subagent.md` (from the pi-pipipi README; names translated, dev section rewritten for `test:subagent*`) and `subagent-porting.md` (layer 4 rewritten for the native controller: `codemodeScripts`, `beginCodemodeScript`, detach/release, no wrapper or proxy). Linked from `docs/xin-pi.md`, `docs/index.md` and `docs/docs.json`.
- Root `README.md`: what xin-pi is, run from source, pointer to `docs/xin-pi.md`; upstream installers, Nix, release-source and OSS-session-sharing sections removed. `AGENTS.md`: new section "Subagent and upstream extensions"; stale Chord/Durable build note dropped.
- Dry run of porting (2026-11-09): upstream/main equals the fork point (7d073328e, no new commits), so a past upstream commit was replayed. On throwaway branch `xpi-07-dryrun-throwaway`: (1) reverse-applied upstream `566344046` (retry pattern fix, `packages/ai/src/utils/retry.ts` + test, path rewritten to `packages/xpi-ai/`) and committed as the "not yet ported" state; (2) `git format-patch -1 566344046`, then `node scripts/xpi-rename.mjs port.patch` (the script rewrites paths inside a patch file: `packages/ai` to `packages/xpi-ai`); (3) `git apply --check` then `git apply`: clean, 2 files, +9 lines; (4) `xpi-rename --check` on the touched files clean, xpi-ai `test/retry.test.ts` 39/39, `npm run check` green. Branch deleted, not merged. The rename script handles patch files, so small commits need no cherry-pick.
