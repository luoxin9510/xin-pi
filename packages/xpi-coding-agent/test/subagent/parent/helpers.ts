// Harness for the parent seam: a real parent `pi --mode rpc` with this checkout loaded (and pi's own codemode), on real
// haiku, in a temp repo / HOME / agent dir. The test sends prompts and reads the event stream.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, PI, sandbox } from "../real/helpers.ts";

export type PiEvent = { type: string; at: number; [k: string]: any }; // at: ms since the parent started

export const textOfMessage = (m: any): string =>
	typeof m?.content === "string"
		? m.content
		: (m?.content ?? [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("");

export function startParent(settings: Record<string, unknown> = {}) {
	const s = sandbox();
	mkdirSync(join(s.repo, ".pi"), { recursive: true });
	writeFileSync(
		join(s.repo, ".pi", "settings.json"),
		JSON.stringify({ subagent: { defaultModel: "haiku", ...settings } }),
	);
	const sessionDir = join(s.root, "sessions");
	const args = [
		"--mode",
		"rpc",
		"--model",
		HAIKU,
		"--thinking",
		"low",
		"--approve",
		"--tools",
		"+codemode",
		"--session-dir",
		sessionDir,
	];
	const child: ChildProcessWithoutNullStreams = spawn(PI, args, { cwd: s.repo, stdio: ["pipe", "pipe", "pipe"] });
	const t0 = Date.now();
	const events: PiEvent[] = [];
	let stderr = "";
	let buffer = "";
	const waiters = new Set<() => void>();
	child.stdout.on("data", (c: Buffer) => {
		buffer += c.toString("utf8");
		for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (line.startsWith("{")) events.push({ ...JSON.parse(line), at: Date.now() - t0 });
		}
		for (const w of [...waiters]) w();
	});
	child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

	return {
		sandbox: s,
		sessionDir,
		events,
		stderr: () => stderr,
		prompt(message: string) {
			child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
		},
		// The first event at index `from` or later that satisfies `pred`; rejects after `ms`, naming what was seen.
		waitFor(what: string, pred: (e: PiEvent) => boolean, ms: number, from = 0): Promise<PiEvent> {
			return new Promise((resolve, reject) => {
				const check = () => {
					const found = events.slice(from).find(pred);
					if (!found) return;
					waiters.delete(check);
					clearTimeout(timer);
					resolve(found);
				};
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(
						new Error(
							`timed out after ${ms} ms waiting for ${what}; events: ${events.map((e) => e.type).join(",")}; stderr: ${stderr.slice(-500)}`,
						),
					);
				}, ms);
				waiters.add(check);
				check();
			});
		},
		stop() {
			child.kill("SIGKILL");
		},
		// rpc abort: the same as Esc on main's turn
		abort() {
			child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
		},
		// A graceful quit (SIGTERM: pi emits session_shutdown "quit"); resolves with the exit code.
		quit(): Promise<number | null> {
			return new Promise((resolve) => {
				child.once("exit", (code) => resolve(code));
				child.kill("SIGTERM");
			});
		},
	};
}
