# 03b: Rename pipipi to `subagent` inside xpi

**What to build:** decision 30. Every pipipi name inside xpi becomes `subagent`: `builtin:subagent`, `src/extensions/subagent/`, settings `subagent.*`, message customType `subagent`, env `XPI_SUBAGENT_*`, identifiers/comments/docs that say pipipi (except history notes that it came from the pi-pipipi repo).

**Blocked by:** 03

**Status:** done

- [x] `git mv` the directory; registration name `subagent`; `-builtin:subagent` disables the Agent tool and `/subagents`; `xpi config` lists `subagent`
- [x] Settings namespace `subagent.*` with the same keys; config errors name `subagent.<key>`
- [x] Env vars: every `PIPIPI_*` becomes `XPI_SUBAGENT_*` (list them in Comments)
- [x] Message customType `subagent`; session dirs/meta formats unchanged unless they embed the name (record)
- [x] `grep -ri pipipi` in the extension, its tests and docs finds only provenance notes
- [x] `npm run check` green; one haiku Agent call through xpi; `-builtin:subagent` check

## Comments

- 2026-11-09: done. Commits: rename (`git mv` of `src/extensions/pipipi` to `src/extensions/subagent` plus text), resource-loader test fix (`pi remove` to `xpi remove`, 2 tests; that file plus subagent-extension test: 76 pass).
- Renamed: builtin registration `subagent` (`-builtin:subagent` removes the Agent tool; `xpi config` shows `subagent` under Built-in); settings namespace `subagent.*` (same keys, errors say `subagent.<key>`); message customType `pi-pipipi` to `subagent`; notification/log prefixes `pi-pipipi:` to `subagent:`; identifiers; temp dir prefixes and request ids (`subagent-`, `subagent-prompt`, `subagent-model-N`); panel key `subagent-panel`; built-in agent assets path `extensions/subagent/builtin` (package.json copy-assets/files).
- Env vars: `PIPIPI_DEPTH` to `XPI_SUBAGENT_DEPTH`; `PIPIPI_CHILD_CODEMODE` to `XPI_SUBAGENT_CHILD_CODEMODE`; `PIPIPI_TEST_PI` to `XPI_SUBAGENT_TEST_PI`.
- Decision to note: worktree branch prefix `pipipi/<agentId>` is now `subagent/<agentId>` (the name is embedded). Kept worktrees on old `pipipi/*` branches are no longer listed by `/subagents worktrees`. Session dirs/meta formats embed no name; unchanged.
- `grep -ri pipipi` over the package src, tests and docs: zero hits (no provenance notes were needed there). `.scratch` docs still say pipipi as history.
- Verified: `npm run build` and `npm run check` green; built xpi rpc (`--model anthropic/claude-haiku-5-5 --tools +codemode`, temp XPI_CODING_AGENT_DIR with only auth.json) ran `tools.Agent(...)`, agent replied OK (completed, 1 turn); with `"extensions":["-builtin:subagent"]` in that temp settings.json: `tools.Agent does not exist`. The CLI form `-e -builtin:...` does not work; disabling is via the `extensions` setting.
