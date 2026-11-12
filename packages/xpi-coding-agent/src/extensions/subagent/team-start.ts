// Agent teams: starting a teammate with a named `Agent` call (spec .scratch/agent-teams/01-agent-teams.md, "The team").
// With teams on, a call with `name` (not a fork, without `isolation`) starts a teammate, or continues a former one of
// this session by its name. It returns at once; the teammate's answers reach the lead as idle notices.

import type { JsonValue } from "xpi-ai";
import type { AgentInput, AgentResult } from "./agent-tool.ts";
import type { Config } from "./config.ts";
import { slotFree } from "./exchange.ts";
import { FORK_TYPE } from "./fork.ts";
import { registry, type SubagentRecord } from "./registry.ts";
import type { ChildSpec, ParentContext, TeamLaunch } from "./resolve.ts";
import { emptyUsage } from "./runner.ts";
import { runs } from "./runs.ts";
import { teams } from "./team.ts";
import { LEAD, teamLabel } from "./team-text.ts";
import { workflowOf } from "./workflow-run.ts";

const teammateNameError = (name: string, status: string): Error =>
	new Error(
		status === "stopped"
			? `"${name}" is a teammate of this team that has stopped; it cannot be started again, choose another name`
			: `"${name}" is a teammate of this team: message it with SendMessage`,
	);

export type TeamCall = { kind: "new" } | { kind: "former"; record: SubagentRecord };

// Whether this call is run by a workflow or a workflow's script (the codemode call id is the script's, the nested ids
// "<id>/<n>" hang off it).
const fromWorkflow = (toolCallId: string): boolean =>
	runs.of(toolCallId) !== undefined || workflowOf(toolCallId.split("/")[0]!) !== undefined;

// What the call is with teams on: a teammate (new, or a former one continued), or undefined for an ordinary subagent call.
// Throws, saying why, for a named call a team refuses.
export function classifyTeamCall(params: AgentInput, parent: ParentContext, toolCallId: string): TeamCall | undefined {
	if (!teams.on) return undefined;
	if (params.name === LEAD) throw new Error(`"${LEAD}" is reserved for the session itself: choose another name`);
	if (params.subagent_type === FORK_TYPE || params.isolation !== undefined) return undefined;
	let record: SubagentRecord | undefined;
	// A name a member of the team has, whether or not its record exists yet (it is added once its agent is resolved).
	const mate = teams.current()?.member(params.resume ?? params.name ?? "");
	if (mate) throw teammateNameError(mate.name, mate.status);
	if (params.resume !== undefined) {
		const known = registry.find(parent.sessionId, params.resume);
		record = known === undefined ? undefined : registry.get(known);
		if (!record?.teammate) return undefined;
	} else {
		if (params.name === undefined) return undefined;
		const known = registry.named(parent.sessionId, params.name);
		record = known === undefined ? undefined : registry.get(known);
		if (record && !record.teammate) return undefined; // another subagent has the name: the ordinary call says so
	}
	const team = teams.current();
	if (record?.name !== undefined && team?.member(record.name)) {
		throw teammateNameError(record.name, team.member(record.name)!.status);
	}
	if (params.schema !== undefined)
		throw new Error(
			"a teammate cannot return structured output: `schema` is not accepted on a named call while agent teams are on",
		);
	if (params.run_in_background === false) {
		throw new Error(
			"a teammate always runs in the background: `run_in_background: false` is not accepted on a named call while agent teams are on",
		);
	}
	if (fromWorkflow(toolCallId)) {
		throw new Error(
			"a workflow cannot start a teammate: it outlives the script and reports to the lead, so a script cannot use its result. Drop `name`, or call it from a session script",
		);
	}
	return record ? { kind: "former", record } : { kind: "new" };
}

type Run = (
	input: AgentInput,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	config: Config,
	parent: ParentContext,
	toolCallId: string,
	started: (spec: ChildSpec) => void,
	launch: TeamLaunch,
) => Promise<AgentResult>;

// Throws when the team has no room for one more member that is not stopped.
function checkRoom(): void {
	const team = teams.current();
	const max = teams.settings!.maxTeammates;
	const live = team?.live() ?? [];
	if (live.length >= max) {
		throw new Error(
			`the team already has ${live.length} teammates that are not stopped (${live.map((m) => `${m.name}: ${m.status}`).join(", ")}); stop one or raise agentTeams.maxTeammates (now ${max})`,
		);
	}
}

// Start (or continue) a teammate and return at once.
export async function startTeammate(
	call: TeamCall,
	params: AgentInput,
	parent: ParentContext,
	toolCallId: string,
	config: Config,
	run: Run,
) {
	checkRoom();
	const team = teams.ensure();
	const former = call.kind === "former" ? call.record : undefined;
	const name = former?.name ?? params.name!;
	const input: AgentInput = former ? { ...params, name: former.name!, resume: former.id } : params;
	const launch: TeamLaunch = {
		team: team.name,
		dir: team.dir,
		member: name,
		roster: [...team.roster(), name],
		...(former?.teamPrompt !== undefined ? { prompt: former.teamPrompt } : {}),
	};
	const wait = !slotFree();
	const controller = new AbortController(); // its own signal: it outlives this call
	let finished!: Promise<AgentResult>;
	const spec = await new Promise<ChildSpec>((resolve, reject) => {
		finished = run(
			input,
			controller.signal,
			undefined,
			config,
			parent,
			toolCallId,
			(spec) => {
				try {
					checkRoom(); // again, now: two calls of one tick both passed the first check
				} catch (err) {
					controller.abort(err); // the agent was resolved but has no place: nothing of it may start
					return reject(err);
				}
				registry.detach(spec.agentId, parent.sessionId, controller);
				team.addMember(name, spec.agentId, input.subagent_type ?? former?.type ?? "general-purpose", "queued");
				resolve(spec);
			},
			launch,
		);
		finished.then(() => {}, reject); // it failed before starting (unknown agent, bad resume...): throws here
	});
	// Its end is not reported here: the idle notice is (team.ts). Nothing is left to do but forget its signal.
	finished.then(
		() => registry.forget(spec.agentId),
		() => registry.forget(spec.agentId),
	);
	const result = {
		status: wait ? ("queued" as const) : ("started" as const),
		agentId: spec.agentId,
		agentType: input.subagent_type ?? former?.type ?? "general-purpose",
		name,
		team: teamLabel(team.name),
		model: spec.model,
		output: "",
		usage: emptyUsage(),
		turns: 0,
		durationMs: 0,
		warnings: spec.warnings,
	};
	return {
		content: [
			{
				type: "text" as const,
				text: `Teammate ${name} ${wait ? "is queued" : "started"} in team ${result.team} (agentId ${spec.agentId}). It works in parallel; its final answer arrives as an idle notice, and SendMessage reaches it.`,
			},
		],
		details: result as unknown as AgentResult,
		structuredContent: result as unknown as JsonValue,
		usage: result.usage,
		isError: false,
	};
}
