import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { branchOf, clean, READ_MAX, readTail, transcriptItems } from "../src/lib/transcript.ts";

const line = (o: object) => `${JSON.stringify(o)}\n`;
function session(): string {
	return [
		line({ type: "session", id: "s0", cwd: "/w" }),
		line({ type: "message", id: "m1", parentId: "s0", message: { role: "system", content: "sys" } }),
		line({
			type: "message",
			id: "m2",
			parentId: "m1",
			message: { role: "user", content: [{ type: "text", text: "fix the test" }] },
		}),
		line({
			type: "message",
			id: "m3",
			parentId: "m2",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hm" },
					{ type: "text", text: "Looking.\u001b[31m" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
				],
			},
		}),
		line({
			type: "message",
			id: "m4",
			parentId: "m3",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "1\n2\n3\n4\n5" }],
				isError: true,
			},
		}),
		// an abandoned branch
		line({
			type: "message",
			id: "x1",
			parentId: "m2",
			message: { role: "assistant", content: [{ type: "text", text: "old branch" }] },
		}),
		line({
			type: "custom_message",
			id: "c1",
			parentId: "m4",
			customType: "roost",
			content: "message from main",
			display: true,
		}),
		line({
			type: "message",
			id: "m5",
			parentId: "c1",
			message: { role: "assistant", content: [{ type: "text", text: "Done: all green" }] },
		}),
	].join("");
}

describe("M19: transcripts", () => {
	it("reads the current branch: prompts, replies, tool calls with results, notes; no escapes", () => {
		expect(branchOf(session()).map((e) => e.id)).toEqual(["m1", "m2", "m3", "m4", "c1", "m5"]);
		const items = transcriptItems(session());
		expect(items).toEqual([
			{ kind: "user", text: "fix the test" },
			{ kind: "assistant", text: "Looking." },
			{ kind: "tool", name: "bash", args: "npm test", result: "1\n2\n3\n4\n5", error: true },
			{ kind: "note", text: "message from main" },
			{ kind: "assistant", text: "Done: all green" },
		]);
		expect(clean("a\u001b]8;;x\u0007b\u0007c\r\nd\te")).toBe("abc\nd  e");
		// a cut first line and a half-written last one are skipped
		const cut = transcriptItems(`garbage"}\n${session()}{"type":"mess`, true);
		expect(cut[0]).toEqual({ kind: "note", text: "earlier messages are not shown" });
		expect(cut.at(-1)).toEqual({ kind: "assistant", text: "Done: all green" });
	});

	it("reads a long file's tail from a whole line", () => {
		const dir = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}tail-`));
		const f = join(dir, "s.jsonl");
		const pad = line({
			type: "message",
			id: "p",
			parentId: null,
			message: { role: "user", content: "x".repeat(1000) },
		});
		const body = session();
		// the tail starts exactly at a line's start: that line is kept
		writeFileSync(f, `${"y".repeat(10)}\n${pad.repeat(Math.ceil(READ_MAX / pad.length))}${body}`);
		const t = readTail(f);
		expect(t.truncated).toBe(true);
		expect(t.text.endsWith(body)).toBe(true);
		expect(t.text.startsWith("{")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});
