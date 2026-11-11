// M75: the protocol's ops, once. A schema (schema.ts) per op's arguments and result is the
// source of the TypeScript types (protocol.ts re-exports them), of the op reference in
// docs/protocol.md (npm run docs:protocol), and of the daemon's entry check (M76, M77:
// every op; a field marked loose is not checked, a `message` is the words the daemon said
// before).
import type { RoostEvent } from "./events.ts";
import {
	arr as arrS,
	bool as boolS,
	check,
	type Infer,
	literal,
	loose,
	nullable as nullableS,
	num as numS,
	obj as objS,
	oneOf as oneOfS,
	opaque,
	optional,
	rec,
	relax,
	type Schema,
	str as strS,
} from "./schema.ts";
import type { UsageInfo } from "./usage.ts";

// -- helpers ------------------------------------------------------------------------------

type Opts = { description?: string };
const d = (description?: string) => (description ? { description } : {});
const str = (description?: string, o: { maxLength?: number; minLength?: number; pattern?: string } = {}) =>
	strS({ ...d(description), min: o.minLength, max: o.maxLength, pattern: o.pattern });
const num = (description?: string) => numS(d(description));
const int = (description?: string, o: { min?: number } = {}) => numS({ ...d(description), int: true, min: o.min });
const bool = (description?: string) => boolS(d(description));
const nullable = <T extends Schema>(t: T, description?: string) => nullableS(t, d(description));
/** A string that is one of these (the doc lists the values). */
const oneOf = <const T extends string>(values: readonly T[], description?: string) => oneOfS(values, d(description));
const lit = literal;
const arr = <T extends Schema>(t: T, description?: string) => arrS(t, d(description));
const obj = <P extends Parameters<typeof objS>[0]>(properties: P, o: Opts = {}) => objS(properties, o);
const opt = optional;
/** M76: a non-empty string; refused with these words. */
const need = (message: string, description?: string) => strS({ ...d(description), min: 1, message });
/** M76: a string with something in it once trimmed; refused with these words. */
const filled = (message: string, description?: string, o: { max?: number; maxBy?: "cut" | "op" } = {}) =>
	strS({ ...d(description), min: 1, trim: true, message, ...o });
/** A type another module owns (its interface stays there); the doc names it. */
const domain = <T>(title: string, description: string) => opaque<T>(title, description);

// -- shared values ------------------------------------------------------------------------

export const JOB_STATES = ["working", "blocked", "done", "failed", "stopped"] as const;
const JobStateNameS = oneOf(JOB_STATES);
const JobStatusS = nullable(oneOf(["busy", "waiting", "idle"]));
const WaitingForS = nullable(oneOf(["dialog", "question", "first-prompt"]));
const DispatchOriginS = oneOf(["bg", "dispatch", "adopt", "fork"]);
export type JobStateName = Infer<typeof JobStateNameS>;
export type JobStatus = Infer<typeof JobStatusS>;
export type WaitingFor = Infer<typeof WaitingForS>;
export type DispatchOrigin = Infer<typeof DispatchOriginS>;
export const REPLY_MODES = ["steer", "followUp"] as const;
/** M28: "steer" joins the work under way, after its current tool calls; "followUp" waits until it is done. */
const ReplyModeS = oneOf(
	REPLY_MODES,
	`"steer" joins the work under way, after its current tool calls; "followUp" waits until it is done`,
);
export type ReplyMode = Infer<typeof ReplyModeS>;

export const ContextInfoS = obj(
	{
		tokens: nullable(num(), "Estimated tokens in context; null right after a compaction, until the next reply."),
		window: num(),
		percent: nullable(num(), "0-100; null when tokens is unknown."),
	},
	{ description: "M8: how full the session's context window is (xpi's ctx.getContextUsage())." },
);
export type ContextInfo = Infer<typeof ContextInfoS>;

const UsageInfoS = domain<UsageInfo>("UsageInfo", "M24: what a session spent (usage.ts).");

export const JobRowSchema = obj({
	id: str(),
	cwd: str(),
	kind: oneOf(["pi", "shell"]),
	startedAt: num(),
	state: JobStateNameS,
	pid: nullable(num()),
	status: JobStatusS,
	waitingFor: WaitingForS,
	sessionFile: str(),
	name: str(),
	endedAt: nullable(num()),
	summary: nullable(str(), "Row text: a status sentence while working, the result or question after."),
	question: nullable(str()),
	choices: arr(str()),
	model: nullable(str()),
	thinking: nullable(str(), "M8: the worker's thinking level (or the one it was started with)."),
	context: nullable(
		ContextInfoS,
		"M8: context window use as last reported; null for shell jobs and before the first report.",
	),
	usage: opt(
		nullable(
			UsageInfoS,
			"M24: what the session spent, as last reported (absent before it reports, or from older workers).",
		),
	),
	error: nullable(str()),
	stateSince: num('When the job entered its current state (for "waiting 3m").'),
	reaped: bool("DM-4: stopped for idleness; attaching or replying starts it again."),
	pinned: bool("AV-K7: listed first and never reaped."),
	order: nullable(num(), "AV-K13: the user's position within its group, or null when never moved."),
	orderKey: nullable(str(), "The section the order belongs to (a state group or `dir:<cwd>`); stale elsewhere."),
	capabilities: opt(arr(str(), "M31: what its agent said it can do in its hello (absent: it never said).")),
	task: opt(nullable(str(), "M48: the task it was started on (one line, at most 200 characters).")),
	queued: opt(num("M48: user replies waiting for it.")),
});
export type JobRow = Infer<typeof JobRowSchema>;

