# 07: A look at xpi

**What to build:** the owner uses `xpi` in a real session and decides whether it can replace `pi` for pipipi work.

**Blocked by:** 01-06

**Status:** ready-for-human

- [ ] `xpi` in a project: delegate a task (main stays free, panel shows `S1` and its agents, the result arrives as a message), ctrl+b on a slow script, `x` on a script row, Esc during a background run, `/subagents` screen, `-builtin:pipipi` off switch
- [ ] Check that `xpi` and `pi` coexist: same `~/.pi/agent` sessions and auth, no clash from the old pi-pipipi package listed in `settings.json` (remove that entry when switching; see spec open question 3)
- [ ] Decision recorded in Comments: switch daily use to `xpi` (and remove the old package entry), or list what is missing

- [ ] Switch (decision 21, after the owner's yes): `xpi` installed globally; old pi-pipipi removed from `~/.pi/agent/settings.json`; `npm uninstall -g @earendil-works/pi-coding-agent` (confirm with the owner first); `xpi` starts with sessions, auth and other packages intact

## Comments
