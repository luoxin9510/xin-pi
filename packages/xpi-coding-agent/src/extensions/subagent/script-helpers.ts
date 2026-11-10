// Script helpers (spec .scratch/xin-pi-workflows/02-workflows.md): `agent`, `parallel`, `pipeline`, `phase`, `log` in
// every codemode script that can call Agent, so a script main writes runs unchanged as a saved workflow. They are a
// codemode add-on: a one-line prelude (functions cannot cross into the sandbox, so the callback helpers live there)
// over two host globals. Also here: the cap on agents per script run.

import { AsyncLocalStorage } from "node:async_hooks";
import type { CodemodeTool } from "xpi-codemode";
import type { CodemodeAddon } from "../codemode/addons.ts";
import { codemodeScripts } from "../codemode/scripts.ts";
import { scripts } from "./background.ts";

export const PIPELINE_MAX_ITEMS = 4096;

// The phase an `agent()` call was made in, from the host global to the Agent call it makes (agent-tool.ts reads it).
export const agentPhase = new AsyncLocalStorage<string | undefined>();

// The prelude, in the script's scope. `__subagentAgent(args, phase)` runs one Agent call and resolves to its result
// object; `__subagentNote(note)` reports a phase or a log line. Kept free of comments: it is joined into one line.
const PRELUDE = [
	"(() => {",
	"const g = globalThis, run = g.__subagentAgent, note = g.__subagentNote;",
	"let current = null;",
	'const words = (p) => p.trim().split(/\\s+/).slice(0, 5).join(" ").slice(0, 60);',
	"const orNull = (start) => Promise.resolve().then(start).then((v) => v, () => null);",
	"g.agent = async (prompt, opts) => {",
	'if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("agent() expects a prompt string");',
	"const o = opts ?? {};",
	'if (typeof o !== "object" || Array.isArray(o)) throw new Error("agent() options must be an object");',
	'const a = { description: typeof o.label === "string" && o.label.trim() !== "" ? o.label : words(prompt), prompt };',
	"if (o.schema !== undefined) a.schema = o.schema;",
	"if (o.type !== undefined) a.subagent_type = o.type;",
	"if (o.model !== undefined) a.model = o.model;",
	"if (o.effort !== undefined) a.effort = o.effort;",
	"if (o.isolation !== undefined) a.isolation = o.isolation;",
	"const r = await run(a, current);",
	"const name = JSON.stringify(a.description);",
	'if (r.status === "failed") throw new Error("agent " + name + " failed: " + (r.error ?? "no error given"));',
	"if (o.schema === undefined) return r.output;",
	'if (r.structured === undefined) throw new Error("agent " + name + " ended " + r.status + " without structured output");',
	"return r.structured;",
	"};",
	"g.parallel = (tasks) => {",
	'if (!Array.isArray(tasks)) throw new Error("parallel() expects an array of functions or promises");',
	'return Promise.all(tasks.map((t) => orNull(() => (typeof t === "function" ? t() : t))));',
	"};",
	"g.pipeline = (items, fn) => {",
	'if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items");',
	'if (typeof fn !== "function") throw new Error("pipeline() expects a function (item, index)");',
	`if (items.length > ${PIPELINE_MAX_ITEMS}) throw new Error("pipeline() takes at most ${PIPELINE_MAX_ITEMS} items, got " + items.length);`,
	"return Promise.all(items.map((item, i) => orNull(() => fn(item, i))));",
	"};",
	"g.phase = (title, fn) => {",
	'if (typeof title !== "string" || title.trim() === "") throw new Error("phase() expects a title");',
	'note({ kind: "phase", title });',
	"current = title;",
	"if (fn === undefined) return undefined;",
	'if (typeof fn !== "function") throw new Error("phase() expects a function as its second argument");',
	"return Promise.resolve().then(fn);",
	"};",
	'g.log = (text) => { note({ kind: "log", text: String(text) }); };',
	'if (!("args" in g)) g.args = undefined;',
	"})();",
].join(" ");

// The script's run, found from its codemode call id (the registry tracks scripts by their nested call ids).
const scriptOf = (toolCallId: string) => scripts.owner(`${toolCallId}/`);

export const scriptHelpers: CodemodeAddon = {
	name: "subagent-helpers",
	applies: (toolNames) => toolNames.includes("Agent"),
	prelude: PRELUDE,
	globals: (script): CodemodeTool[] => [
		{
			name: "__subagentAgent",
			spread: true,
			execute: (callArgs, { signal }) => {
				const [args, phase] = callArgs as [unknown, string | null];
				return agentPhase.run(phase ?? undefined, () => script.callTool("Agent", args, signal));
			},
		},
		{
			name: "__subagentNote",
			execute: (note) => {
				const n = note as { kind: "phase"; title: string } | { kind: "log"; text: string };
				const run = scriptOf(script.toolCallId);
				if (run) scripts.note(run, n.kind === "phase" ? { phase: n.title } : { log: n.text });
				return null;
			},
		},
	],
};

// --- the cap on agents per script run: counted per script (ad hoc ones too), the next call past it throws.

const started = new Map<string, number>();

export function countScriptAgent(toolCallId: string, max: number): void {
	const owner = codemodeScripts.owner(toolCallId);
	if (!owner) return; // not called from a script
	const n = (started.get(owner.id) ?? 0) + 1;
	if (n > max) {
		throw new Error(
			`this script already started ${max} agents, the most one run may start (subagent.maxAgentsPerScript)`,
		);
	}
	started.set(owner.id, n);
	if (started.size > 200) {
		const running = new Set(codemodeScripts.list().map((s) => s.id));
		for (const id of started.keys()) if (!running.has(id)) started.delete(id);
	}
}
