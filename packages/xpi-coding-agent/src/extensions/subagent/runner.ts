// Run one child as a `pi --mode rpc` process: send the prompt over stdin, read the JSONL event stream (spec 6).

import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { type Static, Type } from "typebox";
import type { ChildSpec } from "./resolve.ts";

export const usageSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	totalTokens: Type.Number(),
	cost: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
export type Usage = Static<typeof usageSchema>;

export const STATUSES = ["completed", "partial", "failed"] as const;
export type Status = (typeof STATUSES)[number];

export interface RunResult {
	status: Status;
	output: string;
	usage: Usage;
	turns: number;
	durationMs: number;
	error?: string;
	aborted: boolean; // the child reported that its run was aborted (an rpc abort took effect)
}

export interface Progress {
	turns: number;
	lastTool?: string;
}

const KILL_GRACE_MS = 5000;
// How long a child may take to exit after agent_settled, and to settle after its last allowed turn.
const SETTLE_GRACE_MS = 2000;
const STDERR_LINES = 30;

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(sum: Usage, u: Usage): void {
	sum.input += u.input;
	sum.output += u.output;
	sum.cacheRead += u.cacheRead;
	sum.cacheWrite += u.cacheWrite;
	sum.totalTokens += u.totalTokens;
	sum.cost.input += u.cost.input;
	sum.cost.output += u.cost.output;
	sum.cost.cacheRead += u.cost.cacheRead;
	sum.cost.cacheWrite += u.cost.cacheWrite;
	sum.cost.total += u.cost.total;
}

interface AssistantMessage {
	role: "assistant";
	content: { type: string; text?: string }[];
	usage: Usage;
	stopReason: string;
	errorMessage?: string;
}

// One record of the child's rpc event stream (docs/json.md), other than the responses to our commands.
export type ChildEvent = { type: string; [k: string]: unknown };

// Commands a live child accepts over its rpc stdin (docs/rpc-commands.md). The seam for the subagent registry:
// it can steer, abort or switch the model of a running child.
export interface ChildHandle {
	// false when the child can no longer take commands (its run settled, or it exited)
	send(command: { type: "steer"; message: string } | { type: "abort" }): boolean;
	// set_model, with pi's answer: undefined when the model was switched, else why not
	setModel(provider: string, modelId: string): Promise<string | undefined>;
}

