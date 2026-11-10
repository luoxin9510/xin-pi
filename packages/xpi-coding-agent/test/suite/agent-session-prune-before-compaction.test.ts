import { afterEach, describe, expect, it } from "vitest";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "xpi-ai";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

const BIG = "x".repeat(4000); // about 1000 tokens
const PLACEHOLDER = "Tool output removed to save context";

function usage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Streams a fixed summary and counts the summary requests. */
function useSummaryStream(harness: Harness): { calls: () => number; contexts: TranscriptContext[] } {
	const contexts: TranscriptContext[] = [];
	harness.session.agent.streamFunction = (model, context, _options?: SimpleStreamOptions) => {
		contexts.push(context);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage("pruned summary"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: usage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return { calls: () => contexts.length, contexts };
}

/** `turns` user turns, each with a read call whose output is about 1000 tokens. */
function seedToolTurns(
	harness: Harness,
	turns: number,
	pathFor: (n: number) => string = (n) => `/file-${n}.txt`,
): void {
	const model = harness.getModel();
	let now = Date.now() - 10_000;
	for (let n = 1; n <= turns; n++) {
		harness.sessionManager.appendMessage({ role: "user", content: `question ${n}`, timestamp: now++ });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage(
				[{ type: "toolCall", id: `call-${n}`, name: "read", arguments: { path: pathFor(n) } }],
				{
					stopReason: "toolUse",
					timestamp: now++,
				},
			),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(10),
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: `call-${n}`,
			toolName: "read",
			content: [{ type: "text", text: BIG }],
			isError: false,
			timestamp: now++,
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function pruneEdits(harness: Harness) {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit");
}

function compactions(harness: Harness) {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
}

describe("pruning old tool output before compaction", () => {
	const harnesses: Harness[] = [];

	async function setup(options: {
		contextWindow: number;
		prune?: Partial<NonNullable<Settings["compaction"]>["prune"]>;
		turns?: number;
		pathFor?: (n: number) => string;
		onBeforeCompact?: () => void;
	}): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: options.contextWindow, maxTokens: 100 }],
			settings: {
				compaction: {
					reserveTokens: 0,
					keepRecentTokens: 1,
					prune: { protectTokens: 1000, minSavingsTokens: 500, ...options.prune },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						options.onBeforeCompact?.();
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		seedToolTurns(harness, options.turns ?? 6, options.pathFor);
		return harness;
	}

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("skips the summary when pruning alone gets under the threshold", async () => {
		let beforeCompact = 0;
		const harness = await setup({ contextWindow: 5000, onBeforeCompact: () => beforeCompact++ });
		const stream = useSummaryStream(harness);

		const result = await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction(
			"threshold",
			false,
		);

		expect(result).toBe(false);
		expect(stream.calls()).toBe(0);
		expect(beforeCompact).toBe(0);
		expect(compactions(harness)).toHaveLength(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		// The newest result stays whole; the five older ones are replaced and the originals stay in the file.
		const edits = pruneEdits(harness);
		expect(edits).toHaveLength(5);
		const text = JSON.stringify(harness.session.agent.state.messages);
		expect(text.split(PLACEHOLDER)).toHaveLength(6);
		expect(text.split(BIG)).toHaveLength(2);
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain(BIG);
	});

	it("summarises the pruned context when pruning is not enough", async () => {
		let beforeCompact = 0;
		const harness = await setup({ contextWindow: 800, onBeforeCompact: () => beforeCompact++ });
		const stream = useSummaryStream(harness);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		expect(pruneEdits(harness).length).toBeGreaterThan(0);
		expect(beforeCompact).toBe(1);
		expect(stream.calls()).toBeGreaterThan(0); // a split turn makes two summary calls
		expect(compactions(harness)).toHaveLength(1);
		const summarized = JSON.stringify(stream.contexts);
		expect(summarized).toContain(PLACEHOLDER);
		expect(summarized).not.toContain(BIG);
	});

	it("appends nothing when the saving is under the minimum", async () => {
		const harness = await setup({ contextWindow: 800, prune: { minSavingsTokens: 100_000 } });
		useSummaryStream(harness);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		expect(pruneEdits(harness)).toHaveLength(0);
		expect(compactions(harness)).toHaveLength(1);
	});

	it("restores today's behaviour when disabled", async () => {
		const harness = await setup({ contextWindow: 5000, prune: { enabled: false } });
		const stream = useSummaryStream(harness);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		expect(pruneEdits(harness)).toHaveLength(0);
		expect(stream.calls()).toBeGreaterThan(0); // a split turn makes two summary calls
		expect(compactions(harness)).toHaveLength(1);
	});

	it("keeps results of skill-file reads", async () => {
		const harness = await setup({
			contextWindow: 5000,
			pathFor: (n) => (n === 2 ? "/somewhere/my-skill/SKILL.md" : `/file-${n}.txt`),
		});
		useSummaryStream(harness);

		await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);

		const text = JSON.stringify(harness.session.agent.state.messages);
		expect(pruneEdits(harness)).toHaveLength(4);
		// The newest result and the skill read stay whole.
		expect(text.split(BIG)).toHaveLength(3);
	});

	it("prunes first on the overflow path and still retries", async () => {
		const harness = await setup({ contextWindow: 5000 });
		const stream = useSummaryStream(harness);

		const retry = await (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction(
			"overflow",
			true,
		);

		expect(retry).toBe(true);
		expect(pruneEdits(harness)).toHaveLength(5);
		expect(stream.calls()).toBe(0);
		expect(compactions(harness)).toHaveLength(0);
	});

	it("lets a later compaction cut past the pruned entries", async () => {
		const harness = await setup({ contextWindow: 5000 });
		const stream = useSummaryStream(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;
		await internals._runAutoCompaction("threshold", false);
		expect(pruneEdits(harness)).toHaveLength(5);

		// A real compaction after pruning must still be able to cut past the edits.
		harness.settingsManager.applyOverrides({ compaction: { prune: { enabled: false } } });
		await harness.session.compact();

		expect(stream.calls()).toBeGreaterThan(0); // a split turn makes two summary calls
		const compaction = compactions(harness)[0];
		const branch = harness.sessionManager.getBranch();
		const keptIndex = branch.findIndex(
			(entry) => compaction?.type === "compaction" && entry.id === compaction.firstKeptEntryId,
		);
		expect(keptIndex).toBeGreaterThan(0);
		expect(harness.session.agent.state.messages[0]?.role).toBe("compactionSummary");
	});
});
