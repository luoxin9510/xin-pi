// A process of the hold-timeout test (hooks.test.ts): a handler that holds forever, and nothing else keeps the process alive.
// The call awaiting the hold must finish on the timeout: with only an unref'd timer the event loop would drain and node
// would exit with code 13 (unsettled top-level await) instead of printing the verdict.
import { createEventBus } from "../../../src/core/event-bus.ts";
import { runHook } from "../../../src/extensions/subagent/team-hooks.ts";

const bus = createEventBus();
bus.on("agent-teams:task_completed", (p) => (p as { hold(x: Promise<undefined>): void }).hold(new Promise(() => {})));
const verdict = await runHook({ bus, warn: () => {}, holdTimeoutMs: 100 }, "task_completed", {});
console.log(JSON.stringify(verdict));