export function runChild(
	spec: ChildSpec,
	signal: AbortSignal | undefined,
	onProgress: (p: Progress) => void,
	onStart?: (handle: ChildHandle) => void,
	onEvent?: (event: ChildEvent) => void,
): Promise<RunResult> {
	if (signal?.aborted) return Promise.reject(new Error("aborted"));

	const started = Date.now();
	const tmp = mkdtempSync(join(tmpdir(), "subagent-"));
	const systemPromptFile = join(tmp, "system-prompt.md");
	writeFileSync(systemPromptFile, spec.systemPrompt);
	const argv = [...spec.args, "--system-prompt", systemPromptFile];

	return new Promise((resolve, reject) => {
		let child: ChildProcessByStdio<Writable, Readable, Readable>;
		try {
			child = spawn(spec.command, argv, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			// spawn throws synchronously for arguments it rejects, such as a NUL byte in the prompt
			rmSync(tmp, { recursive: true, force: true });
			const error = `could not start ${spec.command}: ${(err as Error).message}`;
			return resolve({
				status: "failed",
				output: "",
				usage: emptyUsage(),
				turns: 0,
				durationMs: Date.now() - started,
				error,
				aborted: false,
			});
		}

		// rpc: one JSON command per LF-terminated line. A child that already exited makes the write fail: ignore it,
		// the exit is handled by "close".
		child.stdin.on("error", () => {});
		const send = (command: Record<string, unknown>) => {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		};
		const PROMPT_ID = "subagent-prompt";
		let modelRequests = 0; // set_model request ids
		const requests = new Map<string, (error: string | undefined) => void>(); // commands waiting for pi's response

		const usage = emptyUsage();
		let output = "";
		let turns = 0;
		let lastTool: string | undefined;
		let settled = false;
		let assistantError: string | undefined;
		let turnStop: string | undefined; // stopReason of the assistant message in the turn in progress
		let streamError: string | undefined; // bad stream: we stopped the child
		let hitMaxTurns = false;
		let cutShort = false; // the last allowed turn called tools: partial, whatever the child does next
		let parentAborted = false; // our caller aborted
		let childAborted = false; // the child reported agent_settled with aborted: true
		let stderr = "";
		let pending = Buffer.alloc(0);
		let killTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined; // after settle or the last allowed turn
		let stoppedAfterSettle = false; // settled but did not exit; we stopped it
		let aborting = false; // an rpc abort was sent
		let finished = false; // the child process is gone: no more commands
		let promptError: string | undefined; // pi rejected our prompt command

		const stopChild = () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill("SIGTERM");
			killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			killTimer.unref();
		};

		// Ask the child to stop its run (rpc abort); it settles with aborted: true and we close stdin. Signals only if
		// it does not settle in time.
		const abortChild = () => {
			if (aborting) return; // asked once: a second ask must not move the grace period
			aborting = true;
			send({ type: "abort" });
			if (graceTimer) clearTimeout(graceTimer);
			graceTimer = setTimeout(stopChild, SETTLE_GRACE_MS);
		};

		const onAbort = () => {
			parentAborted = true;
			abortChild();
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const handleEvent = (line: string) => {
			let event: ChildEvent;
			try {
				event = JSON.parse(line);
			} catch {
				streamError = `invalid JSON from pi: ${line.slice(0, 200)}`;
				return stopChild();
			}
			try {
				// rpc has no session header. Responses to our commands: only a failed prompt matters (steer and abort
				// failures surface as the run going on or not settling).
				if (event.type === "response") {
					const answer = requests.get(event.id as string);
					if (answer) {
						requests.delete(event.id as string);
						answer(event.success === true ? undefined : ((event.error as string | undefined) ?? "pi refused"));
					}
					if (event.id === PROMPT_ID && event.success !== true) {
						promptError = (event.error as string | undefined) ?? "pi rejected the prompt";
						stopChild();
					}
					return;
				}
				onEvent?.(event); // every event of the run, for the subagent screen's live view
				// After the last allowed turn only the end of the run matters, but its cost still counts.
				if (hitMaxTurns && event.type !== "agent_settled") {
					const m = event.message as AssistantMessage | undefined;
					if (event.type === "message_end" && m?.role === "assistant") addUsage(usage, m.usage);
					return;
				}
				switch (event.type) {
					case "message_end": {
						const message = event.message as AssistantMessage | { role: string };
						if (message.role !== "assistant") break;
						const m = message as AssistantMessage;
						addUsage(usage, m.usage);
						const text = m.content
							.filter((c) => c.type === "text")
							.map((c) => c.text ?? "")
							.join("");
						if (text.trim() !== "") output = text;
						// pi retries a failed turn: the last assistant message decides.
						turnStop = m.stopReason;
						assistantError = m.stopReason === "error" ? (m.errorMessage ?? "provider error") : undefined;
						break;
					}
					case "tool_execution_start":
						lastTool = event.toolName as string;
						onProgress({ turns: turns + 1, lastTool }); // the turn in progress
						break;
					case "turn_end": {
						// A turn that failed with a provider error is retried by pi: it does not count.
						const stop = (event.message as { stopReason?: string } | undefined)?.stopReason ?? turnStop;
						turnStop = undefined;
						if (stop === "error") break;
						turns++;
						onProgress({ turns, lastTool });
						if (spec.maxTurns !== undefined && turns >= spec.maxTurns) {
							hitMaxTurns = true;
							if (stop === "toolUse") {
								// The turn called tools, so the run wants another turn: it is cut short here.
								cutShort = true;
								abortChild();
							} else {
								// Let the run settle by itself if this was its last turn anyway.
								graceTimer = setTimeout(abortChild, SETTLE_GRACE_MS);
							}
						}
						break;
					}
					case "agent_settled":
						settled = true;
						if (event.aborted === true) childAborted = true;
						if (graceTimer) clearTimeout(graceTimer);
						// The run is over: closing stdin shuts pi down. Signals if it does not exit.
						child.stdin.end();
						graceTimer = setTimeout(() => {
							stoppedAfterSettle = true;
							stopChild();
						}, SETTLE_GRACE_MS);
						break;
				}
			} catch (err) {
				streamError = `bad record from pi (${(err as Error).message}): ${line.slice(0, 200)}`;
				stopChild();
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			if (streamError) return;
			pending = Buffer.concat([pending, chunk]);
			// Split on LF bytes only: JSON strings may hold U+2028/U+2029, which readline treats as line ends.
			for (let nl = pending.indexOf(0x0a); nl !== -1; nl = pending.indexOf(0x0a)) {
				const line = pending.subarray(0, nl).toString("utf8").replace(/\r$/, "");
				pending = pending.subarray(nl + 1);
				if (line.trim() !== "") handleEvent(line);
				if (streamError) return;
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
		});

		const finish = (code: number | null, spawnError?: Error) => {
			if (finished) return; // a failed spawn emits both "error" and "close"
			finished = true;
			if (killTimer) clearTimeout(killTimer);
			if (graceTimer) clearTimeout(graceTimer);
			signal?.removeEventListener("abort", onAbort);
			rmSync(tmp, { recursive: true, force: true });
			for (const answer of requests.values()) answer("the subagent is not running");
			requests.clear();
			if (parentAborted) return reject(new Error("aborted"));

			const base = { output, usage, turns, durationMs: Date.now() - started, aborted: childAborted };
			if (hitMaxTurns && (cutShort || !settled || childAborted)) return resolve({ status: "partial", ...base });
			const stderrTail = stderr.trimEnd().split("\n").slice(-STDERR_LINES).join("\n");
			const error =
				spawnError?.message ??
				streamError ??
				promptError ??
				assistantError ??
				(childAborted ? "child run was aborted" : undefined) ??
				(code !== 0 && !stoppedAfterSettle ? stderrTail || `pi exited with code ${code}` : undefined) ??
				(!settled ? stderrTail || "pi exited before the run settled" : undefined);
			resolve(error === undefined ? { status: "completed", ...base } : { status: "failed", ...base, error });
		};

		send({ id: PROMPT_ID, type: "prompt", message: spec.prompt });
		onStart?.({
			send: (command) => {
				if (settled || finished) return false;
				if (command.type === "abort") abortChild();
				else send(command);
				return true;
			},
			setModel: (provider, modelId) =>
				new Promise((resolve) => {
					if (settled || finished) return resolve("the subagent is not running");
					const id = `subagent-model-${modelRequests++}`;
					requests.set(id, resolve);
					send({ id, type: "set_model", provider, modelId });
				}),
		});

		child.on("error", (err) => finish(null, new Error(`could not start ${spec.command}: ${err.message}`)));
		child.on("close", (code) => finish(code));
	});
}
