// Agent teams, UI (spec "UI"): the teammate rows of the panel, `x` in any state, what typing on a teammate's screen does,
// Esc interrupting without stopping, the agent-message lines, the /tasks overlay and its key. The team is the real one
// (team.ts) with a stub host and fake children, no pi and no model; the real terminal is covered in test/subagent/tui/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { Panel } from "../../../src/extensions/subagent/panel.ts";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { emptyUsage, type RunResult } from "../../../src/extensions/subagent/runner.ts";
import { SubagentScreen, transcriptParts } from "../../../src/extensions/subagent/subagent-screen.ts";
import { type Member, teams } from "../../../src/extensions/subagent/team.ts";
import { readTeamSettings } from "../../../src/extensions/subagent/team-config.ts";
import { inboxFile, newEntryId, peekEntries } from "../../../src/extensions/subagent/team-files.ts";
import { joinEnvelopes, splitEnvelopes } from "../../../src/extensions/subagent/team-text.ts";
import { TasksScreen } from "../../../src/extensions/subagent/team-ui.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { parent, settle } from "./team-helpers.ts";

initTheme("dark");
const theme: any = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => `[sel]${s}`,
	bold: (s: string) => s,
};
const tui = {
	terminal: { rows: 20 },
	renders: 0,
	requestRender() {
		this.renders++;
	},
} as any;
const KEY = { down: "\x1b[B", up: "\x1b[A", esc: "\x1b", enter: "\r" };

const run = (output: string, extra: Partial<RunResult> = {}): RunResult => ({
	status: "completed",
	output,
	usage: emptyUsage(),
	turns: 1,
	durationMs: 1,
	aborted: false,
	...extra,
});

interface Wake {
	name: string;
	prompt: () => string;
	signal: AbortSignal;
	finish: () => void;
}
interface Child {
	id: string;
	sent: { type: string; message?: string }[];
	accept: boolean;
	take(text: string): void;
}

let n = 0;
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
	for (const c of cleanups.splice(0)) await c().catch(() => {});
});

