# 08: Freeze the pi-pipipi repo

**What to build:** `~/Developer/pi-pipipi` is frozen at its current main with a README note "merged into xin-pi". Nothing else changes there; the owner's global `pi` keeps loading it.

**Blocked by:** 05

**Status:** ready-for-agent

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [ ] Parity statement in Comments: the xin-pi commit and test results (offline suites; real-model suites by hand) at which the old repo's behaviour is matched
- [ ] pi-pipipi `README.md` top note: "Merged into xin-pi (`packages/pipipi`); this repo is frozen. Development continues there." with the repo path/URL; no other file touched
- [ ] That one-line commit is the only new commit on pi-pipipi `main`; global `pi` still starts and loads it (`pi --version`, one Agent call) afterwards
- [ ] `~/.pi/agent/settings.json` is NOT edited here (the owner switches when ready)

## Comments
