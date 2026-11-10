// The `Agent` tool (spec 7): discovery -> resolve -> concurrency slot -> run.

import { type Static, Type } from "typebox";
import { type JsonValue, StringEnum } from "xpi-ai";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { scripts } from "./background.ts";
import type { Config } from "./config.ts";
import { type AgentDefinition, EFFORTS, inertNotice } from "./definition.ts";
import { type Discovery, discoverAgents } from "./discovery.ts";
import { exchange } from "./exchange.ts";
import { checkForkCall, FORK_DEFINITION, FORK_DESCRIPTION, FORK_TYPE, resolveAgent, seedForkSession } from "./fork.ts";
import { AGENT_NAME, registry } from "./registry.ts";
import type { CallInput, ChildSpec, ParentContext } from "./resolve.ts";
import { emptyUsage, STATUSES, type Status, usageSchema } from "./runner.ts";
import { runs } from "./runs.ts";
import { agentPhase, countScriptAgent } from "./script-helpers.ts";
import { capText, newAgentId, storedAgent } from "./sessions.ts";
import { checkSchema } from "./structured-output.ts";
import {
	listLines,
	memoryRoot as memoryRootFor,
	planWorktree,
	type WorktreeOutcome,
	type WorktreeRef,
	worktreeSubdir,
} from "./worktree.ts";

const DEFAULT_AGENT = "general-purpose";

const parameters = Type.Object({
	description: Type.String({ description: "Short (3-5 word) label for the task, shown in progress" }),
	prompt: Type.String({ description: "The full task for the agent. It sees nothing else from this session." }),
	subagent_type: Type.Optional(Type.String({ description: `Agent to run. Default "${DEFAULT_AGENT}".` })),
	model: Type.Optional(
		Type.String({
			description:
				'Model override: "opus", "sonnet", "haiku", "fable", "inherit" (the parent\'s model) or a pi model pattern. Default: the agent\'s model, else haiku.',
		}),
	),
	effort: Type.Optional(StringEnum(EFFORTS, { description: "Thinking level override" })),
	resume: Type.Optional(
		Type.String({
			description:
				"agentId from an earlier result, or the agent's name, to continue that agent's session. subagent_type may be omitted.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				'true: return at once with status "running"; the agent\'s result arrives later as a message. false: wait for the agent and keep this script in the foreground. Omitted: wait for the agent, and the script moves to the background.',
		}),
	),
	isolation: Type.Optional(
		Type.String({
			description:
				'"worktree": run the agent in its own git worktree on its own branch. Unchanged, it is removed when the run ends; with changes it is kept and the result names its path, branch, changed files and commits. Default: the agent file\'s isolation, else none.',
		}),
	),
	schema: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				'JSON Schema (type "object" at the top) for the result. The agent returns a value matching it: the result\'s `structured` holds the value and `output` its JSON text. After 5 invalid attempts, or when the agent ends without one, the status is "failed".',
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"A name for the agent (letters, digits, _ and -), unique in this session. Use it as `resume` and as `to` in SendMessage.",
		}),
	),
});
export type AgentInput = Static<typeof parameters>;

export const outputSchema = Type.Object({
	status: StringEnum([...STATUSES, "running"] as const),
	agentId: Type.String({ description: "Pass as `resume` to continue this agent" }),
	agentType: Type.String(),
	output: Type.String({
		description: "Text of the agent's last message; with `schema`, the JSON text of `structured`",
	}),
	structured: Type.Optional(Type.Unknown({ description: "With `schema`: the agent's result, matching the schema" })),
	model: Type.String(),
	usage: usageSchema,
	turns: Type.Number(),
	durationMs: Type.Number(),
	warnings: Type.Array(Type.String()),
	error: Type.Optional(Type.String()),
	worktree: Type.Optional(
		Type.Object(
			{
				changed: Type.Boolean({
					description: "false: nothing was changed and the worktree and its branch were removed",
				}),
				path: Type.Optional(Type.String()),
				branch: Type.Optional(Type.String()),
				files: Type.Optional(
					Type.Array(Type.String(), { description: "changed files (uncommitted, untracked and committed)" }),
				),
				commits: Type.Optional(
					Type.Array(Type.String(), {
						description: 'commits made since the worktree was created, "<hash> <subject>"',
					}),
				),
				note: Type.Optional(
					Type.String({
						description:
							"why the worktree was kept although nothing changed in its files, or where work may be outside its branch (detached HEAD, another branch, a stash)",
					}),
				),
			},
			{ description: 'Only for isolation "worktree"' },
		),
	),
});
export type AgentResult = Omit<Static<typeof outputSchema>, "status"> & { status: Status | "running" };

