// Spec 03: an attached terminal follows its session through a restart (the attach itself is faked).
import { describe, expect, it } from "vitest";
import { attachFollowingRestart, type DetachReason } from "../src/lib/attach.ts";

/** Each try is `[reason, attached?]`; the last one repeats. */
function script(tries: [DetachReason, boolean][]) {
	let n = 0;
	const said: string[] = [];
	return {
		said,
		tries: () => n,
		run: (d: { restarting?: () => boolean; waitMs?: number } = {}) =>
			attachFollowingRestart(
				async (onAttached) => {
					const [reason, attached] = tries[Math.min(n++, tries.length - 1)]!;
					if (attached) onAttached();
					return reason;
				},
				{ say: (t) => said.push(t), retryMs: 5, ...d },
			),
	};
}

describe("attachFollowingRestart", () => {
	it("attaches again after a host that ended with the reason restart, and says so once", async () => {
		const s = script([
			["restart", true],
			["error", false], // the new host's socket is not there yet
			["restart", false], // the old host, still finishing
			["local", true],
		]);
		expect(await s.run()).toBe("local");
		expect(s.said).toEqual(["restarting…"]);
		expect(s.tries()).toBe(4);
	});

	it("follows a host that vanished while the row says restarting", async () => {
		const s = script([
			["exit", true],
			["local", true],
		]);
		expect(await s.run({ restarting: () => true })).toBe("local");
		expect(s.said).toEqual(["restarting…"]);
	});

	it("does not follow an end, a takeover or a detach", async () => {
		for (const r of ["exit", "takeover", "local", "request", "closed", "error"] as const) {
			const s = script([[r, true]]);
			expect(await s.run({ restarting: () => false })).toBe(r);
			expect(s.tries()).toBe(1);
			expect(s.said).toEqual([]);
		}
	});

	it("a session that ends after it came back is an end, not another wait", async () => {
		const s = script([
			["restart", true],
			["exit", true],
		]);
		expect(await s.run()).toBe("exit");
		expect(s.tries()).toBe(2);
	});

	it("gives up after waitMs with the reason of the last try", async () => {
		const s = script([
			["restart", true],
			["error", false],
		]);
		expect(await s.run({ waitMs: 40 })).toBe("error");
		expect(s.said).toEqual(["restarting…"]);
	});

	it("a first try that never attached is not a restart", async () => {
		const s = script([["error", false]]);
		expect(await s.run()).toBe("error");
		expect(s.tries()).toBe(1);
	});
});
