// Where roost keeps things. Each agent directory has its own roost: its state in
// `<agent dir>/xpi-roost/` and its sockets in a runtime directory keyed by the agent
// directory, so a temporary agent directory (a test, a real-model check) never meets the
// user's daemon. ROOST_HOME and ROOST_RUNTIME_DIR override both.
//
// The agent directory comes from the caller (an xpi process passes its own) or, in roost's
// own processes (the daemon, a host, a session), from ROOST_AGENT_DIR, which the client
// that starts the daemon sets and the daemon hands on.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { roostEnv } from "./identity.ts";

/** The longest socket path used here; a unix socket path is limited to about 104 bytes (macOS). */
const SOCKET_PATH_MAX = 100;
/** The longest socket name in a runtime directory: `host-<8 hex>.sock`. */
const LONGEST_SOCKET = "host-00000000.sock";

/** The agent directory of this process, from its environment (the daemon, a host, a session). */
export function envAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return roostEnv("AGENT_DIR", env);
}

function requireAgentDir(agentDir: string | undefined): string {
	const dir = agentDir ?? envAgentDir();
	if (!dir)
		throw new Error("no agent directory: give one, or set ROOST_AGENT_DIR (or ROOST_HOME and ROOST_RUNTIME_DIR)");
	return dir;
}

/** The agent directory as one path: links resolved when it exists. */
function resolvedAgentDir(agentDir: string): string {
	try {
		return realpathSync(agentDir);
	} catch {
		return resolve(agentDir);
	}
}

/** A short key of the agent directory: the runtime directory's name. */
export function agentDirKey(agentDir: string): string {
	return createHash("sha256").update(resolvedAgentDir(agentDir)).digest("hex").slice(0, 12);
}

/** State: jobs, the roster, the event feed, the daemon's log. */
export function roostHome(agentDir?: string): string {
	return roostEnv("HOME") || join(requireAgentDir(agentDir), "xpi-roost");
}

/**
 * Sockets and the daemon's lock: `$XDG_RUNTIME_DIR/xpi-roost-<key>`, or
 * `/tmp/xpi-roost-<uid>/<key>` (also when the XDG path would make a socket path too long).
 */
export function runtimeDir(agentDir?: string): string {
	const rt = roostEnv("RUNTIME_DIR");
	if (rt) return rt;
	const key = agentDirKey(requireAgentDir(agentDir));
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg) {
		const dir = join(xdg, `xpi-roost-${key}`);
		if (Buffer.byteLength(join(dir, LONGEST_SOCKET)) <= SOCKET_PATH_MAX) return dir;
	}
	return join(tmpRuntimeParent(), key);
}

const tmpRuntimeParent = () => `/tmp/xpi-roost-${process.getuid?.() ?? 0}`;

export const jobsDir = () => join(roostHome(), "jobs");
export const jobDir = (id: string) => join(jobsDir(), id);
export const jobTmpDir = (id: string) => join(jobDir(id), "tmp");
export const daemonSocketPath = (agentDir?: string) => join(runtimeDir(agentDir), "daemon.sock");
export const hostSocketPath = (id: string, agentDir?: string) => join(runtimeDir(agentDir), `host-${id}.sock`);
export const daemonLockPath = (agentDir?: string) => join(runtimeDir(agentDir), "daemon.lock");
export const daemonLogPath = () => join(roostHome(), "daemon.log");
export const rosterPath = () => join(roostHome(), "roster.json");

/** A directory only this user can use: made with mode 0700, never a link, owned by this user. */
function privateDir(dir: string): void {
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const st = lstatSync(dir);
	if (st.isSymbolicLink()) throw new Error(`runtime dir ${dir} is a symlink`);
	if (!st.isDirectory()) throw new Error(`runtime dir ${dir} is not a directory`);
	if (process.getuid && st.uid !== process.getuid())
		throw new Error(`runtime dir ${dir} is not owned by the current user`);
	chmodSync(dir, 0o700);
}

/** The state and runtime directories, made and checked (each level of the runtime directory roost makes). */
export function ensureDirs(agentDir?: string): void {
	mkdirSync(join(roostHome(agentDir), "jobs"), { recursive: true, mode: 0o700 });
	const rt = runtimeDir(agentDir);
	if (roostEnv("RUNTIME_DIR")) {
		mkdirSync(resolve(rt, ".."), { recursive: true });
	} else if (rt.startsWith(`${tmpRuntimeParent()}/`)) {
		privateDir(tmpRuntimeParent());
	}
	privateDir(rt);
	if (Buffer.byteLength(join(rt, LONGEST_SOCKET)) > SOCKET_PATH_MAX) {
		throw new Error(`runtime dir ${rt} is too long for a unix socket path; set ROOST_RUNTIME_DIR to a shorter one`);
	}
}

/**
 * Decision 7: where a roost is, as its processes carry it in their environment. The client
 * that starts the daemon sets these; the daemon passes them to every host, and a host to
 * its session, whatever the session's allow and deny lists say.
 */
export const ROOST_LOCATION_ENV = ["ROOST_AGENT_DIR", "ROOST_HOME", "ROOST_RUNTIME_DIR", "ROOST_HOST_ENTRY"] as const;

/** The variable an xpi session reads its agent directory from. */
export const SESSION_AGENT_DIR_ENV = "XPI_CODING_AGENT_DIR";

/**
 * The location variables of `env` (a daemon's or a host's), for a session: its xpi uses
 * the same agent directory, so its own `/agents` reaches the daemon that runs it.
 */
export function roostEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of ROOST_LOCATION_ENV) {
		const v = env[name];
		if (v) out[name] = v;
	}
	if (out.ROOST_AGENT_DIR) out[SESSION_AGENT_DIR_ENV] = out.ROOST_AGENT_DIR;
	return out;
}

/** `env` without roost's location variables (a session's captured environment may hold another roost's). */
export function withoutRoostLocation(env: Record<string, string>): Record<string, string> {
	const out = { ...env };
	for (const name of ROOST_LOCATION_ENV) delete out[name];
	return out;
}
