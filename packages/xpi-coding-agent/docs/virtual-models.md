# Virtual Models

A virtual model is a selectable model that picks a physical model for each request. Use one to route by task, cost, or conversation state. For example, a router can send quick questions to a small model and hard problems to a large one, while the user selects a single model.

Register virtual models from an [extension](extensions.md). They appear in `/model`, `--model`, scoped models, and settings like any other model. A virtual model can be listed under any provider, including one with physical models, such as `openai-codex/auto`.

## Selection and dispatch

A virtual model selects a model and a thinking level. A router maps that pair to a physical pair for each request:

```
selected (virtual model, virtual level)  ->  dispatched (physical model, physical level)
jev/auto:low                             ->  anthropic/claude-sonnet-4-5:high
```

The virtual thinking level is an input to the router. Its meaning is up to the router; it need not correspond to a reasoning budget.

Pi keeps the two pairs apart:

| | Selection | Dispatch |
|---|---|---|
| Recorded in | `model_change` and `thinking_level_change` entries | Each assistant message: `provider`, `api`, `model`, `thinkingLevel` |
| Visible as | `ctx.model`, `ctx.thinkingLevel`, `XPI_MODEL`, `XPI_REASONING_LEVEL`, `/model` | The assistant message of each response |

Providers only receive physical models. Assistant messages name the physical model, so replaying a conversation across different physical models works the same as after a manual model switch. Resuming a session restores the virtual selection from its latest `model_change` entry. If the virtual model is no longer registered, Pi falls back to the physical model that answered last.

In interactive mode, the footer shows the routed model next to the selection, for example `auto • high → gpt-5.6-luna • medium`. `/session` lists the cost for each physical model.

