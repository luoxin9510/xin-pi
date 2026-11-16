import { describe, expect, it } from "vitest";
import type { AssistantMessage, Message, SystemMessage, ToolResultMessage, UserMessage } from "xpi-ai";
import {
	HANDOVER_SIGNAL,
	handoverIndex,
	handoverResult,
	LEAD_WORK_TAG,
	quoteLeadWork,
	USER_HANDOVER_MARKER,
} from "../src/index.ts";

let clock = 1;
const system = (fields: Partial<SystemMessage> = {}): SystemMessage =>
	({ role: "system", content: "You are xpi.", timestamp: clock++, ...fields }) as SystemMessage;
const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: clock++ });
const assistant = (content: AssistantMessage["content"]): AssistantMessage =>
	({ role: "assistant", content, timestamp: clock++ }) as AssistantMessage;
const result = (toolName: string, content: ToolResultMessage["content"], extra: Partial<ToolResultMessage> = {}) =>
	({
		role: "toolResult",
		toolCallId: "c",
		toolName,
		content,
		isError: false,
		timestamp: clock++,
		...extra,
	}) as ToolResultMessage;
const handoverResultMessage = (round: number) =>
	result("handover", [{ type: "text", text: handoverResult(round) }], {
		signal: { type: HANDOVER_SIGNAL, data: { round } },
	});

/** A lead that reads a file, thinks, and hands round 1 over; then the worker's first reply. */
function leadThenWorker(): Message[] {
	return [
		system({ sections: { relay: "lead section" } }),
		user("fix the parser"),
		assistant([
			{ type: "thinking", thinking: "SECRET lead reasoning" },
			{ type: "text", text: "I will read the parser first." },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/parser.ts" } },
		] as AssistantMessage["content"]),
		result("read", [{ type: "text", text: "export function parse() {}" }]),
		assistant([{ type: "toolCall", id: "c2", name: "handover", arguments: { plan: "add a test" } }]),
		handoverResultMessage(1),
		assistant([{ type: "text", text: "Starting on the plan." }]),
		result("bash", [{ type: "text", text: "ok" }]),
	];
}

const textOf = (message: Message) =>
	typeof message.content === "string"
		? message.content
		: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

