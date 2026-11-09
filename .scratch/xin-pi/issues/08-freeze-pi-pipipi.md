# 08: Freeze the pi-pipipi repo

**What to build:** `~/Developer/pi-pipipi` is frozen at its current main with a README note "merged into xin-pi". Nothing else changes there; the owner's global `pi` keeps loading it.

**Blocked by:** 05

**Status:** closed (done 2026-11-09)

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [x] Parity statement in Comments: the xin-pi commit and test results (offline suites; real-model suites by hand) at which the old repo's behaviour is matched
- [x] pi-pipipi `README.md` top note: "Merged into xin-pi (`packages/pipipi`); this repo is frozen. Development continues there." with the repo path/URL; no other file touched
- [x] That one-line commit is the only new commit on pi-pipipi `main`; global `pi` still starts and loads it (`pi --version`, one Agent call) afterwards
- [x] `~/.pi/agent/settings.json` is NOT edited here (the owner switches when ready)

## Comments

- 2026-11-09: pi-pipipi main db8f56c adds the Frozen note (merged into xin-pi as built-in `subagent`), the only new commit. Parity: xin-pi 536c653ec+ — offline 129/129, real 77/77 (+4 new), parent 12/12, tui 13/13, evals 51/51, stress 20/20 (ticket 05). The global-pi load check no longer applies: on the owner's request all third-party packages, pi-pipipi included, were removed from ~/.pi/agent/settings.json the same day (backup ~/.pi/agent/backup-2026-11-09/).
