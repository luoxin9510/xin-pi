// The subagent screen against a hand-written child session file, no pi and no model: what it draws, how it scrolls,
// what its input line does. The real terminal is covered in test/tui/.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { SubagentScreen } from "../../../src/extensions/subagent/subagent-screen.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

initTheme("dark");
const theme: any = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
const ROWS = 14;
const tui: any = { terminal: { rows: ROWS }, requestRender() {} };

const line = (o: object) => JSON.stringify(o) + "\n";
const zero = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (id: string, parentId: string, content: unknown[]) =>
	line({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: {
			role: "assistant",
			content,
			api: "x",
			provider: "x",
			model: "x",
			usage: zero,
			stopReason: "stop",
			timestamp: 1,
		},
	});

function setup(sessionId: string, agentId: string) {
	const dir = mkdtempSync(join(tmpdir(), "subagent-screen-"));
	const file = join(dir, `2026-01-01T00-00-00-000Z_${agentId}.jsonl`);
	writeFileSync(
		file,
		line({ type: "session", version: 3, id: agentId, timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" }),
	);
	appendFileSync(
		file,
		line({
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: { role: "user", content: "FIRST-TASK-TEXT", timestamp: 1 },
		}),
	);
	registry.begin({ thinking: "off", cwd: "/tmp", trusted: true, sessionId } as any, {
		id: agentId,
		type: "Explore",
		description: "look",
		model: "m",
		thinking: "off",
	});
	// an in-memory parent has no session dir; point the record at our directory
	(registry as any).records.get(agentId).sessionDir = dir;
	let left = 0;
	const idle = { value: false };
	const screen = new SubagentScreen(
		tui,
		theme,
		agentId,
		() => idle.value,
		{ cwd: "/tmp" } as any,
		() => left++,
	);
	// The running child reports what it appended (a turn's end, say); the screen then reads the file again.
	const grew = () => registry.event(agentId, { type: "turn_end" });
	return { screen, file, left: () => left, idle, grew, agentId };
}

test("header, the user task, a codemode call with its script and result, and live growth from the file", () => {
	const { screen, file, idle, grew } = setup("s1", "agent1");
	let text = screen.render(100).join("\n");
	assert.match(text, /main › Explore\(look\)/);
	assert.match(text, /main: running/);
	assert.match(text, /FIRST-TASK-TEXT/);
	assert.doesNotMatch(text, /tools\.bash/);

	appendFileSync(
		file,
		assistant("a1", "u1", [
			{
				type: "toolCall",
				id: "c1",
				name: "codemode",
				arguments: { code: "const a = await tools.bash({command: 'ls'});\nreturn a;" },
			},
		]),
	);
	grew();
	text = screen.render(100).join("\n");
	assert.match(text, /codemode/);
	assert.match(text, /const a = await tools\.bash/);
	assert.doesNotMatch(text, /code:/, "the script is shown as code, not as a field");
	assert.match(text, /‹ main/);
	const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plain, /\n return a;\s*\n/, "the script keeps its line breaks");

	appendFileSync(
		file,
		line({
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "codemode",
				content: [{ type: "text", text: "Script completed OUT-123" }],
				isError: false,
				timestamp: 2,
			},
		}),
	);
	appendFileSync(file, assistant("a2", "r1", [{ type: "text", text: "ALL-DONE-REPLY" }]));
	grew();
	text = screen.render(100).join("\n");
	assert.match(text, /OUT-123/);
	assert.match(text, /ALL-DONE-REPLY/);
	idle.value = true;
	assert.match(screen.render(100)[0]!, /main: idle/);
	screen.dispose();
});

