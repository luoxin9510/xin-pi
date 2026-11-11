// M63: who may do what. The daemon judges each connection a Caller (a Person, a Session,
// an Unregistered agent) and asks this table, once, before an op runs. Rules that need the
// daemon's state stay with the op (a job that was removed, a token); this table is the
// caller's kind only.
//
// Every op of the protocol has a row, so an op added without saying who may use it does not
// type-check. The refusals are the daemon's own words and codes.
import type { Op } from "./protocol.ts";

export type Caller =
	| { kind: "person" }
	| { kind: "unregistered" }
	/** A session the daemon runs, known by the job whose report it sent. */
	| { kind: "session"; id: string };

export type CallerKind = Caller["kind"];

/**
 * The caller on a connection: one whose report was accepted is a Session; one that said it
 * is an agent but is not known (yet) is an Unregistered agent; one that never said is the
 * Person (the socket is the user's own).
 */
export function callerOf(conn: { peer?: { id: string }; agentSide?: boolean }): Caller {
	const p = conn.peer;
	if (!p) return conn.agentSide ? { kind: "unregistered" } : { kind: "person" };
	return { kind: "session", id: p.id };
}

export interface Refusal {
	code: "unauthorized" | "unsupported";
	message: string;
}
type Rule = "allow" | Refusal;
export interface Policy {
	person: Rule;
	session: Rule;
	unregistered: Rule;
}

export type PolicyKey = Op;

const unsupported = (message: string): Refusal => ({ code: "unsupported", message });

const HUBS = unsupported("this is the hub's and the CLI's: a session reports and takes replies");
const FEED = unsupported("the event feed is read by the hub and the CLI, not by sessions");

const anyone: Policy = { person: "allow", session: "allow", unregistered: "allow" };
const personOnly: Policy = { person: "allow", session: HUBS, unregistered: HUBS };

export const POLICY: Record<PolicyKey, Policy> = {
	// identifying: a worker's hello and report, a job's ack (each checks its token)
	hello: anyone,
	report: anyone,
	ack: anyone,
	// reading the roost
	ping: anyone,
	list: anyone,
	resolve: anyone,
	status: anyone,
	// the Person's: the hub and the CLI
	dispatch: personOnly,
	subscribe: personOnly,
	stop: personOnly,
	rm: personOnly,
	respawn: personOnly,
	pin: personOnly,
	rename: personOnly,
	reorder: personOnly,
	reply: personOnly,
	shutdown: personOnly,
	// phase 2: schedules start sessions unattended, so only the person makes and runs them
	schedules: personOnly,
	"schedule-add": personOnly,
	"schedule-edit": personOnly,
	"schedule-rm": personOnly,
	"schedule-pause": personOnly,
	"schedule-run": personOnly,
	events: { person: "allow", session: FEED, unregistered: FEED },
};

/** The row an op takes, or undefined for an op not in the table. */
export function policyKey(op: string): PolicyKey | undefined {
	return Object.hasOwn(POLICY, op) ? (op as PolicyKey) : undefined;
}

/** Whether the caller may do it: null, or the refusal. An op not in the table is the daemon's to refuse (unknown op). */
export function allow(caller: Caller, op: string): Refusal | null {
	const key = policyKey(op);
	if (!key) return null;
	const rule = POLICY[key][caller.kind];
	return rule === "allow" ? null : rule;
}
