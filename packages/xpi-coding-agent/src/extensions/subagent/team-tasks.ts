// Agent teams: the shared task list (spec .scratch/agent-teams/01-agent-teams.md, "Tasks"). One file per task in
// `<agent dir>/tasks/<team>/<id>.json`, plus `next` (the id counter). Every process of the team runs these functions; the
// files are the only shared state. Locks: a task file's own lock for each change; the team lock `<dir>/.lock` as well when a
// task is created or its `blockedBy` changes (so two writers cannot make a cycle); `next.lock` around the counter. The lock
// order is always team, then next or task. Hooks (team-hooks.ts) run before any lock is taken, and the step is checked again
// once the locks are held.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { ensureDir, pidAlive, withLock, withLockFile, writeAtomic } from "./team-files.ts";
import { type HookEnv, runHook } from "./team-hooks.ts";
import { LEAD } from "./team-text.ts";

export const tasksRoot = (): string => join(getAgentDir(), "tasks");

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRec {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	owner?: string;
	blockedBy: string[];
	result?: string;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export const TASK_ID = /^[1-9][0-9]{0,8}$/;

// What a task-list call needs to know about who it is and where it runs.
export interface TaskEnv {
	dir: string; // tasks/<team>
	team: string; // the team's name (session-<session id>)
	me: string; // the caller: a teammate's name, or "lead"
	lead: boolean;
	live(name: string): boolean; // a member that is running, queued or idle (throws when the team's roster cannot be read)
	// The lead tells an assignee; undefined for a teammate (only the lead assigns).
	assign?(task: TaskRec, owner: string): Promise<void>;
	hooks: HookEnv;
}

const taskFile = (dir: string, id: string): string => join(dir, `${id}.json`);
const teamLock = (dir: string): string => join(dir, ".lock");
const nextFile = (dir: string): string => join(dir, "next");

// A task as read from disk, or why it is not one. The directory is a trust boundary: any process may write it.
export function taskProblem(task: unknown): string | undefined {
	if (typeof task !== "object" || task === null || Array.isArray(task)) return "not an object";
	const t = task as Record<string, unknown>;
	if (typeof t.id !== "string" || !TASK_ID.test(t.id)) return "bad id";
	if (typeof t.subject !== "string") return "no subject";
	if (typeof t.description !== "string") return "no description";
	if (!(TASK_STATUSES as readonly unknown[]).includes(t.status)) return "bad status";
	if (t.owner !== undefined && typeof t.owner !== "string") return "bad owner";
	if (!Array.isArray(t.blockedBy) || !t.blockedBy.every((b) => typeof b === "string" && TASK_ID.test(b)))
		return "bad blockedBy";
	if (t.result !== undefined && typeof t.result !== "string") return "bad result";
	if (typeof t.createdBy !== "string") return "bad createdBy";
	if (typeof t.createdAt !== "number" || typeof t.updatedAt !== "number") return "bad time";
	return undefined;
}

function readTask(dir: string, id: string): TaskRec | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(taskFile(dir, id), "utf8"));
		return taskProblem(parsed) === undefined && (parsed as TaskRec).id === id ? (parsed as TaskRec) : undefined;
	} catch {
		return undefined;
	}
}

const idsIn = (dir: string): string[] => {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json") && TASK_ID.test(f.slice(0, -".json".length)))
			.map((f) => f.slice(0, -".json".length))
			.sort((a, b) => Number(a) - Number(b));
	} catch {
		return [];
	}
};

// Every valid task, by id.
export function listTasks(env: Pick<TaskEnv, "dir">): TaskRec[] {
	const out: TaskRec[] = [];
	for (const id of idsIn(env.dir)) {
		const t = readTask(env.dir, id);
		if (t) out.push(t);
	}
	return out;
}

export function getTask(env: Pick<TaskEnv, "dir">, id: string): TaskRec {
	if (!TASK_ID.test(id)) throw new Error(`"${id}" is not a task id`);
	const t = readTask(env.dir, id);
	if (!t) throw new Error(`no task "${id}"`);
	return t;
}

// The ids of the tasks `ids` depends on that are not completed.
export const openBlockers = (dir: string, t: Pick<TaskRec, "blockedBy">): string[] =>
	t.blockedBy.filter((b) => readTask(dir, b)?.status !== "completed");

