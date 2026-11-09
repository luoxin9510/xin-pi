# 03b: Rename pipipi to `subagent` inside xpi

**What to build:** decision 30. Every pipipi name inside xpi becomes `subagent`: `builtin:subagent`, `src/extensions/subagent/`, settings `subagent.*`, message customType `subagent`, env `XPI_SUBAGENT_*`, identifiers/comments/docs that say pipipi (except history notes that it came from the pi-pipipi repo).

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] `git mv` the directory; registration name `subagent`; `-builtin:subagent` disables the Agent tool and `/subagents`; `xpi config` lists `subagent`
- [ ] Settings namespace `subagent.*` with the same keys; config errors name `subagent.<key>`
- [ ] Env vars: every `PIPIPI_*` becomes `XPI_SUBAGENT_*` (list them in Comments)
- [ ] Message customType `subagent`; session dirs/meta formats unchanged unless they embed the name (record)
- [ ] `grep -ri pipipi` in the extension, its tests and docs finds only provenance notes
- [ ] `npm run check` green; one haiku Agent call through xpi; `-builtin:subagent` check

## Comments