const BACKGROUND_RULES = [
	"Background rules. By default the first Agent call in a codemode script moves the whole script to the background: the",
	"codemode call returns to you at once, the script keeps running, and its return value arrives later as a message (do",
	"not wait or poll; end your turn or do other work). `run_in_background: false` keeps the script in the foreground:",
	"you wait and the codemode call returns the script's own result. `run_in_background: true` makes this call return",
	'at once with status "running" and the agentId (output is empty); the agent finishes on its own and you get its',
	"output, status and cost as a message. It does not move the script to the background.",
];

// subagent.backgroundScripts: false: scripts always wait; only an explicit `true` detaches an agent.
const DETACHED_RULES = [
	'Scripts wait for their agents. `run_in_background: true` makes a call return at once with status "running" and the',
	"agentId (output is empty); the agent finishes on its own and you get its output, status and cost as a message.",
];

// Print mode (no UI): pi exits when the turn ends, so nothing runs in the background and the model is not told of it.
const PRINT_RULES = ["Every call waits for its agent and returns its result."];

export function describeAgents(
	{ agents }: Discovery,
	backgroundScripts: boolean,
	hasUI: boolean,
	fork = false, // list the fork type (a saved session and subagent.fork)
): string {
	const list = [
		...[...agents.values()].map((a) => `- ${a.name}: ${a.description}`),
		...(fork ? [`- ${FORK_TYPE}: ${FORK_DESCRIPTION}`] : []),
	].join("\n");
	return [
		"Run a subagent: a separate pi session with its own system prompt, tools and model. It sees only `prompt`, so",
		"write a complete task. The result's `output` is the agent's final message; filter it before returning it.",
		"Run independent agents in parallel with Promise.all.",
		'Pass `schema` (a JSON Schema with type "object") to get the result as a value in `structured` instead of prose.',
		"Pass `name` to reach the agent later by that name: `resume: name`, or SendMessage({ to: name, message }).",
		"Script helpers over this tool: `agent(prompt, { label?, schema?, type?, model?, effort?, isolation? })` resolves to",
		"the output text (with `schema`, the value), or to null when the agent failed or was stopped; `parallel([fn or promise...])` and",
		"`pipeline(items, (item, i) => ...)` run all at once and resolve to results in order, null for a failed one;",
		"`phase(title, fn?)` names the agents started from there for the panel; `log(text)` shows a progress line.",
		"",
		...(!hasUI ? PRINT_RULES : backgroundScripts ? BACKGROUND_RULES : DETACHED_RULES),
		"",
		"Available agents (subagent_type):",
		list,
	].join("\n");
}

