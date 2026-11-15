import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "xpi-agent-core";
import type { Api, Model } from "xpi-ai";
import {
	createRelay,
	HANDBACK_ENTRY,
	HANDOVER_ENTRY,
	type NoticeLevel,
	RELAY_MODEL,
	RELAY_PROVIDER,
	type RelayCall,
	type RelayEntry,
	type RelayHost,
	type RelayRouteRequest,
	readView,
	type ToolSpec,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "../src/index.ts";

/** `createRelay` against a fake host: an in-memory branch, and records of what the host was asked to do. */
function fake(settings: Record<string, unknown> = {}) {
	const entries: RelayEntry[] = [];
	const notices: { text: string; level: NoticeLevel }[] = [];
	const sent: { content: string; deliverAs?: string }[] = [];
	const registered: ToolSpec[][] = [];
	let active = ["read"];
	let model: { provider: string; id: string } | undefined = { provider: RELAY_PROVIDER, id: RELAY_MODEL };
	let idle = true;
	let counter = 0;
	const cwd = mkdtempSync(join(tmpdir(), "xpi-relay-host-"));

	const push = (
		entry: { type: "custom"; customType: string; data?: unknown } | { type: "message"; message: AgentMessage },
	) => {
		entries.push({ id: `e${counter++}`, timestamp: new Date().toISOString(), ...entry });
	};
	const host: RelayHost = {
		appendEntry: (customType, data) => push({ type: "custom", customType, data }),
		settings: () => settings,
		sendMessage: (message, options) => {
			sent.push({ content: message.content, deliverAs: options.deliverAs });
		},
		activeTools: () => [...active],
		setActiveTools: (names) => {
			active = names;
		},
		registerTools: (specs) => {
			registered.push(specs);
		},
	};
	const models = new Map<string, Model<Api>>();
	const call: RelayCall = {
		get entries() {
			return entries;
		},
		get model() {
			return model;
		},
		cwd,
		signal: undefined,
		findModel: (ref) => models.get(ref),
		notify: (text, level = "info") => notices.push({ text, level }),
		isIdle: () => idle,
	};
	const state = (phase: "lead" | "worker", round: number) =>
		push({
			type: "custom",
			customType: VIRTUAL_MODEL_STATE_ENTRY,
			data: { provider: RELAY_PROVIDER, modelId: RELAY_MODEL, state: { phase, round } },
		});
	const message = (message: Record<string, unknown>) =>
		push({ type: "message", message: message as unknown as AgentMessage });
	return {
		host,
		call,
		push,
		entries,
		notices,
		sent,
		registered,
		models,
		cwd,
		state,
		message,
		activeTools: () => active,
		setActive: (names: string[]) => {
			active = names;
		},
		select: (next: { provider: string; id: string } | undefined) => {
			model = next;
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		customTypes: () => entries.flatMap((entry) => (entry.type === "custom" ? [entry.customType] : [])),
	};
}

const assistant = (text: string, toolCall = false) => ({
	role: "assistant",
	content: toolCall ? [{ type: "toolCall", id: "c1", name: "codemode", arguments: {} }] : [{ type: "text", text }],
});
const user = (text: string) => ({ role: "user", content: text });
const toolResult = (toolName: string, text: string) => ({
	role: "toolResult",
	toolCallId: "c1",
	toolName,
	content: [{ type: "text", text }],
	isError: false,
});
const config = { lead: "faux/large", worker: "faux/small", maxRounds: 1 };

describe("createRelay against a fake host", () => {
	let dirs: string[] = [];
	const make = (settings: Record<string, unknown> = config) => {
		const f = fake(settings);
		dirs.push(f.cwd);
		return { ...f, relay: createRelay(f.host) };
	};
	beforeEach(() => {
		dirs = [];
	});
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("reads the same view whether relay.transition precedes or follows the state entry", () => {
		const branch = (stateFirst: boolean): RelayEntry[] => {
			const { entries, state, message, push } = fake(config);
			message(user("go"));
			state("lead", 0);
			push({ type: "custom", customType: HANDOVER_ENTRY, data: { round: 1, plan: "p", at: 1 } });
			const transition = () =>
				push({
					type: "custom",
					customType: "relay.transition",
					data: { from: "lead", to: "worker", event: "handover", round: 1, at: 2 },
				});
			if (stateFirst) {
				state("worker", 1);
				transition();
			} else {
				transition();
				state("worker", 1);
			}
			return entries.map((entry) => ({ ...entry, id: "x", timestamp: "t" }));
		};
		expect(readView(branch(true))).toEqual(readView(branch(false)));
		expect(readView(branch(true)).phase).toBe("worker");
	});

	it("registers the two hand tools as deferred tools at the start", () => {
		const { registered } = make();
		expect(registered).toHaveLength(1);
		expect(registered[0].map((spec) => [spec.name, spec.exposure, spec.listed, spec.defaultActive])).toEqual([
			["handover", "deferred", false, false],
			["handback", "deferred", false, false],
		]);
	});

	describe("handover", () => {
		it("writes the entry, answers with the marker and ends the turn; a second call in the response is 'already'", async () => {
			const { relay, call, entries } = make();
			const outcome = await relay.handover(
				{ plan: "do it", acceptance: ["true", " "], criteria: "c" },
				undefined,
				call,
			);
			expect(outcome.terminate).toBe(true);
			expect(outcome.text).toMatch(/^Handed over to the worker model \(round 1\)/);
			expect(outcome.text.split("\n").at(-1)).toBe('<relay-handover round="1"/>');
			const written = entries.find((entry) => entry.type === "custom" && entry.customType === HANDOVER_ENTRY);
			expect(written?.type === "custom" && written.data).toMatchObject({
				round: 1,
				plan: "do it",
				acceptance: ["true"],
				criteria: "c",
			});
			expect((await relay.handover({ plan: "again" }, undefined, call)).text).toBe("Already handed over.");
		});

		it("refuses an empty plan and a model other than relay/auto, and writes nothing when cut off", async () => {
			const { relay, call, entries, select } = make();
			await expect(relay.handover({ plan: " " }, undefined, call)).rejects.toThrow("plan is empty");
			const aborted = new AbortController();
			aborted.abort();
			await expect(relay.handover({ plan: "x" }, aborted.signal, call)).rejects.toThrow("Operation aborted");
			select({ provider: "faux", id: "small" });
			await expect(relay.handover({ plan: "x" }, undefined, call)).rejects.toThrow(
				/works only with the relay\/auto model/,
			);
			expect(entries).toHaveLength(0);
		});

		it("makes the worker answer the next request, and writes the transition then", async () => {
			const { relay, call, entries, models, state, message, notices, customTypes } = make();
			models.set("faux/small", { id: "small" } as Model<Api>);
			models.set("faux/large", { id: "large" } as Model<Api>);
			state("lead", 0);
			message(user("go"));
			const outcome = await relay.handover({ plan: "do it" }, undefined, call);
			const request: RelayRouteRequest = {
				reason: "continuation",
				state: { phase: "lead", round: 0 },
				messages: [assistant("", true), toolResult("codemode", `ok\n${outcome.text}`)] as never,
			};
			const route = relay.route(request, call);
			expect(route.model.id).toBe("small");
			expect(route.state).toEqual({ phase: "worker", round: 1 });
			// route() has no side effects: the transition is written at the commit point.
			const written = entries.length;
			expect(customTypes()).not.toContain("relay.transition");
			relay.onRequestStart({ previousRouterState: request.state, routerState: route.state }, call);
			expect(entries).toHaveLength(written + 1);
			expect(entries.at(-1)).toMatchObject({
				customType: "relay.transition",
				data: { from: "lead", to: "worker", round: 1 },
			});
			expect(notices.at(-1)?.text).toBe("relay: lead → worker (round 1)");
			// A retry meets the same stored state on both sides and writes nothing.
			relay.onRequestStart({ previousRouterState: route.state, routerState: route.state }, call);
			expect(entries).toHaveLength(written + 1);
			// Without the marker the lead goes on.
			const lead = relay.route(
				{ ...request, messages: [assistant("", true), toolResult("codemode", "ok")] as never },
				call,
			);
			expect(lead.model.id).toBe("large");
		});

		it("voids a handover whose result did not end with the marker, and the lead goes on", async () => {
			const { relay, call, customTypes, state, message, notices } = make();
			state("lead", 0);
			message(user("go"));
			await relay.handover({ plan: "do it" }, undefined, call);
			message(assistant("", true));
			message(toolResult("codemode", "the call was cut off"));
			message(assistant("done"));
			const result = await relay.beforeSettle({ outcome: "completed", contextMessages: [] }, call);
			expect(result?.continue).toBe(false);
			expect(result?.entries).toEqual([
				{ type: "custom", customType: "relay.void", data: expect.objectContaining({ what: "handover", round: 0 }) },
			]);
			expect(notices.at(-1)).toMatchObject({ level: "warning" });
			expect(customTypes()).toContain(HANDOVER_ENTRY);
		});

		it("continues a landed handover so that the worker answers", async () => {
			const { relay, call, state, message } = make();
			state("lead", 0);
			message(user("go"));
			const outcome = await relay.handover({ plan: "do it" }, undefined, call);
			message(assistant("", true));
			message(toolResult("codemode", outcome.text));
			const result = await relay.beforeSettle({ outcome: "completed", contextMessages: [] }, call);
			expect(result).toEqual({ entries: [], continue: true });
		});
	});

	describe("hand back", () => {
		async function inWorkerPhase(acceptance: string[]) {
			const made = make();
			made.state("lead", 0);
			made.message(user("go"));
			await made.relay.handover({ plan: "do it", acceptance }, undefined, made.call);
			made.state("worker", 1);
			made.message(assistant("working", true));
			return made;
		}

		it("records the round: the record, the round line and the lead's review message", async () => {
			const { relay, call, entries, message } = await inWorkerPhase([]);
			const outcome = await relay.handback({ status: "done", report: "all done" }, call);
			expect(outcome).toEqual({ text: "Handed back.", terminate: true });
			expect(entries.some((entry) => entry.type === "custom" && entry.customType === HANDBACK_ENTRY)).toBe(true);
			message(assistant("finished"));
			const result = await relay.beforeSettle({ outcome: "completed", contextMessages: [] }, call);
			expect(result?.continue).toBe(true);
			expect(
				result?.entries.map((draft) =>
					draft.type === "custom_message"
						? `${draft.type}:${draft.customType}`
						: draft.type === "custom"
							? draft.customType
							: draft.type,
				),
			).toEqual(["relay.round", "compaction", "custom_message:relay.review", "relay.transition"]);
			const compaction = result?.entries.find((draft) => draft.type === "compaction");
			expect(compaction).toMatchObject({ details: { relay: true, round: 1 } });
			expect(compaction?.type === "compaction" && compaction.summary).toContain("all done");
		});

		it("sends a failed acceptance run back to the worker, then hands back at maxRounds", async () => {
			const { relay, call, message, customTypes } = await inWorkerPhase(["exit 1"]);
			await relay.handback({ status: "done", report: "r" }, call);
			message(assistant("finished"));
			const first = await relay.beforeSettle({ outcome: "completed", contextMessages: [] }, call);
			expect(first?.continue).toBe(true);
			expect(first?.entries.map((draft) => (draft.type === "compaction" ? draft.type : draft.customType))).toEqual([
				"relay.verify",
				"relay.verify",
			]);
			const feedback = first?.entries.find((draft) => draft.type === "custom_message");
			expect(feedback?.type === "custom_message" && feedback.content).toContain("did not all pass (attempt 1 of 1)");
			expect(customTypes()).toContain("relay.handback");
		});

		it("corrects a worker that calls handover, and blocks the hand back the second time", async () => {
			const { relay, call } = await inWorkerPhase([]);
			await expect(relay.handover({ plan: "x" }, undefined, call)).rejects.toThrow(/Only the lead hands over/);
			await expect(relay.handover({ plan: "x" }, undefined, call)).resolves.toEqual({
				text: "Handed back as blocked: the roles were mixed up.",
				terminate: true,
			});
		});
	});

	describe("pause", () => {
		it("pauses the worker's phase when another model is selected and resumes when relay/auto returns", async () => {
			const { relay, call, state, message, customTypes, notices, select } = make();
			state("worker", 1);
			message(user("go"));
			select({ provider: "faux", id: "small" });
			relay.onModelSelect({ provider: "faux", id: "small" }, call);
			expect(customTypes().at(-1)).toBe("relay.pause");
			expect(notices.at(-1)).toEqual({ text: "relay paused (worker phase, round 1)", level: "warning" });
			select({ provider: RELAY_PROVIDER, id: RELAY_MODEL });
			relay.onModelSelect({ provider: RELAY_PROVIDER, id: RELAY_MODEL }, call);
			expect(customTypes().at(-1)).toBe("relay.resume");
			// Nothing to pause in the lead's phase.
			const lead = make();
			lead.state("lead", 0);
			lead.relay.onModelSelect({ provider: "faux", id: "small" }, lead.call);
			expect(lead.customTypes()).toEqual([VIRTUAL_MODEL_STATE_ENTRY]);
		});
	});

	describe("tools and prompt", () => {
		it("re-registers the tools as direct tools when codemode is off, and activates them only while relay is selected", () => {
			const { relay, call, registered, activeTools, select, setActive } = make();
			relay.onBeforeAgentStart(call);
			expect(registered.at(-1)?.map((spec) => spec.exposure)).toEqual(["direct", "direct"]);
			expect(activeTools()).toEqual(["read", "handover", "handback"]);
			select({ provider: "faux", id: "small" });
			relay.onModelSelect({ provider: "faux", id: "small" }, call);
			expect(activeTools()).toEqual(["read"]);
			// Codemode on again: back to deferred tools.
			setActive(["read", "codemode"]);
			relay.onBeforeAgentStart(call);
			expect(registered.at(-1)?.map((spec) => spec.exposure)).toEqual(["deferred", "deferred"]);
		});

		it("gives the role section of the stored phase, none for another model, and leaves the prompt alone on bad settings", () => {
			const { relay, call, state, select, models } = make({ lead: "faux/large", worker: "faux/small" });
			models.set("faux/large", { id: "large" } as Model<Api>);
			state("lead", 0);
			expect(relay.section(call)?.text).toContain('<relay role="lead">');
			state("worker", 1);
			expect(relay.section(call)?.text).toContain('<relay role="worker">');
			select({ provider: "faux", id: "small" });
			expect(relay.section(call)).toEqual({ text: undefined });
			// Wrong settings with relay selected: the prompt is left alone (the router reports the error).
			const broken = make({ lead: 3 });
			expect(broken.relay.section(broken.call)).toBeUndefined();
		});

		it("records a hand tool called directly while codemode is on, and ignores nested calls and other tools", () => {
			const { relay, call, customTypes, notices, state } = make();
			state("lead", 0);
			relay.onDirectCall({ name: "echo" }, call);
			relay.onDirectCall({ name: "handover", parentToolCallId: "p" }, call);
			expect(customTypes()).toEqual([VIRTUAL_MODEL_STATE_ENTRY]);
			relay.onDirectCall({ name: "handover" }, call);
			expect(customTypes().at(-1)).toBe("relay.direct");
			expect(notices.at(-1)).toEqual({
				text: "relay: direct handover(...) run as a codemode call",
				level: "warning",
			});
		});
	});

	describe("commands", () => {
		it("/handover starts the worker with the user's message, and refuses while the lead is running", async () => {
			const { relay, call, sent, notices, setIdle, customTypes } = make();
			setIdle(false);
			await relay.commands.handover("fix it", call);
			expect(notices.at(-1)?.text).toBe("relay: wait for the lead to finish, or stop it first");
			setIdle(true);
			await relay.commands.handover("fix it", call);
			expect(customTypes()).toEqual([HANDOVER_ENTRY]);
			expect(sent[0].content).toBe(
				"<relay-handover-by-user>\nThe user gives the work to the worker model directly (round 1): fix it",
			);
		});

		it("/handback steers the worker, and the lead has nothing to hand back", () => {
			const lead = make();
			lead.state("lead", 0);
			lead.relay.commands.handback(lead.call);
			expect(lead.notices.at(-1)).toEqual({ text: "relay: The lead already has the work.", level: "warning" });
			const worker = make();
			worker.state("worker", 1);
			worker.relay.commands.handback(worker.call);
			expect(worker.sent[0].deliverAs).toBe("steer");
		});

		it("/relay reports who has the work, and an error for wrong settings", () => {
			const { relay, call, state } = make();
			state("worker", 2);
			expect(relay.commands.status(call)).toMatchObject({ level: "info" });
			expect(relay.commands.status(call).text).toContain(
				"worker has the work, round 2. lead faux/large, worker faux/small",
			);
			const broken = make({ lead: 3 });
			expect(broken.relay.commands.status(broken.call)).toEqual({
				text: 'relay: relay.lead must be "provider/model", got 3',
				level: "error",
			});
		});
	});
});