describe("quoteLeadWork", () => {
	it("folds everything up to the handover into one user message, keeping the worker's own messages as they are", () => {
		const messages = leadThenWorker();
		const quoted = quoteLeadWork(messages, 1)!;
		expect(quoted.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"]);
		// no assistant message of the lead is left in front of the worker's own
		expect(quoted.slice(0, 2).some((m) => m.role === "assistant")).toBe(false);
		expect(quoted.slice(2)).toEqual(messages.slice(6));
		const quote = textOf(quoted[1]!);
		expect(quote.startsWith(`<${LEAD_WORK_TAG} round="1">`)).toBe(true);
		expect(quote.endsWith(`</${LEAD_WORK_TAG}>`)).toBe(true);
		expect(quote).toContain("User:\nfix the parser");
		expect(quote).toContain("Lead:\nI will read the parser first.");
		expect(quote).toContain('Lead called read: {"path":"src/parser.ts"}');
		expect(quote).toContain("Result of read:\nexport function parse() {}");
		expect(quote).toContain('Lead called handover: {"plan":"add a test"}');
		expect(quote).toContain(handoverResult(1));
		// decision Q2: the lead's thinking is left out
		expect(quote).not.toContain("SECRET");
	});

	it("keeps the prompt and tools of the handover: system patches before it fold into the leading system message", () => {
		const messages = leadThenWorker();
		messages.splice(3, 0, system({ content: "", sections: { relay: "patched" } }));
		const quoted = quoteLeadWork(messages, 1)!;
		expect(quoted[0]!.role).toBe("system");
		expect((quoted[0] as SystemMessage).sections?.relay).toBe("patched");
		expect(quoted.filter((m) => m.role === "system")).toHaveLength(1);
	});

	it("keeps tool results whole, images included (decision Q3)", () => {
		const long = "x".repeat(50_000);
		const messages = leadThenWorker();
		messages[3] = result("read", [
			{ type: "text", text: long },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		const quote = quoteLeadWork(messages, 1)![1] as UserMessage;
		expect(textOf(quote)).toContain(long);
		expect(Array.isArray(quote.content) && quote.content.some((b) => b.type === "image")).toBe(true);
	});

	it("gives the same request every time, so the worker's cached prefix holds", () => {
		const messages = leadThenWorker();
		expect(quoteLeadWork(messages, 1)).toEqual(quoteLeadWork(structuredClone(messages), 1));
		// a later worker request quotes the same prefix
		const later = [...messages, assistant([{ type: "text", text: "done" }])];
		expect(quoteLeadWork(later, 1)!.slice(0, 2)).toEqual(quoteLeadWork(messages, 1)!.slice(0, 2));
	});

	it("finds a handover the user gave with /handover", () => {
		const messages: Message[] = [
			system(),
			user("look at this"),
			assistant([{ type: "text", text: "Here is what I see." }]),
			user(
				`${USER_HANDOVER_MARKER}\nThe user gives the work to the worker model directly (round 1): make the change`,
			),
			assistant([{ type: "text", text: "On it." }]),
		];
		expect(handoverIndex(messages, 1)).toBe(3);
		const quoted = quoteLeadWork(messages, 1)!;
		expect(quoted.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		expect(textOf(quoted[1]!)).toContain("Lead:\nHere is what I see.");
	});

	it("leaves the request alone without a handover of this round, after an error result, or with nothing to quote", () => {
		const messages = leadThenWorker();
		expect(quoteLeadWork(messages, 2)).toBeUndefined();
		const failed = leadThenWorker();
		failed[5] = { ...(failed[5] as ToolResultMessage), isError: true };
		expect(quoteLeadWork(failed, 1)).toBeUndefined();
		// after a compaction the handover is only in the summary
		expect(
			quoteLeadWork([system(), user("summary"), assistant([{ type: "text", text: "go on" }])], 1),
		).toBeUndefined();
		// a /handover as the first message: no lead message to quote
		expect(
			quoteLeadWork(
				[system(), user(`${USER_HANDOVER_MARKER} (round 1) do it`), assistant([{ type: "text", text: "ok" }])],
				1,
			),
		).toBeUndefined();
		// a /handover of an earlier round is not this round's
		expect(handoverIndex([system(), user(`${USER_HANDOVER_MARKER} (round 1) do it`)], 2)).toBe(-1);
	});

	it("quotes the other results of the response that handed over, so no result is left without its call", () => {
		const messages: Message[] = [
			system(),
			user("go"),
			assistant([
				{ type: "toolCall", id: "h", name: "handover", arguments: { plan: "p" } },
				{ type: "toolCall", id: "r", name: "read", arguments: { path: "a" } },
			]),
			handoverResultMessage(1),
			result("read", [{ type: "text", text: "PARALLEL-READ" }], { toolCallId: "r" }),
			assistant([{ type: "text", text: "worker" }]),
		];
		const quoted = quoteLeadWork(messages, 1)!;
		expect(quoted.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		expect(textOf(quoted[1]!)).toContain("Result of read:\nPARALLEL-READ");
	});

	it("keeps a summary of a compaction in the worker's phase in the quote, and a steer after the handover as it is", () => {
		const messages: Message[] = [
			system(),
			user("<summary>EARLIER-SUMMARY</summary>"),
			assistant([{ type: "toolCall", id: "c2", name: "handover", arguments: { plan: "p" } }]),
			handoverResultMessage(1),
			user("STEER-AFTER-HANDOVER"),
			assistant([{ type: "text", text: "worker" }]),
		];
		const quoted = quoteLeadWork(messages, 1)!;
		expect(textOf(quoted[1]!)).toContain("User:\n<summary>EARLIER-SUMMARY</summary>");
		expect(quoted.slice(2)).toEqual(messages.slice(4));
	});

	it("quotes up to the latest handover in a later round, the earlier rounds' records included", () => {
		const round2: Message[] = [
			...leadThenWorker().slice(0, 6),
			user('<relay-hand-back round="1">record of round 1</relay-hand-back>'),
			assistant([{ type: "toolCall", id: "c3", name: "handover", arguments: { plan: "fix the test" } }]),
			handoverResultMessage(2),
			assistant([{ type: "text", text: "Round 2 work." }]),
		];
		const quoted = quoteLeadWork(round2, 2)!;
		expect(quoted.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
		expect(textOf(quoted[1]!)).toContain("record of round 1");
		expect(textOf(quoted[1]!)).toContain(handoverResult(2));
	});
});
