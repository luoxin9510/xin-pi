// The delegation evaluation's rpc driver (rpc-driver.ts) against a scripted stand-in for `xpi --mode rpc`
// (fake-rpc.mjs): when a run is over (the `subagents` status, else the fallback: main quiet, no running meta file, no
// xpi child process), the cap, an early exit, wakes, cancelled dialogs, and the metrics read from a session file.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRpc, waitMetrics, xpiDescendants } from "./rpc-driver.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fake-rpc.mjs");

type Step =
	| { wait: number }
	| { out: unknown }
	| { meta: { path: string; status: string } }
	| { child: number; own?: string }
	| { exit: number };

const start = { out: { type: "agent_start" } };
const end = { out: { type: "agent_end", messages: [] } };
const status = (text?: string) => ({
	out: {
		type: "extension_ui_request",
		id: `s${Math.random()}`,
		method: "setStatus",
		statusKey: "subagents",
		statusText: text,
	},
});

describe("the rpc driver", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function drive(
		steps: Step[],
		options: { capMs?: number; quietMs?: number; ignoreTerm?: boolean; shutdownMs?: number } = {},
	) {
		const dir = mkdtempSync(join(tmpdir(), "rpc-driver-"));
		dirs.push(dir);
		const sessionDir = join(dir, "sessions");
		const record = join(dir, "record.jsonl");
		const resolved = JSON.parse(
			JSON.stringify(steps).replaceAll("$SESSIONS", sessionDir).replaceAll("$DIR", dir),
		) as Step[];
		const result = await runRpc({
			cli: FAKE,
			cwd: dir,
			env: {
				...process.env,
				FAKE_RPC_SCENARIO: JSON.stringify({ steps: resolved, ignoreTerm: options.ignoreTerm }),
				FAKE_RPC_RECORD: record,
			},
			args: ["--model", "x/y"],
			prompt: "do the work",
			sessionDir,
			capMs: options.capMs ?? 20_000,
			quietMs: options.quietMs ?? 400,
			settleMs: 300,
			pollMs: 50,
			shutdownMs: options.shutdownMs ?? 2_000,
		});
		const commands = existsSync(record)
			? readFileSync(record, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
		return { result, commands, dir };
	}

	it("with the subagents status: ends when main is idle and the status is clear, counts wakes, cancels dialogs", async () => {
		const { result, commands } = await drive([
			start,
			status("1 group"),
			{ out: { type: "extension_ui_request", id: "d1", method: "confirm", title: "sure?", message: "?" } },
			end,
			// Main idle, a group running: not over.
			{ wait: 800 },
			status(undefined),
			// The group's message starts a turn a moment after the status clears: the settle window waits for it.
			{ wait: 150 },
			start,
			end,
		]);
		expect(result).toMatchObject({ endedBy: "status", wakes: 1, sawStatus: true });
		expect(result.error).toBeUndefined();
		expect(result.ms).toBeGreaterThanOrEqual(800);
		expect(commands[0]).toEqual({ type: "prompt", message: "do the work" });
		expect(commands).toContainEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
	});

	it("without it: waits for main to be quiet, for running meta files and for xpi child processes", async () => {
		const meta = "$SESSIONS/s1/subagents/sid/a1.json";
		const { result } = await drive(
			[
				start,
				{ meta: { path: meta, status: "running" } },
				{ child: 1500 },
				end,
				{ wait: 600 },
				{ meta: { path: meta, status: "completed" } },
			],
			{ quietMs: 200 },
		);
		expect(result).toMatchObject({ endedBy: "fallback", wakes: 0, sawStatus: false });
		// Over only after the child process left (1.5 s), not when the meta file said completed (0.6 s).
		expect(result.ms).toBeGreaterThanOrEqual(1400);
	});

	it("without it: a running meta file holds the end", async () => {
		const meta = "$SESSIONS/s1/subagents/sid/a1.json";
		const { result } = await drive(
			[
				start,
				{ meta: { path: meta, status: "running" } },
				end,
				{ wait: 1200 },
				{ meta: { path: meta, status: "stopped" } },
			],
			{ quietMs: 200 },
		);
		expect(result.endedBy).toBe("fallback");
		expect(result.ms).toBeGreaterThanOrEqual(1200);
	});

	it("without it: main must have been idle for quietMs", async () => {
		const { result } = await drive([start, end], { quietMs: 1000 });
		expect(result.endedBy).toBe("fallback");
		expect(result.ms).toBeGreaterThanOrEqual(1000);
	});

	it("the cap ends a run that never settles; an early exit is an error", async () => {
		const capped = await drive([start], { capMs: 600 });
		expect(capped.result.endedBy).toBe("cap");
		expect(capped.result.error).toMatch(/cap/);
		const exited = await drive([{ exit: 3 }]);
		expect(exited.result.endedBy).toBe("exit");
		expect(exited.result.error).toMatch(/exited with 3/);
	});

	it("finds xpi rpc processes among the descendants only", () => {
		const ps = [
			"  10     1 node cli.js --mode rpc --model x",
			"  11    10 node cli.js --mode rpc --model haiku",
			"  12    10 /bin/sh -c npm test",
			"  13    12 node cli.js --mode rpc",
			"  14     1 node other.js --mode rpc",
			"  15    11 node unrelated.js",
		].join("\n");
		expect(xpiDescendants(10, ps).sort()).toEqual([11, 13]);
		expect(xpiDescendants(14, ps)).toEqual([]);
	});

	it("an xpi that does not shut down in time is SIGKILLed with its children in their own process groups", async () => {
		const { result, dir } = await drive([start, { child: 60_000, own: "$DIR/kid.pid" }], {
			capMs: 600,
			ignoreTerm: true,
			shutdownMs: 500,
		});
		expect(result.endedBy).toBe("cap");
		const kid = Number(readFileSync(join(dir, "kid.pid"), "utf8"));
		const alive = () => {
			try {
				process.kill(kid, 0);
				return true;
			} catch {
				return false;
			}
		};
		await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3_000 });
	});

	it("counts codemode calls that set timeout_ms, also ones codemode refused", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc-metrics-"));
		dirs.push(dir);
		const file = join(dir, "main.jsonl");
		const call = (code: string) => ({
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", name: "codemode", arguments: { code } }] },
		});
		const lines = [
			call('// @options: {"timeout_ms": 600000}\ntools.Agent({});'),
			call('// @options: {"timeout_ms": -5}\ntools.Agent({});'),
			call("tools.Agent({});"),
			call('// @options: {"max_output_tokens": 100}\nreturn 1;'),
			call("// @options: {not json}\nreturn 1;"),
		];
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
		expect(waitMetrics(file)).toEqual({ timeoutMsSet: 2, agentsStoppedByDeadline: 0, released: 0 });
	});
});
