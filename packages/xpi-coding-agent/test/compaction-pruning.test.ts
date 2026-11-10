import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage } from "xpi-ai";
import {
	DEFAULT_COMPACTION_SETTINGS,
	planToolOutputPruning,
	prepareCompaction,
	prunedToolOutputText,
} from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const SETTINGS = { enabled: true, protectTokens: 1000, minSavingsTokens: 500 };
const BIG = "x".repeat(4000); // about 1000 tokens

function assistantCalling(callId: string, path: string, text = "calling"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name: "read", arguments: { path } },
		],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 10,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 11,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function result(callId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** One user turn with a read call; returns the tool result entry id. */
function addTurn(session: SessionManager, n: number, path: string, output: string): string {
	session.appendMessage({ role: "user", content: `question ${n}`, timestamp: Date.now() });
	session.appendMessage(assistantCalling(`call-${n}`, path));
	return session.appendMessage(result(`call-${n}`, output));
}

function placeholder(tokens = 1000) {
	return { content: [{ type: "text" as const, text: prunedToolOutputText(tokens) }] };
}

const noSkills = () => false;

describe("planToolOutputPruning", () => {
	it("keeps the newest window and picks older results, newest first", () => {
		const session = SessionManager.inMemory();
		const ids = [1, 2, 3, 4].map((n) => addTurn(session, n, `/f${n}.txt`, BIG));

		const plan = planToolOutputPruning(session.buildSessionProjection(), SETTINGS, noSkills);

		expect(plan.targets.map((t) => t.entryId)).toEqual([ids[2], ids[1], ids[0]]);
		expect(plan.targets[0]?.tokens).toBe(1000);
		expect(plan.savedTokens).toBeGreaterThan(2900);
	});

	it("prunes nothing when the saving is under the minimum", () => {
		const session = SessionManager.inMemory();
		addTurn(session, 1, "/a", BIG);
		addTurn(session, 2, "/b", BIG);

		const plan = planToolOutputPruning(
			session.buildSessionProjection(),
			{ ...SETTINGS, minSavingsTokens: 5000 },
			noSkills,
		);
		expect(plan).toEqual({ targets: [], savedTokens: 0 });
	});

	it("skips small results and results of skill-file reads", () => {
		const session = SessionManager.inMemory();
		const small = addTurn(session, 1, "/a", "tiny");
		const skill = addTurn(session, 2, "/skills/x/SKILL.md", BIG);
		const other = addTurn(session, 3, "/b", BIG);
		addTurn(session, 4, "/c", BIG);

		const plan = planToolOutputPruning(session.buildSessionProjection(), SETTINGS, (path) =>
			path.endsWith("SKILL.md"),
		);

		expect(plan.targets.map((t) => t.entryId)).toEqual([other]);
		expect(plan.targets.map((t) => t.entryId)).not.toContain(small);
		expect(plan.targets.map((t) => t.entryId)).not.toContain(skill);
	});

	it("counts already pruned results toward the window and does not prune them again", () => {
		const session = SessionManager.inMemory();
		const oldest = addTurn(session, 1, "/a", BIG);
		const pruned = addTurn(session, 2, "/b", BIG);
		addTurn(session, 3, "/c", BIG);
		session.appendContextEdit(pruned, placeholder(), { prune: true });

		// The newest result fills the 1000-token window, so only the oldest remains a candidate.
		const plan = planToolOutputPruning(
			session.buildSessionProjection(),
			{ ...SETTINGS, minSavingsTokens: 100 },
			noSkills,
		);
		expect(plan.targets.map((t) => t.entryId)).toEqual([oldest]);
	});

	it("ignores results before the latest compaction", () => {
		const session = SessionManager.inMemory();
		addTurn(session, 1, "/a", BIG);
		addTurn(session, 2, "/b", BIG);
		const keptId = session.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		session.appendCompaction("summary", keptId, 5000);
		const after = addTurn(session, 3, "/c", BIG);
		addTurn(session, 4, "/d", BIG);

		const plan = planToolOutputPruning(
			session.buildSessionProjection(),
			{ ...SETTINGS, minSavingsTokens: 100 },
			noSkills,
		);
		expect(plan.targets.map((t) => t.entryId)).toEqual([after]);
	});

	it("follows the branch the edit was made on", () => {
		const session = SessionManager.inMemory();
		const first = addTurn(session, 1, "/a", BIG);
		const forkPoint = session.getLeafId();
		if (!forkPoint) throw new Error("no leaf");
		addTurn(session, 2, "/b", BIG);
		session.appendContextEdit(first, placeholder(), { prune: true });
		expect(JSON.stringify(session.buildSessionProjection().messages)).toContain("Tool output removed");

		session.branch(forkPoint);
		addTurn(session, 3, "/c", "other branch output");
		const text = JSON.stringify(session.buildSessionProjection().messages);
		expect(text).not.toContain("Tool output removed");
		expect(text).toContain(BIG);
	});
});

describe("compaction after pruning", () => {
	it("still cuts past pruned entries and summarises the placeholders", () => {
		const session = SessionManager.inMemory();
		const ids = [1, 2, 3, 4, 5].map((n) => addTurn(session, n, `/f${n}.txt`, BIG));
		const plan = planToolOutputPruning(session.buildSessionProjection(), SETTINGS, noSkills);
		expect(plan.targets).toHaveLength(4);
		for (const target of plan.targets) {
			session.appendContextEdit(target.entryId, placeholder(target.tokens), { prune: true });
		}

		const preparation = prepareCompaction(session.getBranch(), {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 500,
		});

		expect(preparation).toBeDefined();
		const branch = session.getBranch();
		const keptIndex = branch.findIndex((e) => e.id === preparation?.firstKeptEntryId);
		expect(keptIndex).toBeGreaterThan(0);
		expect(keptIndex).toBeLessThanOrEqual(branch.findIndex((e) => e.id === ids[4]));
		const summarized = JSON.stringify(preparation?.messagesToSummarize);
		expect(summarized).toContain("Tool output removed");
		expect(summarized).not.toContain(BIG);
	});

	it("does not block the recovery-omission cut advance", () => {
		const cut = (edit: "none" | "prune" | "other"): number | undefined => {
			const session = SessionManager.inMemory();
			const oldResult = addTurn(session, 1, "/a", BIG);
			session.appendMessage({ role: "user", content: "recovery input ".repeat(100), timestamp: Date.now() });
			const attemptId = session.appendMessage(assistantCalling("c9", "/z", "failed attempt"));
			session.appendContextEdit(attemptId, null);
			if (edit !== "none") {
				session.appendContextEdit(oldResult, placeholder(), edit === "prune" ? { prune: true } : undefined);
			}
			const firstKeptEntryId = prepareCompaction(session.getBranch(), {
				...DEFAULT_COMPACTION_SETTINGS,
				keepRecentTokens: 1,
			})?.firstKeptEntryId;
			const index = session.getBranch().findIndex((entry) => entry.id === firstKeptEntryId);
			return index < 0 ? undefined : index;
		};

		const baseline = cut("none");
		expect(cut("prune")).toBe(baseline);
		// An unrelated replacement still blocks the advance, so the marker is what makes the difference.
		expect(cut("other")).not.toBe(baseline);
	});
});
