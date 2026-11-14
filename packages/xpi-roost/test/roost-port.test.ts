// M71: the hub's port to the daemon: each method sends the right op and arguments through the
// client and returns the result as it came; dispatch and reply keep M51's request ids. Phase 1: the sessions and the
// event feed (the task board, concierge and schedule rows are not ported).
import { describe, expect, it } from "vitest";
import { type RoostPort, roostPort } from "../src/hub/roost-port.ts";
import { type DaemonClient, DaemonError } from "../src/lib/client.ts";
import type { DispatchArgs, Event } from "../src/lib/protocol.ts";
import { fakePort } from "./support/roost-port.ts";

type Sent = { op: string; args: any };

function recording(answer: (op: string, args: unknown) => unknown = (op) => ({ op })) {
	const sent: Sent[] = [];
	const listeners: ((e: Event) => void)[] = [];
	const client = {
		request: async (op: string, args: unknown) => {
			sent.push({ op, args });
			return answer(op, args);
		},
		requestAt: async (op: string, args: unknown) => {
			sent.push({ op, args });
			return { result: answer(op, args), at: 7 };
		},
		onEvent: (l: (e: Event) => void) => {
			listeners.push(l);
			return () => void listeners.splice(listeners.indexOf(l), 1);
		},
		position: () => 3,
	} as unknown as DaemonClient;
	return { client, sent, listeners };
}

const launch = { cwd: "/w", command: ["pi"], name: "x", origin: "dispatch" } as unknown as DispatchArgs;

// [name, call, op, args]
const table: [string, (p: RoostPort) => Promise<unknown>, string, unknown][] = [
	["jobs.list", (p) => p.jobs.list({ cwd: "/w" }), "list", { cwd: "/w" }],
	["jobs.stop", (p) => p.jobs.stop("a"), "stop", { id: "a" }],
	["jobs.rm", (p) => p.jobs.rm("a"), "rm", { id: "a" }],
	["jobs.pin", (p) => p.jobs.pin("a", true), "pin", { id: "a", pinned: true }],
	["jobs.rename", (p) => p.jobs.rename("a", "n"), "rename", { id: "a", name: "n" }],
	["jobs.reorder", (p) => p.jobs.reorder(["a", "b"], "k"), "reorder", { ids: ["a", "b"], key: "k" }],
	["jobs.respawn", (p) => p.jobs.respawn("a"), "respawn", { id: "a" }],
	["jobs.restart", (p) => p.jobs.restart(["a", "b"], { id: "b" }), "respawn", { ids: ["a", "b"], last: { id: "b" } }],
	["events.list", (p) => p.events.list({ limit: 500 }), "events", { limit: 500 }],
];

describe("RoostPort adapter", () => {
	it.each(table)("%s sends one request and returns its result", async (_name, call, op, args) => {
		const { client, sent } = recording((o) => ({ answered: o }));
		const result = await call(roostPort(client));
		expect(sent).toHaveLength(1);
		expect(sent[0]!.op).toBe(op);
		expect(sent[0]!.args).toEqual(args);
		expect(result).toEqual({ answered: op });
	});

	it("jobs.listAt returns the reply and its place in the stream", async () => {
		const { client, sent } = recording(() => ({ jobs: [] }));
		expect(await roostPort(client).jobs.listAt({})).toEqual({ result: { jobs: [] }, at: 7 });
		expect(sent).toEqual([{ op: "list", args: {} }]);
	});

	it("subscribe listens before it asks, and listen/position pass through", async () => {
		const { client, sent, listeners } = recording();
		const port = roostPort(client);
		const heard: Event[] = [];
		await port.subscribe((e) => heard.push(e));
		expect(sent).toEqual([{ op: "subscribe", args: {} }]);
		expect(listeners).toHaveLength(1);
		const off = port.listen(() => {});
		expect(listeners).toHaveLength(2);
		off();
		expect(listeners).toHaveLength(1);
		expect(port.position()).toBe(3);
	});

	it("dispatch and reply carry a request id, a given one kept", async () => {
		const { client, sent } = recording(() => ({ id: "x", name: "n" }));
		const port = roostPort(client);
		await port.jobs.dispatch(launch, { tag: "hub" });
		await port.jobs.reply({ id: "a", text: "hi" }, { tag: "hub" });
		await port.jobs.reply({ id: "a", text: "hi", requestId: "mine-1" });
		expect(sent.map((s) => s.op)).toEqual(["dispatch", "reply", "reply"]);
		expect(sent[0]!.args.requestId).toMatch(/^hub\./);
		expect(sent[1]!.args).toMatchObject({ id: "a", text: "hi" });
		expect(sent[1]!.args.requestId).toMatch(/^hub\./);
		expect(sent[2]!.args.requestId).toBe("mine-1");
	});

	it("a reply lost with the connection is sent again on the connection `via` gives, with the same id", async () => {
		const sent: Sent[] = [];
		const dead = {
			request: async (op: string, args: unknown) => {
				sent.push({ op, args });
				throw new DaemonError("daemon connection closed", "closed");
			},
		} as unknown as DaemonClient;
		const alive = {
			request: async (op: string, args: unknown) => {
				sent.push({ op, args });
				return { delivered: true, saved: false };
			},
		} as unknown as DaemonClient;
		const seen: number[] = [];
		const via = async (deadline: number) => {
			seen.push(deadline);
			return sent.length === 0 ? dead : alive;
		};
		const port = roostPort(dead, via);
		const r = await port.jobs.reply({ id: "a", text: "hi" }, { tag: "hub", timeoutMs: 5000 });
		expect(r).toEqual({ delivered: true, saved: false });
		expect(sent).toHaveLength(2);
		expect(sent[1]!.args.requestId).toBe(sent[0]!.args.requestId);
		expect(seen).toHaveLength(2);
	});

	it("a refusal by the daemon is not sent again", async () => {
		const sent: Sent[] = [];
		const err = Object.assign(new DaemonError("no such session", "not_found"), { fromDaemon: true });
		const client = {
			request: async (op: string, args: unknown) => {
				sent.push({ op, args });
				throw err;
			},
		} as unknown as DaemonClient;
		await expect(roostPort(client).jobs.reply({ id: "a", text: "x" })).rejects.toBe(err);
		expect(sent).toHaveLength(1);
	});
});

describe("fakePort", () => {
	it("records calls by path and answers what it is given", async () => {
		const { port, calls } = fakePort({ "jobs.list": () => ({ jobs: [] }) });
		expect(await port.jobs.list({ cwd: "/r" })).toEqual({ jobs: [] });
		expect(await port.jobs.pin("a", true)).toEqual({});
		expect(calls).toEqual([
			{ path: "jobs.list", args: [{ cwd: "/r" }] },
			{ path: "jobs.pin", args: ["a", true] },
		]);
	});
});
