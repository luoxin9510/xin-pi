# 06: /upstream — what upstream pi has that xin-pi does not

**What to build:** a `/upstream` command (in `packages/xpi`, injected like pipipi) that gathers upstream facts with git and injects a prompt into the current main agent, which writes a comparison report with recommendations. No dedicated subagent; read-only by instruction.

**Blocked by:** 05

**Status:** ready-for-agent

Decisions Grill 2 (22-28) override anything below that assumes merging upstream, `packages/pipipi`, `packages/xpi` or `@earendil-works/*` names: pipipi lives in `xpi-coding-agent/src/extensions/pipipi`, packages are named `xpi-*`.

- [ ] Source dir from setting `xinpi.sourceDir` (default `~/Developer/xin-pi`); not a git checkout with an `upstream` remote → fallback mode (below); a notice says which mode ran
- [ ] Git mode: `git fetch upstream`; data file with the merge-base, upstream commits not in `main` (subject, author date, files), diffstat, the upstream-owned files xin-pi changed (`git diff upstream/main...main --stat` limited to non-xin-pi packages), and new upstream `packages/coding-agent/CHANGELOG.md` entries; written to `~/.pi/agent/upstream/<YYYY-MM-DD-HHMM>-data.md`
- [ ] Fallback mode: upstream `CHANGELOG.md` from GitHub raw compared with the bundled coding-agent version; same data file shape, marked partial
- [ ] Prompt injected with `pi.sendUserMessage` (or `sendMessage` + `triggerTurn`; steer if main is busy): the data file path, the four report sections (upstream changes grouped as features / fixes / breaking; conflicts with our changes; overlap with xin-pi's built-ins such as subagents or background scripts, recommending upstream's or ours; a recommendation list with merge as-is / port or adapt / skip plus reason and risk), "read-only: do not edit files, do not merge", where to write the report (`~/.pi/agent/upstream/<stamp>.md`), and to end with a suggested next step (e.g. a sync branch); main may delegate with the Agent tool if the data is large
- [ ] The prompt stays small: facts in the data file, not inline; the data file caps per-commit file lists so it stays readable
- [ ] Tests: data gathering on a temp repo with a fake `upstream` remote (no network), fallback with a stubbed fetch, prompt shape and delivery (idle → new turn, busy → steer) with a fake pi API; one real-haiku run on a temp repo checks a report file is written with the four section headings
- [ ] Docs: `docs/xin-pi.md` gets a `/upstream` section

## Comments
