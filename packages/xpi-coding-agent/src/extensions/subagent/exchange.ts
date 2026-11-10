// One exchange with a subagent: wait for its turn in the registry queue, take a concurrency slot, run the child, record
// it in the registry, and tell main about what the user said to it. Main's `Agent` calls and the user typing on a
// subagent screen both come through here, so a subagent never has two processes. Also kept here, because only an
// exchange uses them: the process-wide concurrency limit, the user's steers and the note to main.

import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { registry } from "./registry.ts";
import type { ChildSpec, ParentContext } from "./resolve.ts";
import { addUsage, type Progress, type RunResult, runChild } from "./runner.ts";
import { subagentSessionDir } from "./sessions.ts";
import { responded, stagger } from "./stagger.ts";
import { ensureWorktree, settleWorktree, type WorktreeOutcome } from "./worktree.ts";

// Process-wide: every session in this pi process shares the limit, which the first session's config fixes.
class Semaphore {
	limit: number | undefined;
	private running = 0;
	private waiting: (() => void)[] = [];

	async acquire(signal: AbortSignal | undefined): Promise<void> {
		if (this.running < this.limit!) {
			this.running++;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const go = () => {
				signal?.removeEventListener("abort", cancel);
				this.running++;
				resolve();
			};
			const cancel = () => {
				this.waiting = this.waiting.filter((w) => w !== go);
				reject(new Error("aborted"));
			};
			if (signal?.aborted) return reject(new Error("aborted"));
			signal?.addEventListener("abort", cancel, { once: true });
			this.waiting.push(go);
		});
	}

	release(): void {
		this.running--;
		const next = this.waiting.shift();
		if (next) next();
	}
}

const slots = new Semaphore();

// Only the first call in the process sets the limit; later sessions' maxConcurrent is ignored.
export function limitConcurrency(max: number): void {
	slots.limit ??= max;
}

// What the extension entry (src/index.ts) lends the exchanges: the live config, and how to hand main a note.
interface Host {
	config: () => Config;
	note: (content: string) => void;
}
let host: Host | undefined;

export function bindHost(h: Host): void {
	host = h;
}

export const getHost = (): Host => host!;

// The user's steer texts for the exchange now running, per subagent; the note goes out when that exchange settles.
const userSteers = new Map<string, string[]>();

export function recordSteer(id: string, text: string): void {
	userSteers.set(id, [...(userSteers.get(id) ?? []), text]);
}

export const REPLY_LIMIT = 2000;

export function noteText(type: string, id: string, said: string[], run: RunResult): string {
	const reply = run.status === "failed" ? `(failed: ${run.error})` : run.output;
	const cut = reply.length > REPLY_LIMIT ? `${reply.slice(0, REPLY_LIMIT)}... (cut, ${reply.length} chars)` : reply;
	return [...said.map((s) => `User said to ${type}(${id}): ${s}`), `It replied: ${cut}`].join("\n");
}

export interface ExchangeInfo {
	type: string;
	name?: string; // set by the `Agent` call that starts a named subagent
	description: string;
	color?: string;
	said?: string; // the user's message that started this exchange
}

// After the child has exited: an unchanged worktree is removed with its branch, a changed one stays. A git failure here
// must not lose the run: the worktree is then reported as kept, with a warning.
async function settle(spec: ChildSpec): Promise<{ worktree?: WorktreeOutcome }> {
	const ref = spec.worktree;
	if (!ref) return {};
	try {
		const outcome = await settleWorktree(ref);
		if (outcome.changed === false && outcome.gone) {
			spec.warnings.push(
				`worktree ${ref.path} no longer existed when the run ended (removed by someone else); branch ${ref.branch} was left as it is`,
			);
			return { worktree: { changed: false } };
		}
		return { worktree: outcome };
	} catch (err) {
		spec.warnings.push(`could not inspect or clean up worktree ${ref.path}: ${(err as Error).message}`);
		return { worktree: { changed: true, path: ref.path, branch: ref.branch, files: [], commits: [] } };
	}
}