export function parentContext(ctx: ExtensionContext): ParentContext {
	return {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: ctx.thinkingLevel ?? "off",
		cwd: ctx.cwd,
		trusted: ctx.isProjectTrusted(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionId: ctx.sessionManager.getSessionId(),
	};
}

const SHOWN = 20; // files and commits listed in the text main reads; the structured result has them all

// The lines telling main where a kept worktree is. Nothing for a removed one.
export function worktreeLines(w: WorktreeOutcome | undefined): string[] {
	if (!w?.changed) return [];
	return [
		`Worktree kept: ${w.path} (branch ${w.branch})`,
		...(w.note ? [`Note: ${w.note}`] : []),
		...(w.files.length > 0 ? ["Changed files:", ...listLines(w.files, SHOWN)] : []),
		...(w.commits.length > 0 ? ["Commits:", ...listLines(w.commits, SHOWN)] : []),
	];
}

function summary(r: AgentResult): string {
	const head = `${r.agentType} ${r.status} (agentId ${r.agentId}, ${r.turns} turns, ${(r.durationMs / 1000).toFixed(1)}s)`;
	const lines = [head, ...r.warnings.map((w) => `warning: ${w}`)];
	if (r.error) lines.push(`error: ${r.error}`);
	lines.push(...worktreeLines(r.worktree as WorktreeOutcome | undefined));
	return [...lines, "", r.output].join("\n");
}

async function executeAgent(
	input: AgentInput,
	signal: AbortSignal | undefined,
	onUpdate: ((text: string) => void) | undefined,
	config: Config,
	parent: ParentContext,
	toolCallId: string,
	started?: (spec: ChildSpec) => void, // called once the spec is resolved, before the agent is queued
): Promise<AgentResult> {
	if (input.isolation !== undefined && input.isolation !== "worktree") {
		throw new Error(`invalid isolation "${input.isolation}": only "worktree" is supported`);
	}
	if (input.schema !== undefined) checkSchema(input.schema);
	if (input.name !== undefined && !AGENT_NAME.test(input.name)) {
		throw new Error(`invalid name "${input.name}": use 1 to 64 letters, digits, "_" or "-"`);
	}
	let agentType = input.subagent_type;
	let stored: ReturnType<typeof storedAgent> | undefined;
	if (input.resume !== undefined) {
		// An id or a name. An unknown one goes on as it is: storedAgent says what is wrong with it.
		const known = registry.find(parent.sessionId, input.resume);
		if (known !== undefined) input = { ...input, resume: known };
		const had = known === undefined ? undefined : registry.get(known)?.name;
		if (input.name !== undefined && known !== undefined && input.name !== had) {
			throw new Error(
				had === undefined
					? `agent "${known}" has no name: a name is given when an agent starts`
					: `agent "${known}" is named "${had}", not "${input.name}"`,
			);
		}
		stored = storedAgent(parent, input.resume!);
		if (agentType !== undefined && agentType !== stored.agentType) {
			throw new Error(
				`agent "${input.resume}" is a "${stored.agentType}" agent; resume it with that subagent_type or none`,
			);
		}
		agentType = stored.agentType;
	}
	agentType ??= DEFAULT_AGENT;
	const { agents } = discoverAgents(parent.cwd);
	if (agentType === FORK_TYPE) checkForkCall(input as CallInput, config, parent);
	const def = agentType === FORK_TYPE ? FORK_DEFINITION : agents.get(agentType);
	if (!def) {
		const known = [...agents.keys(), ...(config.fork ? [FORK_TYPE] : [])];
		throw new Error(`unknown subagent_type "${agentType}". Available: ${known.join(", ")}`);
	}

	// Isolation: a resume uses the stored worktree (or none) whatever is asked now; a new agent, the call's value else the file's.
	const agentId = input.resume ?? newAgentId();
	if (input.name !== undefined && !stored) {
		// In a relaunch, a call that runs again takes over the name its agent of the earlier run holds.
		const owner = registry.named(parent.sessionId, input.name);
		if (owner !== undefined && runs.isEarlierAgent(toolCallId, owner)) registry.dropName(owner);
	}
	const release =
		input.name !== undefined && !stored ? registry.claim(parent.sessionId, input.name, agentId) : undefined;
	try {
		return await startAgent(input, signal, onUpdate, config, parent, toolCallId, started, {
			agentId,
			agentType,
			def,
			stored,
		});
	} finally {
		release?.(); // a no-op once the agent is in the registry
	}
}

// The rest of an Agent call, once its id (and name) are settled.
async function startAgent(
	input: AgentInput,
	signal: AbortSignal | undefined,
	onUpdate: ((text: string) => void) | undefined,
	config: Config,
	parent: ParentContext,
	toolCallId: string,
	started: ((spec: ChildSpec) => void) | undefined,
	{
		agentId,
		agentType,
		def,
		stored,
	}: {
		agentId: string;
		agentType: string;
		def: AgentDefinition;
		stored: ReturnType<typeof storedAgent> | undefined;
	},
): Promise<AgentResult> {
	let worktree: WorktreeRef | undefined;
	if (stored) worktree = stored.worktree;
	let worktreeWarning: string | undefined;
	if (!stored && (input.isolation ?? def.isolation) === "worktree") {
		worktree = await planWorktree(parent.cwd, agentId);
		const { subdir, warning } = await worktreeSubdir(worktree, parent.cwd);
		if (subdir !== "") worktree.subdir = subdir;
		worktreeWarning = warning;
	}

	// Memory: project and local live under the main checkout (never the agent's worktree); outside a repo, the parent's cwd.
	const memoryRoot = await memoryRootFor(def.memory, def.name, parent.cwd);

	const spec = resolveAgent(def, input as CallInput, config, parent, { agentId, worktree, memoryRoot });
	// A new fork starts from main's conversation as it is now, before anything else is said in it.
	if (agentType === FORK_TYPE && !stored) seedForkSession(parent, agentId, spec.cwd);
	scripts.addAgent(toolCallId, spec.agentId, agentPhase.getStore());
	if (worktreeWarning) spec.warnings.push(worktreeWarning);
	if (stored && input.isolation !== undefined) {
		spec.warnings.push(
			`"isolation" was ignored on a resume: the agent keeps how it was started (${worktree ? "in a worktree" : "without isolation"})`,
		);
	}
	for (const field of def.inert) spec.warnings.push(inertNotice(field));
	started?.(spec);

	let last = "";
	const { aborted: _aborted, ...run } = await exchange(
		parent,
		spec,
		{
			type: agentType,
			...(input.name !== undefined && !stored ? { name: input.name } : {}),
			description: input.description,
			color: def.color,
		},
		signal,
		(p) => {
			const text = `${input.description}: turn ${p.turns}${p.lastTool ? `, ${p.lastTool}` : ""}`;
			if (text !== last) onUpdate?.(text); // a turn's end repeats the update from its last tool start
			last = text;
		},
	);

	return { agentId: spec.agentId, agentType, model: spec.model, warnings: spec.warnings, ...run };
}

// What main gets when a `run_in_background: true` agent ends.
export function agentEndMessage(
	parent: ParentContext,
	agentId: string,
	agentType: string,
	r?: AgentResult,
	error?: string,
): string {
	const cut = capText(r?.output ?? "", parent, `${agentId}-output`);
	const err = r?.error ?? error;
	return [
		`Background agent ${agentId} ${agentType} ${r?.status ?? "stopped"} ($${(r?.usage.cost.total ?? 0).toFixed(4)}).`,
		...(err ? [`Error: ${err}`] : []),
		...worktreeLines(r?.worktree as WorktreeOutcome | undefined),
		`Output:\n${cut}`,
	].join("\n");
}

// Whether the agent this call runs (a resume: the one it continues) has `background: true` in its file.
function runsInBackground(params: AgentInput, parent: ParentContext): boolean {
	const resumed = params.resume === undefined ? undefined : registry.find(parent.sessionId, params.resume);
	const type = params.subagent_type ?? (resumed && registry.get(resumed)?.type) ?? DEFAULT_AGENT;
	return discoverAgents(parent.cwd).agents.get(type)?.background === true;
}

export function agentTool(getConfig: () => Config, description: string, deliver: (content: string) => void) {
	const tool = {
		name: "Agent",
		label: "Agent",
		exposure: "codemode" as const,
		description,
		parameters,
		outputSchema,
		async execute(
			toolCallId: string,
			params: AgentInput,
			signal: AbortSignal | undefined,
			onUpdate:
				| ((r: { content: { type: "text"; text: string }[]; details: AgentResult | undefined }) => void)
				| undefined,
			ctx: ExtensionContext,
		) {
			const parent = parentContext(ctx);
			// An agent file's `background: true` stands in for an omitted run_in_background; the call's own value wins.
			if (params.run_in_background === undefined && runsInBackground(params, parent)) {
				params = { ...params, run_in_background: true };
			}
			scripts.agentStarting(toolCallId, params.run_in_background); // the first plain Agent call moves its script to the background
			countScriptAgent(toolCallId, getConfig().maxAgentsPerScript);
			if (params.run_in_background === true && ctx.hasUI) {
				// The agent runs on its own, not tied to this call's signal; main hears of its end by message.
				let run!: Promise<AgentResult>;
				const spec = await new Promise<ChildSpec>((resolve, reject) => {
					// Its own signal, kept in the registry so a stop reaches it while it waits for a slot.
					const controller = new AbortController();
					run = executeAgent(params, controller.signal, undefined, getConfig(), parent, toolCallId, (spec) => {
						registry.detach(spec.agentId, parent.sessionId, controller);
						resolve(spec);
					});
					run.then(() => {}, reject); // it failed before starting (unknown agent, bad resume, no repository...): throws here
				});
				const { agentId, model, warnings } = spec;
				const agentType = params.subagent_type ?? DEFAULT_AGENT;
				const send = (content: string) => {
					registry.forget(agentId);
					try {
						deliver(content);
					} catch (err) {
						console.error(`subagent: could not deliver the end of agent ${agentId}: ${(err as Error).message}`); // never crash pi
					}
				};
				run.then(
					(r) => send(agentEndMessage(parent, agentId, r.agentType, r)),
					(e: Error) => send(agentEndMessage(parent, agentId, agentType, undefined, e.message)),
				);
				const result: AgentResult = {
					status: "running",
					agentId,
					agentType,
					model,
					output: "",
					usage: emptyUsage(),
					turns: 0,
					durationMs: 0,
					warnings,
				};
				return {
					content: [{ type: "text" as const, text: summary(result) }],
					details: result as AgentResult | undefined,
					structuredContent: result as unknown as JsonValue,
					usage: result.usage,
					isError: false,
				};
			}
			const result = await executeAgent(
				params,
				signal,
				(text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
				getConfig(),
				parent,
				toolCallId,
			);
			return {
				content: [{ type: "text" as const, text: summary(result) }],
				details: result as AgentResult | undefined,
				structuredContent: result as unknown as JsonValue,
				usage: result.usage,
				isError: result.status === "failed",
			};
		},
	};
	// Around every call: a workflow run records it (runs.ts), a relaunch answers it from the earlier run's saved
	// results when it can, and a paused script holds it before anything starts.
	const start = tool.execute;
	tool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
		const recorded = runs.call(toolCallId, params as Record<string, unknown>);
		if (recorded.saved) {
			scripts.addSaved(toolCallId);
			const result: AgentResult = {
				...recorded.saved,
				warnings: [...recorded.saved.warnings, `answered from the saved results of run ${recorded.from}`],
			};
			return {
				content: [{ type: "text" as const, text: summary(result) }],
				details: result as AgentResult | undefined,
				structuredContent: result as unknown as JsonValue,
				usage: emptyUsage(), // nothing ran: the earlier run paid for it
				isError: false,
			};
		}
		try {
			await scripts.gate(toolCallId, signal);
			const outcome = await start(toolCallId, params, signal, onUpdate, ctx);
			recorded.done?.({ result: outcome.details });
			return outcome;
		} catch (err) {
			recorded.done?.({ error: (err as Error).message });
			throw err;
		}
	};
	return tool;
}