// `blockedBy` must name tasks that exist and must not lead back to `id` (the team lock is held: the graph cannot change).
function checkBlockedBy(dir: string, id: string | undefined, blockedBy: string[]): void {
	const graph = new Map(listTasks({ dir }).map((t) => [t.id, t.blockedBy]));
	for (const b of blockedBy) {
		if (b === id) throw new Error(`cycle: task ${id} cannot be blocked by itself`);
		if (!graph.has(b)) throw new Error(`unknown task "${b}" in blockedBy`);
	}
	if (id === undefined) return; // a new task is referenced by nothing yet
	const seen = new Set<string>();
	const walk = (from: string, path: string[]): void => {
		if (seen.has(from)) return;
		seen.add(from);
		for (const next of graph.get(from) ?? []) {
			if (next === id) throw new Error(`cycle: ${[id, ...path, from, id].join(" -> ")}`);
			walk(next, [...path, from]);
		}
	};
	for (const b of blockedBy) walk(b, []);
}

const asIds = (value: unknown, what: string): string[] => {
	if (!Array.isArray(value)) throw new Error(`${what} must be a list of task ids`);
	const ids = value.map((v) => String(v));
	for (const id of ids) if (!TASK_ID.test(id)) throw new Error(`"${id}" is not a task id`);
	return [...new Set(ids)];
};

const refusedBy = (feedback: string): Error => new Error(`refused by a hook: ${feedback}`);

// --- create

export interface CreateInput {
	subject: string;
	description?: string;
	blockedBy?: string[];
}

export async function createTask(env: TaskEnv, input: CreateInput): Promise<TaskRec> {
	if (typeof input.subject !== "string" || input.subject.trim() === "") throw new Error("`subject` is required");
	const blockedBy = input.blockedBy === undefined ? [] : asIds(input.blockedBy, "blockedBy");
	const now = Date.now();
	const draft = {
		subject: input.subject.trim(),
		description: input.description ?? "",
		status: "pending" as const,
		blockedBy,
		createdBy: env.me,
	};
	// The hook runs before any lock; the task has no id yet.
	const verdict = await runHook(env.hooks, "task_created", { team: env.team, task: draft, by: env.me });
	if (verdict.blocked) throw refusedBy(verdict.feedback);
	ensureDir(env.dir);
	return withLockFile(teamLock(env.dir), `the task list of ${env.team}`, async () => {
		checkBlockedBy(env.dir, undefined, blockedBy); // again, now: a dependency may be gone
		const id = await withLock(nextFile(env.dir), () => {
			let stored = 0;
			try {
				stored = Number.parseInt(readFileSync(nextFile(env.dir), "utf8"), 10);
			} catch {
				// no counter yet
			}
			const highest = Number(idsIn(env.dir).at(-1) ?? 0);
			const n = Math.max(Number.isInteger(stored) ? stored : 0, highest + 1, 1);
			writeAtomic(nextFile(env.dir), String(n + 1));
			return String(n);
		});
		const task: TaskRec = { id, ...draft, createdAt: now, updatedAt: now };
		writeAtomic(taskFile(env.dir, id), JSON.stringify(task));
		return task;
	});
}

// --- update

export interface UpdateInput {
	id: string;
	status?: TaskStatus;
	owner?: string;
	subject?: string;
	description?: string;
	blockedBy?: string[];
	result?: string;
}

export interface UpdateResult {
	task: TaskRec;
	warning?: string; // the change is made, but something after it failed (the assignee could not be told)
}

const forbidden = (what: string): Error => new Error(`forbidden: ${what}`);

