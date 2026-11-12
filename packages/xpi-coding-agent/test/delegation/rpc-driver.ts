// The rpc-mode driver of the delegation evaluation (spec 09, "Measuring"). Print mode has no background scripts, so
// waiting for agents is measured through `xpi --mode rpc`: the driver sends the prompt, answers no UI request
// (dialogs are cancelled), and decides when the run is over.
//
// A run is over when main is idle and no agent is running, or at the cap (900 s by default):
// - with the `subagents` status (builds with spec 09's PR 2): main idle and the status cleared, for `settleMs`;
// - without it (older builds, or a run that never started an agent): main idle for `quietMs`, no child meta file with
//   status "running", and no xpi child process (an agent waiting for a slot has no meta file yet).
//
// The metrics come from the main session file: `timeoutMsSet`, `agentsStoppedByDeadline` and `released`. `wakes` is
// counted here: main's `agent_start` events after the first.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { parseCodemodeSource } from "xpi-codemode";

export interface RpcRunOptions {
	/** The xpi CLI to start (an executable `cli.js`); `--mode rpc` is added. */
	cli: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Arguments after `--mode rpc` (model, thinking, tools, session dir...). */
	args: string[];
	prompt: string;
	/** Where the run's sessions are written: its child meta files are looked up here. */
	sessionDir: string;
	capMs?: number;
	/** The fallback end condition: how long main must have been idle. */
	quietMs?: number;
	/** With the `subagents` status: how long main idle and the status clear must hold. */
	settleMs?: number;
	pollMs?: number;
	/** The live xpi child processes of a pid (default: from `ps`). */
	children?: (pid: number) => number[];
}

export type RpcEnd = "status" | "fallback" | "cap" | "exit";

export interface RpcRunResult {
	/** Why the run did not end well: the process exited early or with an error, or the cap was reached. */
	error?: string;
	endedBy: RpcEnd;
	/** Main's `agent_start` events after the first. */
	wakes: number;
	/** Whether the build published the `subagents` status. */
	sawStatus: boolean;
	ms: number;
}

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** Start `xpi --mode rpc`, send the prompt, and wait until main is idle and no agent runs. */
export async function runRpc(options: RpcRunOptions): Promise<RpcRunResult> {
	const capMs = options.capMs ?? 900_000;
	const quietMs = options.quietMs ?? 10_000;
	const settleMs = options.settleMs ?? 3_000;
	const pollMs = options.pollMs ?? 1_000;
	const children = options.children ?? xpiChildren;
	const started = Date.now();
	const child = spawn(options.cli, ["--mode", "rpc", ...options.args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString("utf8")).slice(-2000);
	});
	const send = (command: Record<string, unknown>) => {
		if (child.stdin.writable) child.stdin.write(`${JSON.stringify(command)}\n`);
	};

	let starts = 0;
	let busy = false;
	let idleSince = Date.now();
	let sawStatus = false;
	let status: string | undefined;
	let promptError: string | undefined;
	let buffer = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event.type === "agent_start") {
				starts++;
				busy = true;
			} else if (event.type === "agent_end") {
				busy = false;
				idleSince = Date.now();
			} else if (event.type === "response" && event.command === "prompt" && event.success === false) {
				promptError = String(event.error ?? "the prompt was refused");
			} else if (event.type === "extension_ui_request") {
				if (event.method === "setStatus" && event.statusKey === "subagents") {
					sawStatus = true;
					status = typeof event.statusText === "string" ? event.statusText : undefined;
				} else if (DIALOGS.has(String(event.method))) {
					send({ type: "extension_ui_response", id: event.id, cancelled: true });
				}
			}
		}
	});
	let exited: number | null | undefined;
	child.on("exit", (code) => {
		exited = code;
	});
	send({ type: "prompt", message: options.prompt });

	const result = await new Promise<{ endedBy: RpcEnd; error?: string }>((done) => {
		let settledSince: number | undefined;
		const timer = setInterval(() => {
			const now = Date.now();
			if (exited !== undefined) {
				clearInterval(timer);
				const why = promptError ?? stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300);
				return done({ endedBy: "exit", error: `xpi exited with ${exited} before the run ended: ${why}` });
			}
			if (promptError) {
				clearInterval(timer);
				return done({ endedBy: "exit", error: promptError });
			}
			if (now - started >= capMs) {
				clearInterval(timer);
				return done({ endedBy: "cap", error: `still running at the cap of ${Math.round(capMs / 1000)} s` });
			}
			if (starts === 0 || busy) {
				settledSince = undefined;
				return;
			}
			if (sawStatus) {
				if (status !== undefined) {
					settledSince = undefined;
					return;
				}
				settledSince ??= now;
				if (now - settledSince >= settleMs) {
					clearInterval(timer);
					done({ endedBy: "status" });
				}
				return;
			}
			if (now - idleSince < quietMs) return;
			if (runningMeta(options.sessionDir)) return;
			if (child.pid !== undefined && children(child.pid).length > 0) return;
			clearInterval(timer);
			done({ endedBy: "fallback" });
		}, pollMs);
	});

	stop(child.pid);
	await new Promise<void>((resolve) => {
		if (exited !== undefined) return resolve();
		const kill = setTimeout(() => {
			stop(child.pid, "SIGKILL");
			resolve();
		}, 5_000);
		child.on("exit", () => {
			clearTimeout(kill);
			resolve();
		});
	});
	return { ...result, wakes: Math.max(0, starts - 1), sawStatus, ms: Date.now() - started };
}