// A restart keeps what the agent did so far out of its way: its session file is renamed, so the next start (same id)
// begins a new conversation. `<id>.restart-<n>.jsonl.bak` stays next to it for anyone who wants to read it. Not a
// `.jsonl` name: a child finds its session by id among the `.jsonl` files and would continue the shelved one.
function shelveSession(parent: ParentContext, id: string, n: number): void {
	if (!parent.sessionFile) return;
	const dir = subagentSessionDir(parent);
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir)) {
		if (file.endsWith(`_${id}.jsonl`)) renameSync(join(dir, file), join(dir, `${id}.restart-${n}.jsonl.bak`));
	}
}

export async function exchange(
	parent: ParentContext,
	spec: ChildSpec,
	info: ExchangeInfo,
	signal: AbortSignal | undefined,
	onProgress: (p: Progress) => void,
): Promise<RunResult & { worktree?: WorktreeOutcome }> {
	const id = spec.agentId;
	return registry.turn(id, signal, async () => {
		await slots.acquire(signal);
		const staggered = host!.config().staggerStart;
		let openGate: (() => void) | undefined; // ours to call when this child is the one its siblings wait for
		try {
			// Before anything exists: a sibling stopped while it waits here leaves no worktree, no record and no child.
			if (staggered) openGate = await stagger(spec.prefixKey, signal);
			// Created once the slot is ours and before anything is recorded: a git failure leaves no subagent and no child.
			if (spec.worktree) spec.warnings.push(...(await ensureWorktree(spec.worktree)));
			try {
				registry.begin(parent, {
					id,
					type: info.type,
					...(info.name !== undefined ? { name: info.name } : {}),
					description: info.description,
					model: spec.model,
					thinking: spec.thinking,
					color: info.color,
					...(spec.worktree ? { worktree: spec.worktree } : {}),
				});
			} catch (err) {
				await settle(spec); // the worktree exists but no child will run in it
				throw err;
			}
			let run: RunResult;
			const restarted: RunResult[] = []; // the runs a restart ended, oldest first
			try {
				for (;;) {
					const turnsBefore = restarted.reduce((sum, r) => sum + r.turns, 0);
					run = await runChild(
						spec,
						signal,
						(p) => {
							registry.progress(id, p);
							onProgress({ ...p, turns: turnsBefore + p.turns });
						},
						(handle) => registry.attach(id, handle),
						(event) => {
							// The provider has started to answer, so it has stored the prompt prefix. A request that failed
							// before any answer also starts an assistant message, the one that carries the error: nothing was
							// stored.
							const message = event.message as { role?: string; stopReason?: string } | undefined;
							const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
							if (staggered && event.type === "message_start" && message?.role === "assistant" && !failed)
								responded(spec.prefixKey);
							registry.event(id, event);
						},
					);
					// A restart request that lands after the run finished by itself leaves the run as it was.
					if (!(registry.restartRequested(id) && run.aborted)) break;
					registry.carry(id, run);
					restarted.push(run);
					shelveSession(parent, id, restarted.length);
				}
			} catch (err) {
				// runChild rejects only when its caller aborted
				const left = await settle(spec);
				registry.finish(id, "stopped");
				userSteers.delete(id);
				// The call throws, so the result's `worktree` is lost: the error carries where the kept one is.
				if (left.worktree?.changed && err instanceof Error)
					err.message += `; worktree kept: ${left.worktree.path} (branch ${left.worktree.branch})`;
				throw err;
			}
			const kept = await settle(spec);
			// A stop request that lands after the run finished by itself leaves the run as it was.
			if (registry.stopRequested(id) && run.aborted) {
				run = { ...run, status: "failed", error: "stopped by user" };
				registry.finish(id, "stopped", run);
			} else registry.finish(id, run.status, run);
			const said = [...(info.said === undefined ? [] : [info.said]), ...(userSteers.get(id) ?? [])];
			userSteers.delete(id);
			if (said.length > 0) host!.note(noteText(info.type, id, said, run));
			// The caller gets the last start's result, with the turns, time and cost of the restarted runs added.
			for (const earlier of restarted) {
				const usage = structuredClone(earlier.usage);
				addUsage(usage, run.usage);
				run = { ...run, usage, turns: earlier.turns + run.turns, durationMs: earlier.durationMs + run.durationMs };
			}
			return { ...run, ...kept };
		} finally {
			openGate?.();
			slots.release();
		}
	});
}