// What the change to `t` is, or why it is refused. Pure but for reads of the blockers and the roster.
function plan(env: TaskEnv, t: TaskRec, i: UpdateInput): { next: TaskRec; assigned?: string } {
	const next: TaskRec = { ...t, blockedBy: [...t.blockedBy] };
	const owns = env.lead || t.owner === env.me;
	if (i.subject !== undefined || i.description !== undefined || i.blockedBy !== undefined) {
		if (!env.lead && t.createdBy !== env.me)
			throw forbidden(
				`only its creator (${t.createdBy}) or the lead can change task ${t.id}'s subject, description or blockedBy`,
			);
		if (i.subject !== undefined) {
			if (typeof i.subject !== "string" || i.subject.trim() === "") throw new Error("`subject` cannot be empty");
			next.subject = i.subject.trim();
		}
		if (i.description !== undefined) next.description = i.description;
		if (i.blockedBy !== undefined) next.blockedBy = asIds(i.blockedBy, "blockedBy");
	}
	// A claim of a task already in progress: the owner's own is nothing; another member's is a conflict while its owner is
	// live, and a take-over when that owner is gone.
	const reclaim = i.status === "in_progress" && t.status === "in_progress" && t.owner !== env.me;
	if (reclaim) {
		if (i.owner !== undefined && i.owner !== env.me)
			throw forbidden(
				"a claim is for yourself. The lead gives a task to someone else with `owner` alone, no status",
			);
		if (t.owner !== undefined && env.live(t.owner)) throw new Error(`conflict: ${t.owner} owns task ${t.id}`);
		next.owner = env.me;
	}
	const changesStatus = i.status !== undefined && i.status !== t.status;
	let assigned: string | undefined;
	if (changesStatus) {
		const to = i.status!;
		if (!(TASK_STATUSES as readonly unknown[]).includes(to)) throw new Error(`unknown status "${String(to)}"`);
		const via = `${t.status} -> ${to}`;
		if (t.status === "pending" && to === "in_progress") {
			if (i.owner !== undefined && i.owner !== env.me)
				throw forbidden(
					"a claim is for yourself. The lead gives a task to someone else with `owner` alone, no status",
				);
			const open = openBlockers(env.dir, next);
			if (open.length > 0) throw new Error(`blocked: task ${t.id} waits for ${open.map((b) => `#${b}`).join(", ")}`);
			if (t.owner !== undefined && t.owner !== env.me && env.live(t.owner))
				throw new Error(`conflict: ${t.owner} owns task ${t.id}`);
			next.status = "in_progress";
			next.owner = env.me;
		} else if (t.status === "in_progress" && to === "completed") {
			if (!owns) throw forbidden(`only the owner (${t.owner ?? "none"}) or the lead completes task ${t.id}`);
			next.status = "completed";
		} else if (t.status === "in_progress" && to === "pending") {
			if (!owns) throw forbidden(`only the owner (${t.owner ?? "none"}) or the lead releases task ${t.id}`);
			next.status = "pending";
			delete next.owner;
		} else if (t.status === "completed" && to === "pending") {
			if (!env.lead) throw forbidden("only the lead reopens a completed task");
			next.status = "pending";
			delete next.owner;
		} else if (t.status === "pending" && to === "completed") {
			throw new Error(
				`a task is claimed before it is completed: task ${t.id} is pending (${via}); set in_progress first`,
			);
		} else {
			throw new Error(
				`task ${t.id} is completed: the lead reopens it (status pending) before it is claimed again (${via})`,
			);
		}
	} else if (i.owner !== undefined) {
		// owner without a status change: the lead gives the task to a member (or takes the owner away)
		if (!env.lead) throw forbidden("only the lead assigns a task. To take one, claim it: status in_progress");
		if (t.status !== "pending")
			throw new Error(`conflict: task ${t.id} is ${t.status}; only a pending task is assigned. Release it first`);
		if (i.owner === "") delete next.owner;
		else if (i.owner !== t.owner) {
			if (!env.live(i.owner)) throw new Error(`no live member "${i.owner}" to give task ${t.id} to`);
			next.owner = i.owner;
			if (i.owner !== LEAD) assigned = i.owner;
		}
	}
	if (i.result !== undefined) {
		if (!owns) throw forbidden(`only the owner (${t.owner ?? "none"}) or the lead sets task ${t.id}'s result`);
		next.result = i.result;
	}
	return { next, ...(assigned !== undefined ? { assigned } : {}) };
}

const sameTask = (a: TaskRec, b: TaskRec): boolean =>
	JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });

export async function updateTask(env: TaskEnv, input: UpdateInput): Promise<UpdateResult> {
	const id = input.id;
	if (typeof id !== "string" || !TASK_ID.test(id)) throw new Error(`"${String(id)}" is not a task id`);
	const before = getTask(env, id);
	// task_completed runs before any lock. Only for a change that looks allowed now; the locked check below decides again.
	if (input.status === "completed" && before.status === "in_progress" && (env.lead || before.owner === env.me)) {
		const draft: TaskRec = { ...before, status: "completed", result: input.result ?? before.result };
		const verdict = await runHook(env.hooks, "task_completed", { team: env.team, task: draft, by: env.me });
		if (verdict.blocked) throw refusedBy(verdict.feedback);
	}
	const run = async (): Promise<{ task: TaskRec; assigned?: string }> =>
		withLock(taskFile(env.dir, id), () => {
			const t = readTask(env.dir, id);
			if (!t) throw new Error(`no task "${id}"`);
			const { next, assigned } = plan(env, t, input);
			if (input.blockedBy !== undefined) checkBlockedBy(env.dir, id, next.blockedBy);
			if (sameTask(t, next)) return { task: t };
			next.updatedAt = Date.now();
			writeAtomic(taskFile(env.dir, id), JSON.stringify(next));
			return { task: next, ...(assigned !== undefined ? { assigned } : {}) };
		});
	// A change to `blockedBy` also takes the team lock, so that two of them cannot make a cycle between them.
	const done =
		input.blockedBy !== undefined
			? await withLockFile(teamLock(env.dir), `the task list of ${env.team}`, run)
			: await run();
	if (done.assigned === undefined) return { task: done.task };
	try {
		await env.assign?.(done.task, done.assigned);
		return { task: done.task };
	} catch (err) {
		return {
			task: done.task,
			warning: `task ${id} is assigned to ${done.assigned}, but telling it failed: ${(err as Error).message}`,
		};
	}
}

// --- views

export const assignmentText = (t: Pick<TaskRec, "id" | "subject">): string =>
	`Task #${t.id} is assigned to you: ${t.subject}. Read it with TaskGet({ id: "${t.id}" }); claim it with TaskUpdate({ id: "${t.id}", status: "in_progress" }) when you start.`;

// One line of a list: id, status, owner, subject, and the blockers still open.
export function taskLine(dir: string, t: TaskRec): string {
	const open = t.status === "completed" ? [] : openBlockers(dir, t);
	return `#${t.id} [${t.status}] ${t.owner ?? "-"}: ${t.subject}${open.length > 0 ? ` (blocked by ${open.map((b) => `#${b}`).join(", ")})` : ""}`;
}

export function taskText(dir: string, t: TaskRec): string {
	const open = t.status === "completed" ? [] : openBlockers(dir, t);
	return [
		taskLine(dir, t),
		`created by ${t.createdBy}`,
		...(t.blockedBy.length > 0
			? [`blockedBy: ${t.blockedBy.map((b) => `#${b}`).join(", ")}${open.length === 0 ? " (all completed)" : ""}`]
			: []),
		...(t.description ? ["", t.description] : []),
		...(t.result ? ["", `Result: ${t.result}`] : []),
	].join("\n");
}

// --- liveness and retention

// A member stopped: its in_progress tasks go back to pending, with no owner.
export async function releaseTasks(dir: string, owner: string): Promise<string[]> {
	const released: string[] = [];
	for (const id of idsIn(dir)) {
		const t = readTask(dir, id);
		if (!t || t.status !== "in_progress" || t.owner !== owner) continue;
		await withLock(taskFile(dir, id), () => {
			const now = readTask(dir, id);
			if (!now || now.status !== "in_progress" || now.owner !== owner) return;
			const { owner: _gone, ...rest } = now;
			writeAtomic(taskFile(dir, id), JSON.stringify({ ...rest, status: "pending", updatedAt: Date.now() }));
			released.push(id);
		});
	}
	return released;
}

const DAY_MS = 86_400_000;

// Remove the task directories of old teams: `session-*` directories whose newest file is older than `days`, but never the
// current team's, nor one whose lead is still running (its team directory has a live `leadPid`). Returns what it removed.
export function sweepTasks(root: string, keep: string, days: number, teamsDir: string, now = Date.now()): string[] {
	const removed: string[] = [];
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return removed;
	}
	for (const name of names) {
		if (name === keep || !name.startsWith("session-")) continue;
		const dir = join(root, name);
		let newest = 0;
		try {
			for (const f of readdirSync(dir)) {
				if (f.startsWith(".") || f.endsWith(".lock")) continue;
				newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
			}
			if (newest === 0) newest = statSync(dir).mtimeMs;
		} catch {
			continue;
		}
		if (now - newest <= days * DAY_MS) continue;
		try {
			const config = JSON.parse(readFileSync(join(teamsDir, name, "config.json"), "utf8")) as { leadPid?: number };
			if (Number.isInteger(config.leadPid) && pidAlive(config.leadPid!)) continue;
		} catch {
			// no team directory: nothing runs it
		}
		if (!existsSync(dir)) continue;
		rmSync(dir, { recursive: true, force: true });
		removed.push(name);
	}
	return removed;
}