// A team made through `teams` (the panel and the screens read it there), with the agent dir in a temp directory.
function setup(label: string) {
	const sessionId = `ui-${label}-${++n}`;
	const base = mkdtempSync(join(tmpdir(), "team-ui-"));
	process.env.XPI_CODING_AGENT_DIR = base;
	const toLead: string[] = [];
	const warns: string[] = [];
	const wakes: Wake[] = [];
	const events = createEventBus();
	const idleEvents: unknown[] = [];
	events.on("agent-teams:teammate_idle", (p) => idleEvents.push(p));
	teams.configure({
		settings: readTeamSettings({ enabled: true }),
		events,
		parent: () => parent(sessionId),
		toLead: (c) => (toLead.push(c), true),
		warn: (m) => warns.push(m),
		wake: (member: Member, prompt: () => string, signal: AbortSignal) =>
			new Promise<void>((resolve, reject) => {
				wakes.push({ name: member.name, prompt, signal, finish: resolve });
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	});
	const team = teams.ensure();
	cleanups.push(async () => {
		team.beginClose();
		await team.finishClose();
		teams.configure(undefined);
	});
	// A teammate with a record and a fake child that takes commands; `running` once its exchange began.
	const mate = (
		name: string,
		status: "running" | "idle" = "running",
		record: "completed" | "failed" = "completed",
	) => {
		const id = `${name}-id`;
		team.addMember(name, id, "general-purpose", status === "idle" ? "idle" : "queued");
		registry.begin(parent(sessionId), {
			id,
			type: "general-purpose",
			name,
			description: "d",
			model: "m",
			thinking: "off",
			teammate: true,
			team: team.name,
		} as any);
		const sent: Child["sent"] = [];
		const child: Child = {
			id,
			sent,
			accept: true,
			take: (text) => registry.event(id, { type: "message_end", message: { role: "user", content: text } }),
		};
		registry.attach(id, {
			send: (c: unknown) => (child.accept ? (sent.push(c as any), true) : false),
			setModel: async () => undefined,
		} as any);
		if (status === "idle") {
			registry.finish(id, record, run("x"));
			return Object.assign(child, { end: () => Promise.resolve("idle" as const) });
		}
		team.exchangeBegan(name);
		return Object.assign(child, {
			end: (extra: Partial<RunResult> = {}, o: { interrupted?: boolean; userStopped?: boolean } = {}) =>
				team.exchangeEnded(name, { run: run("done", extra), ...o }),
		});
	};
	const task = (id: string, fields: Record<string, unknown>) => {
		mkdirSync(team.tasksDir, { recursive: true });
		writeFileSync(
			join(team.tasksDir, `${id}.json`),
			JSON.stringify({
				id,
				subject: `subject ${id}`,
				description: "",
				status: "pending",
				blockedBy: [],
				createdBy: "lead",
				createdAt: 1,
				updatedAt: 1,
				...fields,
			}),
		);
	};
	const say = (from: string, to: string, text: string) =>
		import("../../../src/extensions/subagent/team-files.ts").then((f) =>
			f.appendEntry(inboxFile(team.dir, to), { id: newEntryId(), from, to, text, kind: "message", at: Date.now() }),
		);
	return { sessionId, team, toLead, warns, wakes, events, idleEvents, mate, task, say, base };
}

function panelOf(sessionId: string, lingerMs = 30_000) {
	const opened: string[] = [];
	const panel = new Panel(
		sessionId,
		theme,
		() => {},
		(r) => opened.push(r.id),
		{ lingerMs, viewable: true },
	);
	return { panel, opened };
}

const lineOf = (text: string, name: string) => text.split("\n").find((l) => l.includes(name)) ?? "";

test("panel: a teammate row shows its state, name and the subject of the task it owns; every state has its own mark", () => {
	const x = setup("rows");
	x.mate("runner");
	x.mate("sleeper", "idle");
	x.mate("broken", "idle", "failed");
	x.team.addMember("waiting", "waiting-id", "general-purpose", "queued"); // its first start: no record yet
	x.task("1", { subject: "write the parser", owner: "runner", status: "in_progress" });
	x.task("2", { subject: "later work", owner: "runner", status: "pending" });
	const { panel } = panelOf(x.sessionId);
	const text = panel.render(160).join("\n");
	assert.match(lineOf(text, "runner"), /● running · runner \(general-purpose\) · task: write the parser · 0 turns/);
	assert.match(lineOf(text, "sleeper"), /○ idle · sleeper/);
	assert.match(lineOf(text, "broken"), /✗ failed · broken/);
	assert.match(lineOf(text, "waiting"), /◌ queued · waiting/);
	assert.doesNotMatch(lineOf(text, "sleeper"), /task:/, "no owned task, no subject");
	// stopping has its own icon and colour too
	x.team.markShutdownRequested("runner");
	(x.team as any).shutdownResponse({ from: "runner", approve: true });
	assert.match(panel.render(160).join("\n"), /◍ stopping · runner/);
	panel.dispose();
});

test("panel: teammate rows that are not stopped never hide; stopped ones go after the linger", async () => {
	const x = setup("linger");
	const a = x.mate("alive");
	x.mate("napping", "idle");
	x.mate("gone", "idle");
	x.team.stop("gone");
	const { panel } = panelOf(x.sessionId, 120);
	assert.match(panel.render(160).join("\n"), /■ stopped · gone/);
	await settle(400);
	const later = panel.render(160).join("\n");
	assert.match(later, /● running · alive/);
	assert.match(later, /○ idle · napping/, "an idle teammate stays long after its exchange ended");
	assert.doesNotMatch(later, /gone/, "a stopped one lingers like any finished row, then leaves");
	await a.end();
	await settle(300);
	assert.match(panel.render(160).join("\n"), /○ idle · alive/, "idle after its run, still listed");
	panel.dispose();
});

test("panel: the row of a state change is redrawn at once (queued to running to idle)", async () => {
	const x = setup("redraw");
	let renders = 0;
	const panel = new Panel(
		x.sessionId,
		theme,
		() => renders++,
		() => {},
		{ lingerMs: 30_000, viewable: true },
	);
	const before = renders;
	x.team.addMember("w", "w-id", "general-purpose", "queued");
	assert.ok(renders > before, "a new member asks for a redraw");
	assert.match(panel.render(100).join("\n"), /◌ queued · w/);
	panel.dispose();
});

test("panel: arrows select a teammate row, Enter opens it, and x stops an idle teammate (no process)", async () => {
	const x = setup("keys");
	x.mate("sleeper", "idle");
	const { panel, opened } = panelOf(x.sessionId);
	assert.equal(panel.handleKey(KEY.down, true), true);
	assert.equal(panel.handleKey(KEY.enter, true), true);
	assert.deepEqual(opened, ["sleeper-id"]);
	assert.equal(panel.handleKey("x", true), true);
	assert.equal(x.team.members.get("sleeper")!.status, "stopped");
	assert.equal(registry.get("sleeper-id")!.status, "stopped", "its record is closed");
	assert.match(panel.render(100).join("\n"), /■ stopped · sleeper/);
	assert.deepEqual(x.toLead, ['Teammate "sleeper" was stopped.']);
	await x.team.deliverNow();
	assert.equal(x.wakes.length, 0);
	panel.dispose();
});

test("x on a teammate queued for its first start aborts its wait; the teammate ends stopped, with no warning", async () => {
	const x = setup("xqueued");
	x.team.addMember("w", "w-id", "general-purpose", "queued");
	const controller = new AbortController();
	registry.detach("w-id", x.sessionId, controller);
	const { panel } = panelOf(x.sessionId);
	panel.handleKey(KEY.down, true);
	panel.handleKey("x", true);
	assert.equal(controller.signal.aborted, true, "the exchange waiting for a slot is aborted");
	x.team.exchangeAbandoned("w", new Error("aborted")); // what exchange.ts does when its wait is aborted
	assert.equal(x.team.members.get("w")!.status, "stopped");
	assert.deepEqual(x.warns, []);
	panel.dispose();
});

test("x on an idle teammate that is waiting for a slot (woken): the wake is aborted and it ends stopped", async () => {
	const x = setup("xwoken");
	x.mate("a", "idle");
	await x.say("b", "a", "wake up");
	await x.team.deliverNow();
	assert.equal(x.team.members.get("a")!.status, "queued");
	assert.equal(x.wakes.length, 1);
	assert.equal(x.team.stop("a"), true);
	assert.equal(x.wakes[0]!.signal.aborted, true);
	await settle();
	assert.equal(x.team.members.get("a")!.status, "stopped");
	assert.deepEqual(x.warns, [], "what the user asked for is no failure");
	assert.deepEqual(x.toLead, ['Teammate "a" was stopped.']);
});

test("x on a running teammate sends the abort and shows stopping; its end is stopped", async () => {
	const x = setup("xrunning");
	const a = x.mate("a");
	assert.equal(x.team.stop("a"), true);
	assert.deepEqual(a.sent, [{ type: "abort" }]);
	assert.equal(x.team.members.get("a")!.status, "stopping");
	assert.equal(await a.end({ aborted: true }, { userStopped: true }), "stopped");
	assert.equal(x.team.stop("a"), false, "nothing more to stop");
});

// --- typing

test("typing to a running teammate steers it with the text as typed (user authority), through no mailbox file", async () => {
	const x = setup("typing");
	const a = x.mate("a");
	assert.equal(x.team.say("a", "stop and look at the tests"), "steered");
	assert.deepEqual(a.sent, [{ type: "steer", message: "stop and look at the tests" }]);
	assert.doesNotMatch(a.sent[0]!.message!, /agent-message/, "no envelope: it is the user's own text");
	assert.deepEqual(peekEntries(inboxFile(x.team.dir, "a")), [], "no inbox entry");
	await x.team.deliverNow();
	assert.equal(a.sent.length, 1, "delivered once");
});

test("typing to an idle teammate starts a new exchange with the text as typed; one idle notice for it", async () => {
	const x = setup("typing-idle");
	x.mate("a", "idle");
	assert.equal(x.team.say("a", "please redo it"), "started");
	assert.equal(x.wakes.length, 1);
	assert.equal(x.wakes[0]!.prompt(), "please redo it");
	assert.equal(x.team.members.get("a")!.status, "queued");
	assert.deepEqual(peekEntries(inboxFile(x.team.dir, "a")), []);
	// a message from a teammate that arrives while the exchange waits joins it, after the typed text
	await x.say("b", "a", "fyi");
	await x.team.deliverNow();
	const prompt = x.wakes[0]!.prompt();
	assert.ok(prompt.startsWith("please redo it\n\n<agent-message"), prompt);
	assert.match(prompt, /fyi/);
	x.wakes[0]!.finish();
});

test("typing resets the loop count: after five wakes by teammates a sixth message is held, and a typed message releases it", async () => {
	const x = setup("typing-loop");
	x.mate("a", "idle");
	const cycle = async (text: string) => {
		await x.say("b", "a", text);
		await x.team.deliverNow();
		const w = x.wakes.at(-1)!;
		x.team.exchangeBegan("a");
		await x.team.exchangeEnded("a", { run: run("ok") });
		w.finish();
		await settle(10);
	};
	for (let i = 0; i < 5; i++) await cycle(`m${i}`);
	const woken = x.wakes.length;
	assert.equal(woken, 5);
	await x.say("b", "a", "m5");
	await x.team.deliverNow();
	assert.equal(x.wakes.length, woken, "the sixth is held");
	// the user types: a new exchange, and the count starts again
	x.team.say("a", "carry on");
	assert.equal(x.wakes.length, woken + 1);
	x.team.exchangeBegan("a");
	await x.team.exchangeEnded("a", { run: run("ok") });
	await x.team.deliverNow(); // the held message is not held any more
	assert.equal(x.wakes.length, woken + 2, "the teammate's message wakes it again");
});

test("typed text the child settled without taking becomes a new exchange; nothing is lost and no inbox file is written", async () => {
	const x = setup("typing-race");
	const a = x.mate("a");
	assert.equal(x.team.say("a", "too late"), "steered");
	// no user message_end: the child's run ended before it read the steer
	assert.equal(await a.end(), "idle");
	assert.equal(x.wakes.length, 1, "a new exchange for it");
	assert.equal(x.wakes[0]!.prompt(), "too late");
	assert.deepEqual(peekEntries(inboxFile(x.team.dir, "a")), []);
	x.wakes[0]!.finish();
});

test("typed text the child did take is not delivered again", async () => {
	const x = setup("typing-taken");
	const a = x.mate("a");
	x.team.say("a", "hello there");
	a.take("hello there");
	await a.end();
	assert.equal(x.wakes.length, 0);
});

test("typing before the child is up (or when it takes no command) waits and is steered once it can", async () => {
	const x = setup("typing-wait");
	const a = x.mate("a");
	a.accept = false;
	assert.equal(x.team.say("a", "first"), "queued");
	a.accept = true;
	await x.team.deliverNow();
	assert.deepEqual(a.sent, [{ type: "steer", message: "first" }]);
});

test("typing to a teammate that is stopped or stopping is refused", async () => {
	const x = setup("typing-stopped");
	x.mate("a", "idle");
	x.team.stop("a");
	assert.throws(() => x.team.say("a", "hi"), /a is stopped: it takes no messages/);
	assert.throws(() => x.team.say("nobody", "hi"), /no teammate "nobody"/);
});

// --- Esc

test("interrupt: the teammate's turn is aborted, it becomes idle, sends no idle notice and fires no teammate_idle, and a message still wakes it", async () => {
	const x = setup("interrupt");
	const a = x.mate("a");
	assert.equal(x.team.interrupt("a"), true);
	assert.deepEqual(a.sent, [{ type: "abort" }]);
	assert.equal(registry.interruptRequested("a-id"), true, "the registry knows it is an interrupt");
	registry.interrupt("a-id"); // (the check above consumed the flag: set it again for the real end)
	assert.equal(await a.end({ aborted: true }, { interrupted: true }), "idle");
	await x.team.deliverNow();
	assert.equal(x.team.members.get("a")!.status, "idle");
	assert.deepEqual(x.toLead, [], "no idle notice, no stopped notice");
	assert.deepEqual(x.idleEvents, [], "no teammate_idle");
	assert.deepEqual(peekEntries(inboxFile(x.team.dir, "lead")), []);
	await x.say("b", "a", "ping");
	await x.team.deliverNow();
	assert.equal(x.wakes.length, 1, "still woken by messages");
	x.wakes[0]!.finish();
});

test("an interrupt of a teammate that is not running does nothing; an ordinary end still sends the notice and the event", async () => {
	const x = setup("interrupt-guard");
	x.mate("idler", "idle");
	assert.equal(x.team.interrupt("idler"), false);
	const a = x.mate("a");
	assert.equal(await a.end(), "idle");
	await x.team.deliverNow();
	assert.equal(x.idleEvents.length, 1, "the guard: without an interrupt the hook fires");
	assert.match(peekEntries(inboxFile(x.team.dir, "lead")).length === 0 ? x.toLead.join("") : "", /is idle/);
});

test("interrupt keeps what the user typed meanwhile: it starts a new exchange when the turn is over", async () => {
	const x = setup("interrupt-typed");
	const a = x.mate("a");
	assert.equal(x.team.interrupt("a"), true);
	a.accept = false; // the child is going away: it takes nothing more
	assert.equal(x.team.say("a", "after the interrupt"), "queued");
	assert.equal(await a.end({ aborted: true }, { interrupted: true }), "idle");
	assert.equal(x.wakes.length, 1);
	assert.equal(x.wakes[0]!.prompt(), "after the interrupt");
});

// --- the screen

function screenOf(name: string) {
	let left = 0;
	const screen = new SubagentScreen(
		tui,
		theme,
		`${name}-id`,
		() => true,
		{ cwd: "/tmp" } as any,
		() => left++,
	);
	return { screen, left: () => left };
}

test("screen: Esc on a running teammate interrupts it and a second Esc closes; Esc while idle closes", async () => {
	const x = setup("screen-esc");
	const a = x.mate("a");
	const { screen, left } = screenOf("a");
	screen.handleInput(KEY.esc);
	assert.deepEqual(a.sent, [{ type: "abort" }], "the first Esc interrupts");
	assert.equal(left(), 0, "and does not close");
	assert.match(screen.render(100).join("\n"), /interrupted: the teammate is idle after this turn/);
	screen.handleInput(KEY.esc);
	assert.equal(left(), 1, "the second Esc closes");
	assert.equal(a.sent.length, 1, "without a second abort");
	screen.dispose();

	const idler = x.mate("sleeper", "idle");
	const again = screenOf("sleeper");
	again.screen.handleInput(KEY.esc);
	assert.equal(again.left(), 1, "idle: Esc closes");
	assert.equal(idler.sent.length, 0);
	again.screen.dispose();
});

test("screen: after the interrupt lands, the next Esc closes; the header names the teammate's state", async () => {
	const x = setup("screen-state");
	const a = x.mate("a");
	const { screen, left } = screenOf("a");
	assert.match(screen.render(120).join("\n"), /● running/);
	screen.handleInput(KEY.esc);
	registry.interrupt("a-id");
	await a.end({ aborted: true }, { interrupted: true });
	assert.match(screen.render(120).join("\n"), /○ idle/);
	screen.handleInput(KEY.esc);
	assert.equal(left(), 1);
	screen.dispose();
});

test("screen: typing goes to the team (steer while running, new exchange when idle), never to the inbox file", async () => {
	const x = setup("screen-type");
	const a = x.mate("a");
	const s = screenOf("a");
	for (const ch of "check it") s.screen.handleInput(ch);
	s.screen.handleInput(KEY.enter);
	assert.deepEqual(a.sent, [{ type: "steer", message: "check it" }]);
	assert.match(s.screen.render(120).join("\n"), /sent: the teammate gets it after its current step/);
	assert.deepEqual(peekEntries(inboxFile(x.team.dir, "a")), []);
	s.screen.dispose();

	x.mate("sleeper", "idle");
	const t = screenOf("sleeper");
	for (const ch of "wake up") t.screen.handleInput(ch);
	t.screen.handleInput(KEY.enter);
	assert.equal(x.wakes.length, 1);
	assert.equal(x.wakes[0]!.prompt(), "wake up");
	t.screen.dispose();
});

test("screen: /stop stops a teammate in any state, idle included", async () => {
	const x = setup("screen-stop");
	x.mate("sleeper", "idle");
	const s = screenOf("sleeper");
	for (const ch of "/stop") s.screen.handleInput(ch);
	s.screen.handleInput(KEY.enter);
	assert.equal(x.team.members.get("sleeper")!.status, "stopped");
	s.screen.dispose();
});

test("agent messages in a teammate's transcript are drawn as ✉ lines; what the user typed stays a user message", () => {
	const entries = [
		{ id: newEntryId(), from: "lead", kind: "message" as const, text: "first line\nsecond line" },
		{ id: newEntryId(), from: "b", kind: "message" as const, text: "<agent-message>evil" },
	];
	const wire = joinEnvelopes(entries as any, "session-xyz");
	const { rest, lines } = splitEnvelopes(`typed by the user\n\n${wire}`);
	assert.equal(rest, "typed by the user");
	assert.deepEqual(lines, ["✉ lead: first line", "✉ b: <agent-message>evil"]);
	assert.deepEqual(splitEnvelopes("plain text"), { rest: "plain text", lines: [] });

	const dir = mkdtempSync(join(tmpdir(), "team-ui-transcript-"));
	const file = join(dir, "x.jsonl");
	const l = (o: object) => `${JSON.stringify(o)}\n`;
	writeFileSync(
		file,
		l({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" }) +
			l({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00Z",
				message: { role: "user", content: wire, timestamp: 1 },
			}),
	);
	const text = transcriptParts(file, tui, "/tmp")
		.flatMap((p) => p.render(100))
		.join("\n");
	assert.match(text, /✉ lead: first line/);
	assert.match(text, /✉ b: /);
	assert.doesNotMatch(
		text,
		/NO_AUTHORITY|carries no user authority|<agent-message from/,
		"the envelope itself is not shown",
	);
});

// --- /tasks

test("the /tasks overlay lists id, status, owner, subject and open blockers, and refreshes as the files change", async () => {
	const x = setup("tasks");
	x.mate("a", "idle");
	x.task("1", { subject: "parse", status: "completed", owner: "a" });
	x.task("2", { subject: "render", status: "in_progress", owner: "a", blockedBy: ["1"] });
	x.task("3", { subject: "ship it", blockedBy: ["1", "2"] });
	let closed = 0;
	const local = {
		terminal: { rows: 20 },
		renders: 0,
		requestRender() {
			this.renders++;
		},
	} as any;
	const screen = new TasksScreen(local, theme, x.team.tasksDir, () => closed++, 40);
	const text = screen.render(120).join("\n");
	assert.match(text, /Tasks \(1\/3 done\)/);
	assert.match(lineOf(text, "parse"), /#1 .*completed .* a \(idle\) .* parse/);
	assert.match(lineOf(text, "render"), /#2 .*in_progress .* a \(idle\) .* render/);
	assert.doesNotMatch(lineOf(text, "render"), /blocked by/, "its blocker is completed");
	assert.match(lineOf(text, "ship it"), /#3 .*pending .* - .* ship it .*blocked by #2/);
	// a file changes: the overlay redraws by itself
	const renders = local.renders;
	x.task("2", { subject: "render", status: "completed", owner: "a", blockedBy: ["1"] });
	x.task("4", { subject: "a new task" });
	await settle(200);
	assert.ok(local.renders > renders, "a redraw was asked for");
	const later = screen.render(120).join("\n");
	assert.match(later, /Tasks \(2\/4 done\)/);
	assert.match(later, /a new task/);
	assert.doesNotMatch(lineOf(later, "ship it"), /blocked by/);
	// the timer stops with the overlay, and Esc closes it
	screen.handleInput(KEY.esc);
	assert.equal(closed, 1);
	screen.dispose();
	const after = local.renders;
	x.task("5", { subject: "after close" });
	await settle(200);
	assert.equal(local.renders, after, "a disposed overlay no longer reads the files");
});

test("the /tasks overlay says so when there are no tasks, and never writes to the task directory", async () => {
	const x = setup("tasks-empty");
	const local = { terminal: { rows: 12 }, requestRender() {} } as any;
	const screen = new TasksScreen(local, theme, x.team.tasksDir, () => {}, 40);
	assert.match(screen.render(100).join("\n"), /no tasks yet/);
	await settle(120);
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(x.team.tasksDir), false, "reading a missing list creates nothing");
	screen.dispose();
});

// --- the key

test("app.team.tasks exists with no default key, and a user binding matches it", () => {
	const dir = mkdtempSync(join(tmpdir(), "team-ui-keys-"));
	const none = KeybindingsManager.create(dir);
	assert.deepEqual(none.getKeys("app.team.tasks" as any), []);
	assert.equal(none.matches("\x14", "app.team.tasks" as any), false, "Ctrl+T stays the thinking toggle");
	assert.equal(none.matches("\x14", "app.thinking.toggle" as any), true);
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.team.tasks": "ctrl+g" }));
	const bound = KeybindingsManager.create(dir);
	assert.deepEqual(bound.getKeys("app.team.tasks" as any), ["ctrl+g"]);
	assert.equal(bound.matches("\x07", "app.team.tasks" as any), true);
});