export const WorkerReportSchema = obj(
	{
		state: oneOf(["working", "blocked", "done", "failed"]),
		status: oneOf(["busy", "waiting", "idle"]),
		waitingFor: WaitingForS,
		summary: nullable(str()),
		question: nullable(str()),
		choices: arr(str()),
		tool: nullable(str()),
		error: nullable(str()),
		name: nullable(str()),
		model: nullable(str()),
		thinking: opt(nullable(str(), "M8; absent from workers before 0.1.5.")),
		context: opt(nullable(ContextInfoS)),
		usage: opt(nullable(UsageInfoS, "M24: absent from workers before 0.1.11.")),
		attachSignal: opt(bool("The worker reacts to the host's SIGUSR2 attach signal (AT-5).")),
	},
	{ description: "What a worker reports about itself (full snapshot every time)." },
);
export type WorkerReport = Infer<typeof WorkerReportSchema>;

export const DispatchArgsSchema = obj(
	{
		kind: opt(oneOf(["pi", "shell"], 'DI-6: "shell" runs `command` without xpi (no session file).')),
		cwd: str(),
		sessionFile: str(),
		command: arr(str()),
		env: rec(str()),
		name: str(),
		model: opt(str()),
		thinking: opt(str()),
		workspaceEnv: opt(
			oneOf(
				["shell", "direnv", "off"],
				"M20: how the worker's environment follows its workspace (absent: as carried).",
			),
		),
		envDeny: opt(arr(str(), "M20: names (or `PREFIX*`) a workspace's environment may not set.")),
		envForce: opt(arr(str(), "M20: names that pass envDeny (envAllowList).")),
		origin: DispatchOriginS,
		piVersion: opt(str()),
		requestId: opt(
			strS({
				description:
					"M36: a resend with the same id returns the job the first one made (one not of this form is refused).",
				pattern: "^[A-Za-z0-9_.:-]{1,64}$",
				message: "requestId: 1-64 of A-Z a-z 0-9 _ . : -",
			}),
		),
	},
	{ description: "A session to start." },
);
export type DispatchArgs = Infer<typeof DispatchArgsSchema>;

export const DaemonStatusSchema = obj({
	pid: num(),
	version: str(),
	socketDir: str(),
	liveJobs: num(),
	totalJobs: num(),
	ptyError: nullable(str()),
	startedAt: num(),
});
export type DaemonStatus = Infer<typeof DaemonStatusSchema>;

export const HelloArgsSchema = obj(
	{
		protocol: numS({
			description: "The highest protocol version the agent speaks.",
			int: true,
			min: 1,
			message: "protocol must be a version number",
		}),
		agent: opt(loose(obj({ name: str(), version: opt(str()) }))),
		capabilities: opt(
			loose(
				arr(
					str(),
					"What the agent can do (AGENT_CAPABILITIES); unknown ones are ignored (and what is not a string).",
				),
			),
		),
	},
	{ description: "M31: an agent says which protocol and capabilities it has, before it reports." },
);
export type HelloArgs = Infer<typeof HelloArgsSchema>;

export const HelloResultSchema = obj({
	protocol: int(),
	daemon: obj({ name: lit("roost"), version: str() }),
	capabilities: arr(
		str(),
		"What the daemon offers agents (the ops beyond report, ack and hello): DAEMON_CAPABILITIES.",
	),
});
export type HelloResult = Infer<typeof HelloResultSchema>;

// -- the ops ------------------------------------------------------------------------------

const Empty = obj({});

