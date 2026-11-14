// A job's identity and roost's own settings in the environment. Every name is ROOST_*.

/** What a worker reads to find its job. */
export const JOB_ENV = {
	id: "ROOST_JOB_ID",
	token: "ROOST_JOB_TOKEN",
	socket: "ROOST_SOCKET",
	dir: "ROOST_JOB_DIR",
} as const;

/**
 * Spec 03: set (to the session's id) in an xpi started from a session's shell once it forgot the job it inherited. It
 * says "inside a background session" without naming a caller: what is refused in a session (decision 8, schedules)
 * stays refused there.
 */
export const INSIDE_ENV = "ROOST_INSIDE";

/** Every name that makes a process a job's worker: never inherited by another job. */
export const JOB_ENV_NAMES: readonly string[] = [...Object.values(JOB_ENV), "ROOST_RESTORE", INSIDE_ENV];

/** Whether this process runs inside a background session: the session itself, or anything started from it. */
export function insideSession(env: NodeJS.ProcessEnv): string | undefined {
	return readJobEnv(env, "id") ?? (env[INSIDE_ENV] || undefined);
}

/** The environment a job's worker starts with. */
export function jobEnv(o: { id: string; token?: string; socket: string; dir: string }): Record<string, string> {
	return {
		[JOB_ENV.id]: o.id,
		...(o.token !== undefined ? { [JOB_ENV.token]: o.token } : {}),
		[JOB_ENV.socket]: o.socket,
		[JOB_ENV.dir]: o.dir,
	};
}

/** A JOB_ENV entry, when set. */
export function readJobEnv(env: NodeJS.ProcessEnv, which: keyof typeof JOB_ENV): string | undefined {
	return env[JOB_ENV[which]] || undefined;
}

/** A roost setting from the environment: ROOST_<name>. */
export function roostEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env[`ROOST_${name}`] || undefined;
}
