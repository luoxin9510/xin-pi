// The `agentTeams` setting (spec .scratch/agent-teams/01-agent-teams.md, "Turning it on"). A boundary: wrong types throw,
// naming the key.

export interface TeamSettings {
	enabled: boolean;
	maxTeammates: number; // members that are not stopped (running, queued, idle)
	taskRetentionDays: number; // task directories older than this are removed when a team is created
}

export const TEAMS_ENV = "XPI_EXPERIMENTAL_AGENT_TEAMS";

// `raw` is the setting: true / false, or the block. XPI_EXPERIMENTAL_AGENT_TEAMS=1 also turns teams on; there is no off
// override.
export function readTeamSettings(raw: unknown, env: NodeJS.ProcessEnv = process.env): TeamSettings {
	const defaults = { maxTeammates: 8, taskRetentionDays: 30 };
	const fromEnv = env[TEAMS_ENV] === "1";
	if (raw === undefined) return { enabled: fromEnv, ...defaults };
	if (typeof raw === "boolean") return { enabled: raw || fromEnv, ...defaults };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		throw new Error("agentTeams must be true, false or an object");
	const r = raw as Record<string, unknown>;
	const enabled = r.enabled ?? false;
	if (typeof enabled !== "boolean")
		throw new Error(`agentTeams.enabled must be true or false, got ${JSON.stringify(enabled)}`);
	const maxTeammates = r.maxTeammates ?? defaults.maxTeammates;
	if (!Number.isInteger(maxTeammates) || (maxTeammates as number) < 1)
		throw new Error("agentTeams.maxTeammates must be a positive integer");
	const taskRetentionDays = r.taskRetentionDays ?? defaults.taskRetentionDays;
	if (typeof taskRetentionDays !== "number" || !Number.isFinite(taskRetentionDays) || taskRetentionDays < 0)
		throw new Error("agentTeams.taskRetentionDays must be a number of days, 0 or more");
	return {
		enabled: enabled || fromEnv,
		maxTeammates: maxTeammates as number,
		taskRetentionDays,
	};
}

// Where teams can be on: tui mode (`hasUI` is also true in rpc mode) and a persisted session (with --no-session nothing
// can be continued, so a team could not outlive an exchange). A child never gets here: its subagent extension returns early.
export const teamsAllowed = (where: { mode: string; sessionFile: string | undefined }): boolean =>
	where.mode === "tui" && where.sessionFile !== undefined;
