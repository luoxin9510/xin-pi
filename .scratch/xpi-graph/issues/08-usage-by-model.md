# Tickets: spec 03 milestone 2, nested usage by model

Spec: `.scratch/xpi-graph/03-replay.md` (section 7). One PR (branch `usage-by-model`), after milestone 1:
`npm run check`, the core, subagent and package tests, green CI, an independent Opus review, the docs.

- [ ] U1.1 `usageByModel?: { provider, model, usage }[]` on `AgentToolResult` and `AfterToolCallResult`
      (`xpi-agent-core`), `ToolResultMessage` (`xpi-ai`), the `tool_result` event and result; `agent-loop.ts` copies
      it with `usage`; `usage` stays the total; never a virtual model
- [ ] U1.2 the subagent runner adds each assistant message's usage per physical model (`responseModel`, else
      `model`); the Agent tool returns it (background agents stay uncounted)
- [ ] U1.3 codemode `models.*` calls add their usage under the resolved model
- [ ] U1.4 the nested-call recorder keeps per-model usage for its total and its unreported part; the message-start
      merge joins the tool's own `usageByModel` with its nested calls'
- [ ] U1.5 a `tool_result` hook returning `usage` without `usageByModel` drops the attribution
- [ ] U1.6 `_releaseNestedCalls` writes one usage entry per model, plus the rest under `unknown` / `unattributed`;
      never the session's selected model
- [ ] U1.7 `getUsageCostBreakdown`: `usageByModel` per model; unattributed tool usage and `unknown/unattributed`
      entries under `Tools/unattributed`; summaries stay `Tools/summaries`
- [ ] U1.8 the graph report's `byModel`: nested usage under its model, only the unattributed rest under
      `nested calls`
- [ ] U1.9 docs: `docs/extensions.md`, `docs/porting.md`, where tool result messages and the cost breakdown are
      described, `docs/graph.md` (`byModel`, older sessions)
- [ ] U1.10 by hand (in `decisions.md`): a Haiku 5.5 run with a subagent in a node; `/graph` and the cost breakdown
      name the subagent's model