After a request is routed and its state is stored, the `request_start` event fires (not when routing or resolving the physical model fails); see [extensions](extensions.md#request_start).

Context usage uses the limits of the physical model that produced the latest response, even if that response came before switching to the virtual model. Without such a response, it uses the limits declared on the virtual model, if any. Compaction checks the same limits, and again the limits of the model each request is routed to. If that model's context window is too small for the conversation, Pi compacts before sending the request; the route stays as the router chose it.

## Register a virtual model

```typescript
import type { ExtensionAPI } from "xpi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "high"],
    route(request, ctx) {
      // Tool follow-ups and retries stay on the model that handled the turn.
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      const id = request.thinkingLevel === "high" ? "claude-sonnet-4-5" : "claude-haiku-4-5";
      return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium" };
    },
  });
}
```

- `provider` is the provider the model is listed under. It can be any provider ID. A provider can list several virtual models next to its physical ones. On a physical provider, the virtual model is available when that provider has credentials. Under an ID that no provider uses, it is always available. A virtual model is used only when it is named (`--model`, the default model in settings, scoped models, a resumed session); when pi picks a model on its own because none is named or the named one has no credentials, it skips virtual models.
- `id` must not be the ID of a physical model of that provider. If a catalog refresh later adds a physical model with the same ID, the virtual model hides it.
- `thinkingLevels` lists the levels offered for selection. It defaults to `["off"]`.
- `contextWindow` and `maxTokens` are shown before the first response. Unset limits are unknown.
- `input` lists the input types offered for selection. It defaults to text and images; physical models without image support receive placeholders.

Registration follows the same queuing and reload rules as `pi.registerProvider()`. Registering the same provider and ID again replaces the virtual model. `pi.unregisterVirtualModel(provider, id)` removes it; `pi.unregisterProvider()` does not. SDK code can register one without an extension: `modelRuntime.registerVirtualModel(definition)`.

## Route requests

`route(request, ctx)` runs before every request made with the virtual model and returns `{ model, thinkingLevel }`. The model can be any physical model in the catalog whose provider has credentials; look it up with `ctx.modelRegistry`. A virtual model cannot route to another virtual model. Pi clamps the thinking level to the returned model.

| Field | Meaning |
|---|---|
| `model`, `thinkingLevel` | The selected virtual model and level |
| `reason` | Why the request is made, see below |
| `previous` | Physical model and thinking level of the latest successful response in `messages` |
| `failed` | For `retry`: physical model, thinking level, and assistant `message` of the failed request, which `messages` no longer contains. The message carries `stopReason` and `errorMessage`. Absent when routing itself failed |
| `state` | Router state last returned on this session branch, see below |
| `messages` | The conversation for this request, including system messages |
| `signal` | Abort signal of the request |

| `reason` | Request |
|---|---|
| `user` | First request after a message the user wrote, including steering and follow-up messages |
| `continuation` | Any other request in the agent loop, such as after tool results or extension messages |
| `retry` | Automatic retry after a failed request, including after compaction for a context overflow |
| `direct` | Request made outside the agent loop, such as a compaction summary or an extension calling `ctx.modelRegistry.streamSimple()` |

Returning `previous` for `continuation` and `failed` for `retry` keeps prompt caches and thinking signatures valid. Switching models between turns is allowed but loses the prompt cache. A retry can also switch to another model, for example when `failed.message.errorMessage` reports that a provider is overloaded or the context overflowed.

If `route()` throws, or returns a virtual model or a model without credentials, the request ends with an error response.

### Limit the context

`route()` can also return `contextLimit`, a number of prompt tokens. Before the request, Pi compacts when the estimated context exceeds the smaller of this limit and the routed model's usual threshold (its context window minus `compaction.reserveTokens`). Without `contextLimit` nothing changes. The value must be a positive integer; anything else ends the request with an error that names the virtual model and the value. Pi ignores it for `direct` requests.

- A limit at or above the usual threshold never delays a compaction, and a compaction the threshold triggers is an ordinary one.
- A limit-triggered compaction is skipped when the newest context entry on the branch is a compaction that no assistant response has followed. That is the only guard: in an agent loop every request follows a response, so a limit below what a summary can reach (`compaction.keepRecentTokens` plus the system prompt and tool declarations) compacts on every request. Whoever returns the limit must keep it reachable and cap how often it compacts.
- `compaction.enabled: false` disables the route limit too.
- Pi prunes old tool output first. When the pruned estimate is at most 90 percent of the limit, no summary is written and the conversation's messages stay; otherwise a summary follows. See [Compaction](compaction.md#a-route-context-limit).
- The compaction entry records the limit in its `contextLimit` field, and `session_before_compact` carries it, whoever supplies the summary.

### Keep a prefix cached

`route()` can also return `cache: { key, holdPrefix? }` to label the request for the prompt cache. Pi ignores it for `direct` requests, and a request that fails validation (`key` or `holdPrefix` not a non-empty string, or `holdPrefix` equal to `key`) ends with an error that names the virtual model.

- `key` names the role of the request. Pi remembers the latest session request sent under each key: its physical model, its tools and system prompt, and its options as sent.
- `holdPrefix` names another key. While requests carrying it keep coming and the agent run is active, Pi keeps the cached prefix (tools and system prompt) of that key's remembered request warm.
- A refresh is a new request, not a replay of the conversation: the remembered tools and system prompt (every system message of the remembered request, in order), one short user message (`.`), the remembered options with a one-token output cap, no retries, no continuation. The prefix goes through the same request building as the original, so the provider gets the same tools and system blocks with the same cache breakpoints; a test pins that on the Anthropic payload, for a model that takes system and tool changes in the middle of a conversation and for one that folds them into the head. Whether the provider then serves the refresh from the same cache entry is its own behavior; the usage of each refresh shows it (a cache read, or a cache write when it missed). It is sent at 90 percent of the cache lifetime of the held model for the retention the request used, and it is recorded as a `cache_warm` usage entry with the note `held prefix: <key>`. It never enters the context.
- Pi decides each refresh from the held model's prices. The prefix tokens are estimated as characters divided by 4 of the system prompt and tool definitions. The saving is those tokens times the cache write price minus the cache read price; a refresh costs the tokens at the cache read price plus one output token. Pi refreshes while what the refreshes have cost so far plus the next one stays below the saving, then lets the entry expire. Unknown prices: no refresh, unless an extension overrides the decision; then only the one-hour limit ends the hold. A refresh that missed is counted at what it was billed, a cache write, so the next decision stops. The $0.05 minimum of the ordinary [cache warming](settings.md#model-and-thinking) does not apply, because the saving is one known cache write.
- A request under the held key, or a labelled request that does not hold it, ends the hold. So do the end of the agent run (in every `cacheWarming` mode), a change of the selected model away from the virtual model, a change of the session branch, and disposing the session. `cacheWarming: "off"` disables it. A request without a label (a summary, `ctx.complete`, a subagent, a refresh itself) neither sets nor ends a hold.
- Extensions see each refresh in [`cache_warming_decision`](extensions.md#cache_warming_decision), with the `key` of the held prefix, and can stop it. `/session` shows a held prefix on its own line.

The ordinary cache warmer still keeps only the latest request of the selected model warm, so it warms nothing under a virtual model; a held prefix is separate from it and neither clears the other. [Relay](relay.md#the-leads-cached-prefix) uses it to keep the lead's prefix alive during a worker phase.

## Keep routing state

`route()` can return `state` next to the model. Pi stores it on the session branch and passes it back as `request.state` on later requests. Use it for decisions the transcript does not record, such as classifier results or a routing phase:

```typescript
pi.registerVirtualModel<{ phase: "plan" | "build" }>({
  provider: "router",
  id: "phased",
  name: "Phased",
  route(request, ctx) {
    const state = request.state ?? { phase: "plan" };
    const id = state.phase === "plan" ? "claude-opus-4-5" : "claude-haiku-4-5";
    return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium", state };
  },
});
```

- State must be JSON-serializable. Returning `undefined` or `request.state` itself keeps the current state.
- Pi stores any other returned object as new state, before the request is sent, even when it equals the current state. Return a new object only when the state changes. The state stays stored if the request later fails.
- State follows the session tree, so forks and `/tree` navigation see the state of their branch. It survives compaction.
- `direct` requests have no state, and Pi ignores state they return.

The transcript already records the selection and every dispatched model, and `ctx.sessionManager.getBranch()` exposes both.

Routers can call other models through `ctx.modelRegistry`, for example `ctx.modelRegistry.classify()` with a classifier model from `ctx.modelRegistry.findOfType("classifier", provider, id)`. The call adds latency before the first token of the turn.

See [`jev-router.ts`](../examples/extensions/jev-router.ts) for a complete router. It plans on a strong OpenAI Codex model chosen by the Jev classifier, lets that model make the first edit, and then switches once to a cheaper model, accepting a single prompt-cache miss. It keeps the phase as router state.

xpi ships one virtual model, [`relay/auto`](relay.md): a lead model plans and reviews, a worker model builds, and the
worker's phase reaches the lead as a compacted record. It uses `contextLimit` to keep the worker under its model's first price tier (see [Relay: The worker's context limit](relay.md#the-workers-context-limit)) and `cache` to keep the lead's prefix warm during a worker phase (see [Relay: The lead's cached prefix](relay.md#the-leads-cached-prefix)).
