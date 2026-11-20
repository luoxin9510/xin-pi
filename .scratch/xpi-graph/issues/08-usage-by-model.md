# Tickets: spec 03 milestone 2, nested usage by model

Spec: `.scratch/xpi-graph/03-replay.md` (section 7). One PR (branch `usage-by-model`), after milestone 1:
`npm run check`, the core, subagent and package tests, green CI, an independent Opus review, the docs.

- [ ] U1.1 `usageByModel?: { provider, model, usage }[]` on a tool's result (`AgentToolResult`, the extension tool
      result types) and on tool result messages; `usage` stays the total
- [ ] U1.2 the Agent tool fills it with the model its run used (not for background agents, which stay uncounted)
- [ ] U1.3 the nested-call recorder keeps attributed usage per model besides the total; a model-issued tool result
      message carries its nested calls' `usageByModel`
- [ ] U1.4 `_releaseNestedCalls` writes one usage entry per model, plus the unattributed rest under `unknown` /
      `unattributed`; never the session's selected model
- [ ] U1.5 `getUsageCostBreakdown` uses a tool result message's `usageByModel`; the rest stays `Tools/summaries`
- [ ] U1.6 the graph report's `byModel` puts nested usage under its model, only the unattributed rest under
      `nested calls`
- [ ] U1.7 docs: `docs/extensions.md`, `docs/porting.md`, where tool result messages are described, `docs/graph.md`
      (`byModel`)
- [ ] U1.8 by hand (in `decisions.md`): a Haiku 5.5 run with a subagent in a node; `/graph` and the cost breakdown
      name the subagent's model
