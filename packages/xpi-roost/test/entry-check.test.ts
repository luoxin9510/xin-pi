// M76: the daemon checks the simple ops' arguments at its entry by their schemas
// (src/lib/protocol-schema.ts), saying what each hand check said, and refusing nothing the
// daemon took before. The daemon's own answers are in the daemon and callers-matrix tests.
import { describe, expect, it } from "vitest";
import { ArgSchemas, argsProblem, ENTRY_CHECKED } from "../src/lib/protocol-schema.ts";
import type { Schema } from "../src/lib/schema.ts";

/** Places a check could fail with words of its own ("must be a string"), not the daemon's. */
function unworded(s: Schema, path: string, out: string[], root = false, discriminant?: string): void {
	if (s["x-loose"]) return;
	// an object whose fields are the op's (M77: spawn's launch): its own words only
	if (s["x-shallow"]) {
		if (!s.message) out.push(path);
		return;
	}
	if (s.anyOf) {
		// a discriminated union: its words for a wrong discriminant, then the member picked
		if (!root && !s.message) out.push(path);
		for (const m of s.anyOf) unworded(m, path, out, true, s["x-discriminant"]);
		return;
	}
	if (!root && !s.message) out.push(path);
	for (const [k, p] of Object.entries(s.properties ?? {})) if (k !== discriminant) unworded(p, `${path}.${k}`, out);
	if (s.items) unworded(s.items, `${path}[]`, out);
	if (s.additionalProperties) unworded(s.additionalProperties, `${path}{}`, out);
}

describe("the entry check", () => {
	it("covers every op (M77: dispatch too)", () => {
		expect([...ENTRY_CHECKED].sort()).toEqual(Object.keys(ArgSchemas).sort());
		expect(ENTRY_CHECKED.size).toBe(18);
		expect(argsProblem("nope", {})).toBeUndefined();
	});

	it("says `missing args` for a dispatch with none, as dispatch() did; an array was read as no fields", () => {
		expect(argsProblem("dispatch", undefined)).toBe("missing args");
		expect(argsProblem("dispatch", null)).toBe("missing args");
		expect(argsProblem("dispatch", "x")).toBe("missing args");
		expect(argsProblem("dispatch", [])).toBeUndefined();
	});

	it("says only the daemon's words: each field it checks carries them, the rest is loose", () => {
		const out: string[] = [];
		for (const op of ENTRY_CHECKED) {
			const s = ArgSchemas[op as keyof typeof ArgSchemas] as Schema;
			// a union's words are the root's own (a wrong discriminant)
			if (s.anyOf && !s["x-loose"] && !s.message) out.push(op);
			unworded(s, op, out, true);
		}
		expect(out).toEqual([]);
	});

	it("takes arguments that are not an object as none", () => {
		expect(argsProblem("resolve", "x")).toBe("query required");
		expect(argsProblem("resolve", null)).toBe("query required");
		expect(argsProblem("resolve", [1])).toBe("query required");
		expect(argsProblem("ping", "x")).toBeUndefined();
	});

	// [op, args, the daemon's words]: each hand check's refusal, now the schema's
	const refused: [string, unknown, string][] = [
		["resolve", {}, "query required"],
		["resolve", { query: "" }, "query required"],
		["stop", { id: 3 }, "id required"],
		["rm", {}, "id required"],
		["pin", { id: "" }, "id required"],
		["rename", { id: "a" }, "empty name"],
		["rename", { id: "a", name: " \n " }, "empty name"],
		["rename", { name: "x" }, "id required"],
		["reorder", { key: "k" }, "ids must be job ids"],
		["reorder", { ids: ["a", ""], key: "k" }, "ids must be job ids"],
		["reorder", { ids: ["a", 2], key: "k" }, "ids must be job ids"],
		["reorder", { ids: [] }, "key required"],
		["reply", { id: "a", text: "  " }, "empty reply"],
		["reply", { id: "a", text: 5 }, "empty reply"],
		["reply", { text: "x" }, "id required"],
		["reply", { id: "a", text: "x", requestId: "has space" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["reply", { id: "a", text: "x", requestId: "x".repeat(65) }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["reply", { id: "a", text: "x", requestId: 7 }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["hello", {}, "protocol must be a version number"],
		["hello", { protocol: 0 }, "protocol must be a version number"],
		["hello", { protocol: 1.5 }, "protocol must be a version number"],
		["hello", { protocol: "1" }, "protocol must be a version number"],
		["events", { after: "3" }, "after must be a number"],
		["events", { limit: true }, "limit must be a number"],
		["events", { id: "" }, "id must be a job id"],
		["events", { id: 4 }, "id must be a job id"],
		// M77
		["dispatch", { requestId: "a b" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
		["dispatch", { requestId: null, cwd: "/" }, "requestId: 1-64 of A-Z a-z 0-9 _ . : -"],
	];
	it.each(refused)("%s %j: %s", (op, args, words) => {
		expect(argsProblem(op, args)).toBe(words);
	});

	// what the daemon took before (dropped, cut, filtered, or checked later in the op's own words)
	const taken: [string, unknown][] = [
		["list", { cwd: 5, all: "yes" }],
		["respawn", {}],
		["respawn", { all: true }],
		["pin", { id: "a", pinned: "yes" }],
		["shutdown", { keepWorkers: 1 }],
		["reply", { id: "a", text: " x ", mode: "sideways" }],
		["reply", { id: "a", text: "x", requestId: "a:b.c_d-1" }],
		["ack", { id: 1, token: 2 }],
		["report", { id: 1, report: { state: "done", status: "idle", summary: 4, choices: "x" } }],
		["hello", { protocol: 2, agent: "x", capabilities: [1, "a", null] }],
		["events", { after: 1.5, limit: -1 }],
		// M77: a resend returns its job before anything else is read; the rest is dispatch()'s
		["dispatch", { cwd: 5, command: "x", requestId: "r-1" }],
		["dispatch", {}],
		// for a job that ended, any report is taken
		["report", { report: "x" }],
		["report", { report: { state: "nope" } }],
	];
	it.each(taken)("%s %j: taken", (op, args) => {
		expect(argsProblem(op, args)).toBeUndefined();
	});
});
