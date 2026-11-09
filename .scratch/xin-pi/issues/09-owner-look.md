# 09: A look at xpi

**What to build:** the owner uses `xpi` in a real session and decides whether it can replace `pi` for pipipi work.

**Blocked by:** 01-08

**Status:** closed (done 2026-11-09)

- [x] `xpi` in a project: delegate a task (main stays free, panel shows `S1` and its agents, the result arrives as a message), ctrl+b on a slow script, `x` on a script row, Esc during a background run, `/subagents` screen, `-builtin:pipipi` off switch
- [x] Check that `xpi` and `pi` coexist: same `~/.pi/agent` sessions and auth, no clash from the old pi-pipipi package listed in `settings.json` (remove that entry when switching; see spec open question 3)
- [x] Decision recorded in Comments: switch daily use to `xpi` (and remove the old package entry), or list what is missing

- [x] Switch (decision 21, after the owner's yes): `xpi` installed globally; old pi-pipipi removed from `~/.pi/agent/settings.json`; `npm uninstall -g @earendil-works/pi-coding-agent` (confirm with the owner first); `xpi` starts with sessions, auth and other packages intact

## Comments

- 2026-11-09: the owner tried xpi (installed from `npm run xpi:pack` + `npm i -g ./dist-pack/xpi-coding-agent-1.5.0.tgz`), ran `/upstream` (0 upstream commits since the fork, correct; a misleading "did not fetch" line led to fix 7e712f794), and approved the merge: PR #1 merged as ce20af7ba. Third-party packages had already been removed from ~/.pi/agent (backup ~/.pi/agent/backup-2026-11-09/). With the owner's confirmation `npm uninstall -g @earendil-works/pi-coding-agent` ran; `pi` is gone, `xpi --version` 1.5.0, `xpi --list-models` works with the existing auth, one haiku print-mode call answered with the real ~/.pi/agent; 176 sessions still in ~/.pi/agent/sessions.
