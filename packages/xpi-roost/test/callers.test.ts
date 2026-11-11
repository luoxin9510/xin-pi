import { describe, expect, it } from "vitest";
import { allow, callerOf, POLICY, policyKey } from "../src/lib/callers.ts";
import { OPS } from "../src/lib/protocol-schema.ts";

const person = callerOf({});
const unregistered = callerOf({ agentSide: true });
const job = callerOf({ peer: { id: "j1" } });

describe("M63: callers", () => {
	it("judges a connection: no word is the Person; an agent's word without a job, Unregistered; a job's report, a Session", () => {
		expect(person).toEqual({ kind: "person" });
		expect(unregistered).toEqual({ kind: "unregistered" });
		expect(job).toEqual({ kind: "session", id: "j1" });
		// a session is a session, whatever else the connection said
		expect(callerOf({ peer: { id: "j1" }, agentSide: true }).kind).toBe("session");
	});

	it("a row for every op, and none for anything else", () => {
		expect(Object.keys(POLICY).sort()).toEqual([...OPS].sort());
		expect(OPS).toHaveLength(18);
		expect(policyKey("nonsense")).toBeUndefined();
		// a name from the prototype is not a row
		expect(policyKey("toString")).toBeUndefined();
		// pi-roost's ops that are not ported have no row: the daemon answers them as unknown
		for (const op of ["peers", "send", "spawn", "handback", "peer_register", "task", "concierge", "schedules"])
			expect(policyKey(op)).toBeUndefined();
	});

	it("the Person's ops: refused to everyone else with the same words", () => {
		for (const op of [
			"dispatch",
			"stop",
			"rm",
			"respawn",
			"pin",
			"rename",
			"reorder",
			"shutdown",
			"subscribe",
			"reply",
		]) {
			expect(allow(person, op)).toBeNull();
			for (const c of [job, unregistered])
				expect(allow(c, op)).toEqual({
					code: "unsupported",
					message: expect.stringContaining("the hub's and the CLI's"),
				});
		}
	});

	it("the event feed is the Person's", () => {
		expect(allow(person, "events")).toBeNull();
		expect(allow(job, "events")?.message).toContain("not by sessions");
		expect(allow(unregistered, "events")?.code).toBe("unsupported");
	});

	it("identifying and reading are anyone's; an op not in the table is left to the daemon", () => {
		for (const op of ["hello", "report", "ack", "ping", "list", "status", "resolve"])
			for (const c of [person, job, unregistered]) expect(allow(c, op)).toBeNull();
		expect(allow(job, "nonsense")).toBeNull();
	});

	it("every row says each kind of caller, and a refusal is unauthorized or unsupported with words", () => {
		for (const [key, p] of Object.entries(POLICY)) {
			for (const kind of ["person", "session", "unregistered"] as const) {
				const r = p[kind];
				if (r === "allow") continue;
				expect(["unauthorized", "unsupported"], key).toContain(r.code);
				expect(r.message.length, key).toBeGreaterThan(0);
			}
		}
	});
});
