import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext, stream } from "../src/compat.ts";
import { getSystemMessageText } from "../src/index.ts";
import type { CacheRetention, Context, SystemMessage } from "../src/types.ts";

const OAUTH_KEY = "sk-ant-oat01-test";
const API_KEY = "sk-ant-api03-test";
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const sseBody = [
	{
		event: "message_start",
		data: { type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
	},
	{
		event: "message_delta",
		data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
	},
	{ event: "message_stop", data: { type: "message_stop" } },
]
	.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`)
	.join("\n");

interface Block {
	type: string;
	text?: string;
	cache_control?: { type: string; ttl?: string };
}
interface Payload {
	system?: Block[];
	tools?: Array<{ name: string; cache_control?: unknown }>;
	messages: Array<{ role: string; content: string | Block[] }>;
}

function systemMessage(extra: Partial<SystemMessage> = {}): SystemMessage {
	return {
		role: "system",
		content: "Preamble text.",
		sections: { project_context: "<project>ctx</project>", agent: "<agent>body</agent>", env: "<env>cwd</env>" },
		toolsAdded: [
			{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } } as never,
		],
		timestamp: 0,
		...extra,
	};
}

async function capture(key: string, system: SystemMessage, cacheRetention?: CacheRetention): Promise<Payload> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const context = normalizeContext({
		messages: [system, { role: "user", content: "hi", timestamp: 0 }],
	} as never);
	let body: Payload | undefined;
	const fetchMock = async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(String(init?.body)) as Payload;
		return new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	await streamAnthropic(model, context, {
		apiKey: key,
		fetch: fetchMock as never,
		cacheRetention,
		maxRetries: 0,
	}).result();
	if (!body) throw new Error("no request captured");
	return body;
}

/** Every cache_control in the request, wherever it sits. */
function breakpointCount(p: Payload): number {
	let n = 0;
	for (const b of p.system ?? []) if (b.cache_control) n++;
	for (const t of p.tools ?? []) if (t.cache_control) n++;
	for (const m of p.messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.cache_control) n++;
	return n;
}

const marked = (blocks: Block[] | undefined) => (blocks ?? []).map((b) => !!b.cache_control);
const systemText = (p: Payload) => (p.system ?? []).map((b) => b.text).join("");

describe("Anthropic system message cache breakpoints", () => {
	const hints = { cacheBreakpoints: ["project_context", "agent"] };
	const unsplit = getSystemMessageText(systemMessage());

	describe.each([
		["API key", API_KEY, false],
		["OAuth", OAUTH_KEY, true],
	])("%s", (_name, key, oauth) => {
		const offset = oauth ? 1 : 0;
		const full = (oauth ? IDENTITY : "") + unsplit;

		it("no hint: one system block with one breakpoint, as before", async () => {
			const p = await capture(key, systemMessage());
			expect(p.system).toHaveLength(1 + offset);
			expect(marked(p.system)).toEqual(oauth ? [true, true] : [true]);
			expect(systemText(p)).toBe(full);
			expect(breakpointCount(p)).toBe(oauth ? 4 : 3);
		});

		it("head+tail hint: blocks concatenate to the unsplit text, breakpoint at each named section", async () => {
			const p = await capture(key, systemMessage(hints));
			const sys = p.system ?? [];
			expect(sys).toHaveLength(offset + 3);
			expect(systemText(p)).toBe(full);
			expect(sys[offset]?.text).toBe("Preamble text.\n\n<project>ctx</project>");
			expect(sys[offset + 1]?.text).toBe("\n\n<agent>body</agent>");
			expect(sys[offset + 2]?.text).toBe("\n\n<env>cwd</env>");
			expect(marked(sys.slice(offset))).toEqual([true, true, false]);
		});

		it("head+tail hint: 4 breakpoints at most; OAuth identity yields first", async () => {
			const p = await capture(key, systemMessage(hints));
			expect(breakpointCount(p)).toBe(4);
			if (oauth) expect(p.system?.[0]?.cache_control).toBeUndefined();
			expect(p.tools?.at(-1)?.cache_control).toBeDefined();
			const last = p.messages.at(-1)?.content;
			expect(Array.isArray(last) && last.at(-1)?.cache_control).toBeTruthy();
		});

		it("three hints: the earliest hint is dropped, never more than 4", async () => {
			const p = await capture(key, systemMessage({ cacheBreakpoints: ["content", "project_context", "agent"] }));
			expect(breakpointCount(p)).toBe(4);
			expect(marked((p.system ?? []).slice(offset))).toEqual([false, true, true, false]);
			expect(systemText(p)).toBe(full);
		});

		it("unknown section name is ignored", async () => {
			const p = await capture(key, systemMessage({ cacheBreakpoints: ["nope"] }));
			expect(p.system).toHaveLength(1 + offset);
			expect(marked(p.system)).toEqual(oauth ? [true, true] : [true]);
			expect(systemText(p)).toBe(full);
		});

		it('cacheRetention "none": no breakpoints at all', async () => {
			const p = await capture(key, systemMessage(hints), "none");
			expect(breakpointCount(p)).toBe(0);
			expect(systemText(p)).toBe(full);
		});

		it('cacheRetention "long": one TTL on every breakpoint', async () => {
			const p = await capture(key, systemMessage(hints), "long");
			expect(breakpointCount(p)).toBe(4);
			const all = [...(p.system ?? []), ...(p.messages.at(-1)?.content as Block[])];
			const ttls = new Set(all.filter((b) => b.cache_control).map((b) => b.cache_control?.ttl));
			expect(ttls).toEqual(new Set(["1h"]));
		});
	});

	it("no-hint payload keeps today's exact system shape (golden)", async () => {
		const p = await capture(API_KEY, systemMessage());
		expect(p.system).toEqual([{ type: "text", text: unsplit, cache_control: { type: "ephemeral" } }]);
		const o = await capture(OAUTH_KEY, systemMessage());
		expect(o.system).toEqual([
			{ type: "text", text: IDENTITY, cache_control: { type: "ephemeral" } },
			{ type: "text", text: unsplit, cache_control: { type: "ephemeral" } },
		]);
	});

	it("hints do not change the text other providers render", () => {
		expect(getSystemMessageText(systemMessage(hints))).toBe(unsplit);
	});

	it("non-Anthropic provider: same prompt text with and without hints, no marker leaks", async () => {
		const model = getModel("openai", "gpt-4o-mini");
		const sent = async (system: SystemMessage): Promise<string> => {
			let payload = "";
			const controller = new AbortController();
			const context = { messages: [system, { role: "user", content: "hi", timestamp: 0 }] } as never as Context;
			await stream(model, context, {
				apiKey: "sk-test",
				signal: controller.signal,
				onPayload: (p) => {
					payload = JSON.stringify(p);
					controller.abort();
					return undefined;
				},
			}).result();
			return payload;
		};
		const plain = await sent(systemMessage());
		const hinted = await sent(systemMessage(hints));
		expect(hinted).toBe(plain);
		expect(plain).toContain("<agent>body</agent>");
		expect(plain).not.toContain("cache_control");
		expect(plain).not.toContain("cacheBreakpoints");
	});
});