test("the screen is exactly the terminal height; scrolling reaches earlier lines and End follows again", () => {
	const { screen, file, grew } = setup("s2", "agent2");
	let parent = "u1";
	for (let i = 0; i < 12; i++) {
		appendFileSync(file, assistant(`m${i}`, parent, [{ type: "text", text: `REPLY-${i}` }]));
		parent = `m${i}`;
	}
	grew();
	let lines = screen.render(100);
	assert.equal(lines.length, ROWS);
	assert.ok(lines.join("\n").includes("REPLY-11"));
	assert.ok(!lines.join("\n").includes("FIRST-TASK-TEXT"));
	for (let i = 0; i < 6; i++) screen.handleInput("\x1b[5~"); // page up
	lines = screen.render(100);
	assert.ok(lines.join("\n").includes("FIRST-TASK-TEXT"), "page up reaches the task");
	assert.match(lines.at(-1)!, /lines above the end/);
	screen.handleInput("\x1b[F"); // end
	assert.ok(screen.render(100).join("\n").includes("REPLY-11"));
	screen.handleInput("\x1b[A"); // up one line
	assert.match(screen.render(100).at(-1)!, /1 lines above the end/);
	screen.dispose();
});

test("/main and Esc leave; other slash commands only show a notice", () => {
	const { screen, left } = setup("s3", "agent3");
	const type = (s: string) => {
		for (const ch of s) screen.handleInput(ch);
		screen.handleInput("\r");
	};
	type("/nonsense");
	assert.match(screen.render(100).at(-1)!, /\/nonsense is not available on a subagent screen/);
	assert.equal(left(), 0);
	type("/main");
	assert.equal(left(), 1);
	screen.handleInput("\x1b");
	assert.equal(left(), 2);
	screen.dispose();
});

const update = (u: object) => ({ type: "message_update", assistantMessageEvent: u });
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("a running child's message streams onto the screen token by token, before the message ends; the file then takes over", () => {
	const { screen, file, agentId } = setup("s4", "agent4");
	const event = (e: object) => registry.event(agentId, e as any);
	event({ type: "message_start", message: { role: "assistant" } });
	event(update({ type: "text_start", contentIndex: 0 }));
	event(update({ type: "text_delta", contentIndex: 0, delta: "STREAM-ONE " }));
	assert.match(screen.render(100).join("\n"), /STREAM-ONE/);
	event(update({ type: "text_delta", contentIndex: 0, delta: "STREAM-TWO" }));
	const midway = screen.render(100).join("\n");
	assert.match(midway, /STREAM-ONE STREAM-TWO/);
	assert.match(midway, /FIRST-TASK-TEXT/, "the history stays above it");

	// a tool call shows once its arguments are complete
	event(
		update({
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { id: "c9", name: "codemode", arguments: { code: "return 'LIVE-SCRIPT';" } },
		}),
	);
	assert.match(screen.render(100).join("\n"), /LIVE-SCRIPT/);

	// the message ends: it is in the file now, and drawn once
	appendFileSync(file, assistant("a1", "u1", [{ type: "text", text: "STREAM-ONE STREAM-TWO" }]));
	event({ type: "message_end", message: { role: "assistant" } });
	const after = screen.render(100).join("\n");
	assert.equal(count(after, "STREAM-ONE"), 1, after);
	assert.doesNotMatch(after, /LIVE-SCRIPT/);
	screen.dispose();
});

test("a screen opened in the middle of a message shows what was written so far; a disposed screen stops watching", () => {
	const first = setup("s5", "agent5");
	first.screen.dispose();
	const event = (e: object) => registry.event("agent5", e as any);
	event({ type: "message_start", message: { role: "assistant" } });
	event(update({ type: "thinking_delta", contentIndex: 0, delta: "pondering" }));
	event(update({ type: "text_delta", contentIndex: 1, delta: "HALF-WRITTEN" }));
	const late = new SubagentScreen(
		tui,
		theme,
		"agent5",
		() => true,
		{ cwd: "/tmp" } as any,
		() => {},
	);
	assert.match(late.render(100).join("\n"), /HALF-WRITTEN/);
	late.dispose();
	assert.equal((registry as any).watchers.get("agent5").size, 0, "no watcher left behind");
	event({ type: "message_end", message: { role: "assistant" } });
});
