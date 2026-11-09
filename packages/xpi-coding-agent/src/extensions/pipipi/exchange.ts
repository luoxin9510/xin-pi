// One exchange with a subagent: wait for its turn in the registry queue, take a concurrency slot, run the child, record
// it in the registry, and tell main about what the user said to it. Main's `Agent` calls and the user typing on a
// subagent screen both come through here, so a subagent never has two processes. Also kept here, because only an
// exchange uses them: the process-wide concurrency limit, the user's steers and the note to main.

import type { Config } from "./config.ts";
import { registry } from "./registry.ts";
import type { ChildSpec, ParentContext } from "./resolve.ts";
import { type Progress, type RunResult, runChild } from "./runner.ts";
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
		try {
			// Created once the slot is ours and before anything is recorded: a git failure leaves no subagent and no child.
			if (spec.worktree) spec.warnings.push(...(await ensureWorktree(spec.worktree)));
			try {
				registry.begin(parent, {
					id,
					type: info.type,
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
			try {
				run = await runChild(
					spec,
					signal,
					(p) => {
						registry.progress(id, p);
						onProgress(p);
					},
					(handle) => registry.attach(id, handle),
					(event) => registry.event(id, event),
				);
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
			return { ...run, ...kept };
		} finally {
			slots.release();
		}
	});
}