/** Every op's arguments. */
export const ArgSchemas = {
	ping: Empty,
	hello: HelloArgsSchema,
	list: obj({ all: opt(loose(bool())), cwd: opt(loose(str())) }),
	// M77: a resend with the same requestId returns the first job before anything else is read, so
	// only the id's form (and that there are arguments) is checked here; the rest in dispatch()
	dispatch: relax(
		DispatchArgsSchema,
		{ requestId: DispatchArgsSchema.properties!.requestId! },
		{ message: "missing args" },
	),
	stop: obj({ id: need("id required") }),
	rm: obj({ id: need("id required") }),
	resolve: obj({ query: need("query required") }),
	status: Empty,
	shutdown: obj({ keepWorkers: opt(loose(bool())) }),
	subscribe: Empty,
	// M76: loose: id and token are checked against the job first (not_found, unauthorized), and a
	// report for a job that ended is taken whatever it says
	report: obj({ id: loose(str()), token: loose(str()), report: loose(WorkerReportSchema) }),
	reply: obj(
		{
			id: need("id required"),
			text: filled("empty reply"),
			mode: opt(loose(ReplyModeS)),
			requestId: opt(
				strS({
					description: "M36: makes a resend safe: the same id is taken once (the first answer is given again).",
					pattern: "^[A-Za-z0-9_.:-]{1,64}$",
					message: "requestId: 1-64 of A-Z a-z 0-9 _ . : -",
				}),
			),
		},
		{
			description:
				"M28: a reply to a working session steers into its current work (xpi's Enter) or waits for it to finish (Alt+Enter); absent: waits.",
		},
	),
	ack: obj(
		{ id: loose(str()), token: loose(str()), seq: loose(int()) },
		{ description: "Worker to daemon: the replies up to this seq were handed to the session." },
	),
	respawn: obj(
		{
			id: opt(loose(str("Required unless `all`."))),
			all: opt(loose(bool())),
			restart: opt(loose(bool())),
			prompt: opt(loose(str())),
		},
		{ description: "Start an ended job again from its session file; `restart` also restarts a live one." },
	),
	pin: obj({ id: need("id required"), pinned: loose(bool()) }),
	rename: obj({ id: need("id required"), name: filled("empty name", "Spaces folded; cut at 200 characters.") }),
	reorder: obj(
		{ ids: arrS(need("ids must be job ids"), { message: "ids must be job ids" }), key: need("key required") },
		{ description: "AV-K13: these jobs, in this order (the rest of their group keeps its place)." },
	),
	events: obj(
		{
			after: opt(numS({ message: "after must be a number" })),
			limit: opt(numS({ message: "limit must be a number" })),
			id: opt(need("id must be a job id")),
		},
		{ description: "M43: the event feed (what happened), with a cursor: `after` the seq last seen." },
	),
};

const NameId = obj({ id: str(), name: str() });

/** Every op's result. */
export const ResultSchemas = {
	ping: obj({ pid: num(), version: str() }),
	hello: HelloResultSchema,
	list: obj({ jobs: arr(JobRowSchema) }),
	dispatch: NameId,
	stop: obj({ id: str() }),
	rm: obj({ id: str() }),
	resolve: obj({ id: str() }),
	status: DaemonStatusSchema,
	shutdown: Empty,
	subscribe: Empty,
	report: Empty,
	reply: obj({
		delivered: bool("handed to the live worker"),
		saved: bool("kept for its next start (PK-5)"),
		stopped: opt(bool()),
		respawned: opt(bool()),
		error: opt(str()),
		duplicate: opt(bool()),
	}),
	ack: Empty,
	respawn: obj({ results: arr(obj({ id: str(), started: bool(), error: opt(str()) })) }),
	pin: obj({ id: str(), pinned: bool() }),
	rename: obj({ id: str(), name: str() }),
	reorder: Empty,
	events: obj({ events: arr(domain<RoostEvent>("RoostEvent", "An event of the feed (events.ts).")), cursor: num() }),
};

export type OpArgs = { [O in keyof typeof ArgSchemas]: Infer<(typeof ArgSchemas)[O]> };
export type OpResults = { [O in keyof typeof ResultSchemas]: Infer<(typeof ResultSchemas)[O]> };
/** The names of the ops, in the order of the schemas. */
export const OPS = Object.keys(ArgSchemas) as (keyof typeof ArgSchemas)[];

/** M76, M77: the ops whose arguments the daemon checks at its entry: all of them. Each field is loose or carries the words its hand check said. */
export const ENTRY_CHECKED: ReadonlySet<string> = new Set<string>(OPS);

/** M76: what is wrong with an op's arguments (the daemon's words), or undefined. Arguments that are not an object count as none. */
export function argsProblem(op: string, args: unknown): string | undefined {
	if (!ENTRY_CHECKED.has(op)) return undefined;
	const schema = ArgSchemas[op as keyof typeof ArgSchemas] as Schema;
	// no arguments at all: the op's words for that, if it has any (dispatch: "missing args"); an array was read as one with no fields
	if (typeof args !== "object" || args === null) {
		if (schema.message && !schema["x-loose"]) return schema.message;
		args = {};
	}
	const value = Array.isArray(args) ? {} : args;
	const r = check(schema, value);
	return r.ok ? undefined : r.message;
}