function stop(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// already gone
	}
}

/** A child meta file under `sessionDir` (`.../subagents/<session id>/<agent id>.json`) says "running". */
export function runningMeta(sessionDir: string): boolean {
	let names: string[];
	try {
		names = readdirSync(sessionDir, { recursive: true }) as string[];
	} catch {
		return false;
	}
	for (const name of names) {
		const parts = name.split(sep);
		if (!name.endsWith(".json") || parts.at(-3) !== "subagents") continue;
		try {
			if ((JSON.parse(readFileSync(join(sessionDir, name), "utf8")) as { status?: string }).status === "running")
				return true;
		} catch {
			// being written, or not a meta file
		}
	}
	return false;
}

/** The pids among the descendants of `root` whose command runs xpi in rpc mode (subagent children), from `ps` output. */
export function xpiDescendants(root: number, ps: string): number[] {
	const kids = new Map<number, { pid: number; command: string }[]>();
	for (const line of ps.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const entry = { pid: Number(match[1]), command: match[3]! };
		const ppid = Number(match[2]);
		kids.set(ppid, [...(kids.get(ppid) ?? []), entry]);
	}
	const found: number[] = [];
	const walk = (pid: number) => {
		for (const kid of kids.get(pid) ?? []) {
			if (/--mode rpc\b/.test(kid.command)) found.push(kid.pid);
			walk(kid.pid);
		}
	};
	walk(root);
	return found;
}

function xpiChildren(pid: number): number[] {
	try {
		return xpiDescendants(pid, execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="]).toString("utf8"));
	} catch {
		return [];
	}
}

export interface WaitMetrics {
	/** codemode calls whose `@options` line sets `timeout_ms`. */
	timeoutMsSet: number;
	/** Agents stopped by a script's deadline: in a codemode result or a background script's end message that says
	 * "Script timed out", the Agent calls that ended in an error or `cancelled` (the agents listed failed or stopped). */
	agentsStoppedByDeadline: number;
	/** Nested calls with the status `released`. */
	released: number;
}

interface SessionLine {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		customType?: string;
		content?: unknown;
		details?: { calls?: { name?: string; status?: string }[] };
	};
}

const textOf = (content: unknown) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((c) => (c as { text?: string }).text ?? "").join("")
			: "";

/** The wait metrics of a main session file. */
export function waitMetrics(file: string): WaitMetrics {
	const metrics: WaitMetrics = { timeoutMsSet: 0, agentsStoppedByDeadline: 0, released: 0 };
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let entry: SessionLine;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content as { type?: string; name?: string; arguments?: { code?: unknown } }[]) {
				if (part.type !== "toolCall" || part.name !== "codemode" || typeof part.arguments?.code !== "string")
					continue;
				try {
					if (parseCodemodeSource(part.arguments.code).options.timeoutMs !== undefined) metrics.timeoutMsSet++;
				} catch {
					// a source codemode refused: it ran nothing
				}
			}
		}
		if (message.role === "toolResult" && message.toolName === "codemode") {
			const calls = message.details?.calls ?? [];
			metrics.released += calls.filter((c) => c.status === "released").length;
			if (textOf(message.content).includes("Script timed out"))
				metrics.agentsStoppedByDeadline += calls.filter(
					(c) => c.name === "Agent" && (c.status === "error" || c.status === "cancelled"),
				).length;
		}
		// A background script's end arrives as a message: its agent lines are "- <id> <type> <status> $<cost>".
		if (message.role === "custom" && message.customType === "subagent") {
			const text = textOf(message.content);
			if (/^Background script \S+.* failed\.\nError: Script timed out/.test(text))
				metrics.agentsStoppedByDeadline += (text.match(/^- \S+ \S+ (?:stopped|failed) \$/gm) ?? []).length;
		}
	}
	return metrics;
}
