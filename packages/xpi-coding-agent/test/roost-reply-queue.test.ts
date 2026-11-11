// builtin:roost: replies from the hub and `xpi roost reply`, handed to xpi one at a time. Ported from pi-roost's
// reply-queue.test.ts without the agent items (M9, decision 6).
import { describe, expect, it } from "vitest";
import { ReplyQueue } from "../src/extensions/roost/worker.ts";

function harness(opts: { setModel?: () => Promise<boolean> } = {}) {
	const sent: { text: string; opts: unknown }[] = [];
	const acks: number[] = [];
	const notes: string[] = [];
	const state = { running: false, idle: true, dialog: false };
	const pi = {
		sendUserMessage: async (text: string, opts: unknown) => {
			sent.push({ text, opts });
		},
		setSessionName: (n: string) => sent.push({ text: `name:${n}`, opts: null }),
		setThinkingLevel: (l: string) => sent.push({ text: `thinking:${l}`, opts: null }),
		setModel: opts.setModel ?? (async () => true),
	};
	const ctx = {
		isIdle: () => state.idle,
		ui: { notify: (m: string) => notes.push(m) },
		modelRegistry: { find: (p: string, id: string) => (p === "x" ? { provider: p, id } : undefined) },
	};
	const q = new ReplyQueue(pi as never, {
		ctx: () => ctx as never,
		running: () => state.running,
		dialogOpen: () => state.dialog,
		ack: (seq: number) => acks.push(seq),
	});
	return { q, sent, acks, notes, state };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ReplyQueue", () => {
	it("M8: a /model that xpi refuses (false or a throw) leaves one note, never a prompt", async () => {
		const no = harness({ setModel: async () => false });
		no.q.add({ seq: 1, text: "/model x/m" });
		await sleep(10);
		expect(no.notes).toEqual(["xpi roost: cannot switch to x/m: no credentials for x in this session"]);
		expect(no.sent).toEqual([]);
		expect(no.acks).toEqual([1]);
		const boom = harness({ setModel: async () => Promise.reject(new Error("No API key for x/m")) });
		boom.q.add({ seq: 1, text: "/model x/m" });
		await sleep(10);
		expect(boom.notes).toEqual(["xpi roost: cannot switch model: Error: No API key for x/m"]);
	});

	it("sends the first reply as a prompt, holds the next until the run starts, then follows up", () => {
		const h = harness();
		h.q.add({ seq: 1, text: "first" });
		h.q.add({ seq: 2, text: "second" });
		expect(h.sent).toEqual([{ text: "first", opts: { expandPromptTemplates: true } }]);
		expect(h.acks).toEqual([1]);
		h.state.running = true;
		h.state.idle = false;
		h.q.pump(); // agent_start
		expect(h.sent[1]).toEqual({ text: "second", opts: { deliverAs: "followUp", expandPromptTemplates: true } });
		expect(h.acks).toEqual([1, 2]);
	});

	it("M28: a steering reply joins the running turn; one without a mode follows up", () => {
		const h = harness();
		h.state.running = true;
		h.state.idle = false;
		h.q.add({ seq: 1, text: "use pnpm", mode: "steer" });
		h.q.add({ seq: 2, text: "then run the tests" });
		expect(h.sent).toEqual([
			{ text: "use pnpm", opts: { deliverAs: "steer", expandPromptTemplates: true } },
			{ text: "then run the tests", opts: { deliverAs: "followUp", expandPromptTemplates: true } },
		]);
		// idle: either one starts a turn
		const idle = harness();
		idle.q.add({ seq: 1, text: "go", mode: "steer" });
		expect(idle.sent).toEqual([{ text: "go", opts: { expandPromptTemplates: true } }]);
	});

	it("runs settings at once, warns on bad ones, and drops resends", () => {
		const h = harness();
		h.state.running = true;
		h.q.add({ seq: 1, text: "/name reset fix" });
		h.q.add({ seq: 2, text: "/thinking high" });
		h.q.add({ seq: 3, text: "/thinking loud" });
		h.q.add({ seq: 4, text: "/model y/z" });
		h.q.add({ seq: 1, text: "/name reset fix" });
		expect(h.sent.map((s) => s.text)).toEqual(["name:reset fix", "thinking:high"]);
		expect(h.notes).toHaveLength(2);
		expect(h.acks).toEqual([1, 2, 3, 4, 1]);
	});

	it("waits behind a dialog and while compacting", async () => {
		const h = harness();
		h.state.dialog = true;
		h.q.add({ seq: 1, text: "after the dialog" });
		expect(h.sent).toEqual([]);
		h.state.dialog = false;
		h.state.idle = false; // compacting: not running, not idle
		h.q.pump();
		expect(h.sent).toEqual([]);
		h.state.idle = true;
		await sleep(600);
		expect(h.sent.map((s) => s.text)).toEqual(["after the dialog"]);
		expect(h.acks).toEqual([1]);
	});
});
