// M75: `npm run docs:protocol` writes the op reference of docs/protocol.md (between the
// markers) from the schemas in src/lib/protocol-schema.ts, the callers table
// (src/lib/callers.ts) and the capability lists (src/lib/protocol.ts).
// test/protocol-doc.test.ts fails when it is stale.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POLICY, type Policy, type PolicyKey } from "../../src/lib/callers.ts";
import {
	AGENT_CAPABILITIES,
	type AgentCapability,
	DAEMON_CAPABILITIES,
	type DaemonCapability,
	PROTOCOL_VERSION,
} from "../../src/lib/protocol.ts";
import {
	ArgSchemas,
	ContextInfoS,
	DaemonStatusSchema,
	DispatchArgsSchema,
	HelloArgsSchema,
	HelloResultSchema,
	JobRowSchema,
	OPS,
	ResultSchemas,
	WorkerReportSchema,
} from "../../src/lib/protocol-schema.ts";
import { looseOf, type Schema } from "../../src/lib/schema.ts";

export const DOC_PATH = fileURLToPath(new URL("../../docs/protocol.md", import.meta.url));
export const START = "<!-- op-reference:start -->";
export const END = "<!-- op-reference:end -->";

const DAEMON_CAPABILITY_DOC: Record<DaemonCapability, string> = {
	replies: "takes the user's replies for the session (`deliver`, `ack`)",
	steer: 'honours `mode: "steer"` on a reply',
	events: "`events`",
};
const AGENT_CAPABILITY_DOC: Record<AgentCapability, string> = {
	report: "sends reports (every session of this protocol)",
	replies: "takes replies and acks them",
	steer: 'honours `mode: "steer"` on a reply',
	usage: "fills `usage` in its reports",
	context: "fills `context` in its reports",
	"model-switch": "takes `/model` and `/thinking` replies",
	transcript: "has a transcript roost can show",
};

/** The shapes several ops share: described once, named where they are used. */
const SHARED = new Map<object, string>([
	[DispatchArgsSchema, "DispatchArgs"],
	[HelloArgsSchema, "HelloArgs"],
	[HelloResultSchema, "HelloResult"],
	[WorkerReportSchema, "WorkerReport"],
	[JobRowSchema, "JobRow"],
	[DaemonStatusSchema, "DaemonStatus"],
	[ContextInfoS, "ContextInfo"],
]);

type S = {
	type?: string;
	title?: string;
	description?: string;
	enum?: unknown[];
	const?: unknown;
	anyOf?: S[];
	items?: S;
	properties?: Record<string, S>;
	required?: string[];
	additionalProperties?: S;
	maxLength?: number;
	minLength?: number;
	"x-trim"?: true;
	"x-max"?: "cut" | "op";
};
/** A shared shape's name, also through a loose copy of it (M76). */
const sharedName = (s: S): string | undefined => SHARED.get(s) ?? SHARED.get(looseOf.get(s as unknown as Schema) ?? {});

const cell = (t: string) => t.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

function ty(s: S): string {
	const name = sharedName(s);
	if (name) return name;
	if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
	if ("const" in s) return JSON.stringify(s.const);
	if (s.anyOf) {
		const parts = s.anyOf.map((m) => ty(m));
		return [...parts.filter((p) => p !== "null"), ...parts.filter((p) => p === "null")].join(" | ");
	}
	if (s.type === "array") {
		const inner = ty(s.items!);
		return `${inner.includes(" | ") ? `(${inner})` : inner}[]`;
	}
	if (s.additionalProperties) return `Record<string, ${ty(s.additionalProperties)}>`;
	if (s.type === "object" && s.title) return s.title;
	if (s.type === "object") {
		const entries = Object.entries(s.properties ?? {});
		if (entries.length === 0) return "{}";
		const req = new Set(s.required ?? []);
		return `{ ${entries.map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${ty(v)}`).join(", ")} }`;
	}
	return s.type ?? "any";
}

function limit(s: S): string {
	for (const m of s.anyOf ?? []) if (m.maxLength !== undefined || m.minLength !== undefined) return limit(m);
	// M76: trimmed first; past the maximum cut, or refused by the op with its own code
	const trim = s["x-trim"] ? " (trimmed)" : "";
	const over =
		s["x-max"] === "cut" ? ", longer is cut" : s["x-max"] === "op" ? ", longer is refused (`too_long`)" : "";
	if (s.minLength !== undefined && s.maxLength !== undefined)
		return `${s.minLength}-${s.maxLength} chars${trim}${over}`;
	if (s.maxLength !== undefined) return `<= ${s.maxLength} chars${trim}${over}`;
	if (s.minLength !== undefined) return `>= ${s.minLength} chars${trim}`;
	return "";
}

/** A value's meaning: its own description, or its non-null member's. */
const meaning = (s: S): string => s.description ?? s.anyOf?.map((m) => m.description).find(Boolean) ?? "";

function fields(schema: S, withLimit: boolean): string[] {
	const props = Object.entries(schema.properties ?? {});
	if (props.length === 0) return ["No fields.", ""];
	const req = new Set(schema.required ?? []);
	const head = withLimit
		? ["| Field | Type | Required | Limit | |", "|---|---|---|---|---|"]
		: ["| Field | Type | Required | |", "|---|---|---|---|"];
	const rows = props.map(([k, v]) => {
		const base = `\`${k}\` | \`${cell(ty(v))}\` | ${req.has(k) ? "yes" : "no"}`;
		return withLimit ? `| ${base} | ${limit(v)} | ${cell(meaning(v))} |` : `| ${base} | ${cell(meaning(v))} |`;
	});
	return [...head, ...rows, ""];
}

