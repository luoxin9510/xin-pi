// Spec 03: an attached terminal follows its session through a restart (the attach itself is faked).
import { EventEmitter } from "node:events";
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

/** A terminal's input that records what the follow does to its mode. */
function fakeTerminal() {
	const stdin = Object.assign(new EventEmitter(), {
		isTTY: true,
		isRaw: false,
		modes: [] as boolean[],
		paused: true,
		setRawMode(v: boolean) {
			this.isRaw = v;
			this.modes.push(v);
		},
		resume() {
			this.paused = false;
		},
		pause() {
			this.paused = true;
		},
	});
	return { stdin, io: { stdin: stdin as never, stdout: {} as never, isDetachKey: (k: string) => k === "\x1a" } };
}

describe("attachFollowingRestart in the gap", () => {
	it("keeps the terminal raw and reading through the wait, and puts its mode back at the end", async () => {
		const t = fakeTerminal();
		let n = 0;
		const seen: { raw: boolean; listeners: number }[] = [];
		const reason = await attachFollowingRestart(
			async (onAttached) => {
				n++;
				if (n === 1) {
					onAttached();
					return "restart";
				}
				seen.push({ raw: t.stdin.isRaw, listeners: t.stdin.listenerCount("data") });
				return "local";
			},
			{ say: () => {}, io: t.io, retryMs: 20 },
		);
		expect(reason).toBe("local");
		// when the second try starts, the terminal is still raw (the gap's reader has just left)
		expect(seen).toEqual([{ raw: true, listeners: 0 }]);
		expect(t.stdin.modes[0]).toBe(true);
		expect(t.stdin.isRaw).toBe(false);
		expect(t.stdin.paused).toBe(true);
		expect(t.stdin.listenerCount("data")).toBe(0);
	});

	it("drops ordinary keys, and the detach key or Ctrl-C ends the attach as local", async () => {
		for (const key of ["\x1a", "\x03"]) {
			const t = fakeTerminal();
			let tries = 0;
			const p = attachFollowingRestart(
				async (onAttached) => {
					tries++;
					onAttached();
					return "restart";
				},
				{ say: () => {}, io: t.io, retryMs: 2000 },
			);
			await new Promise((r) => setTimeout(r, 30));
			t.stdin.emit("data", Buffer.from("x"));
			expect(t.stdin.listenerCount("data")).toBe(1);
			t.stdin.emit("data", Buffer.from(key));
			expect(await p).toBe("local");
			expect(tries).toBe(1);
			expect(t.stdin.isRaw).toBe(false);
			expect(t.stdin.listenerCount("data")).toBe(0);
		}
	});

	it("ends early, with the reason, when the row is not restarting and nothing runs", async () => {
		const said: string[] = [];
		let n = 0;
		const t0 = Date.now();
		const reason = await attachFollowingRestart(
			async (onAttached) => {
				if (n++ === 0) {
					onAttached();
					return "restart";
				}
				return "error";
			},
			{ say: (t) => said.push(t), retryMs: 5, waitMs: 20_000, ended: () => "could not start it" },
		);
		expect(reason).toBe("exit");
		expect(said).toEqual(["restarting…", "not restarted: could not start it"]);
		expect(Date.now() - t0).toBeLessThan(2000);
	});
});