const KINDS: [keyof Policy, string][] = [
	["person", "Person"],
	["session", "Session"],
	["unregistered", "Unregistered agent"],
];

/** "Callers: ..." from a row of the callers table. */
function who(key: PolicyKey): string {
	const p = POLICY[key];
	const ok: string[] = [];
	const no: string[] = [];
	for (const [k, label] of KINDS) {
		const rule = p[k];
		if (rule === "allow") ok.push(label);
		else no.push(`${label} (\`${rule.code}\`)`);
	}
	return `Callers: ${ok.join(", ") || "none"}. Refused: ${no.join(", ") || "none"}.`;
}

function opSection(op: string): string[] {
	const a = ArgSchemas[op as keyof typeof ArgSchemas] as unknown as S;
	const r = ResultSchemas[op as keyof typeof ResultSchemas] as unknown as S;
	const out: string[] = [`### \`${op}\``, ""];
	if (a.description) out.push(a.description, "");
	out.push(who(op as PolicyKey), "", "Args:", "");
	out.push(...(sharedName(a) ? [`\`${sharedName(a)}\` (see shared shapes).`, ""] : fields(a, true)));
	out.push("Result:", "");
	out.push(...(sharedName(r) ? [`\`${sharedName(r)}\` (see shared shapes).`, ""] : fields(r, false)));
	return out;
}

export function renderOpReference(): string {
	const out: string[] = [];
	out.push(
		"Generated from `src/lib/protocol-schema.ts`, `src/lib/callers.ts` and `src/lib/protocol.ts` by `npm run docs:protocol`; do not edit between the markers.",
		"",
	);
	out.push(
		`Protocol version ${PROTOCOL_VERSION}. Types: \`string\`, \`number\`, \`integer\`, \`boolean\`, \`null\`, \`T[]\`, \`Record<string, T>\`, \`{ field?: T }\` (\`?\`: optional), a quoted value. A type named after another module's interface (\`RoostEvent\`, \`UsageInfo\`) is described there. A limit is what the daemon does with the value today: some are refused (\`bad_request\`, \`too_long\`), some cut.`,
		"",
	);
	out.push("### Capabilities", "");
	out.push("Daemon (`hello` answers with these, in this order):", "", "| Capability | |", "|---|---|");
	for (const c of DAEMON_CAPABILITIES) out.push(`| \`${c}\` | ${cell(DAEMON_CAPABILITY_DOC[c])} |`);
	out.push("", "Session (named in its `hello`):", "", "| Capability | The session ... |", "|---|---|");
	for (const c of AGENT_CAPABILITIES) out.push(`| \`${c}\` | ${cell(AGENT_CAPABILITY_DOC[c])} |`);
	out.push("");
	out.push("### Shared shapes", "");
	for (const [schema, name] of SHARED) {
		const s = schema as S;
		out.push(`#### \`${name}\``, "");
		if (s.description) out.push(s.description, "");
		out.push(...fields(s, true));
	}
	out.push("### Ops", "");
	for (const op of OPS) out.push(...opSection(op));
	return out.join("\n").replace(/\n+$/, "\n");
}

export function spliceDoc(doc: string, section: string): string {
	const a = doc.indexOf(START);
	const b = doc.indexOf(END);
	if (a < 0 || b < a) throw new Error(`docs/protocol.md has no ${START} ... ${END} markers`);
	return `${doc.slice(0, a + START.length)}\n\n${section}\n${doc.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const doc = readFileSync(DOC_PATH, "utf8");
	const next = spliceDoc(doc, renderOpReference());
	if (next !== doc) writeFileSync(DOC_PATH, next);
	console.log(next === doc ? "docs/protocol.md is up to date" : "docs/protocol.md updated");
}
