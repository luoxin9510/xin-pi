// Agent teams: the task list across processes (every member is one). Real processes, each killable: a watchdog kills them on a
// failure or a hang, and an after hook kills any left.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTask, listTasks, type TaskEnv } from "../../../src/extensions/subagent/team-tasks.ts";

const worker = fileURLToPath(new URL("./task-worker.ts", import.meta.url));
const children = new Set<ChildProcess>();
const scratch: string[] = [];
const scratchDir = () => {
	const d = mkdtempSync(join(tmpdir(), "taskproc-"));
	scratch.push(d);
	return join(d, "session-w");
};
const killAll = () => {
	for (const c of children) c.kill("SIGKILL");
	children.clear();
};
after(() => {
	killAll();
	for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function runWorker(args: string[]): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", worker, ...args], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		children.add(child);
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("error", reject);
		child.on("exit", (code) => {
			children.delete(child);
			if (code !== 0) return reject(new Error(`worker exited ${code}`));
			resolve(JSON.parse(out.trim().split("\n").at(-1)!));
		});
	});
}

const lead = (dir: string): TaskEnv => ({
	dir,
	team: "session-w",
	me: "lead",
	lead: true,
	live: () => true,
	hooks: { bus: undefined, warn: () => {} },
});

test("several processes creating tasks at once get distinct, consecutive ids", { timeout: 90_000 }, async () => {
	const dir = scratchDir();
	const watchdog = setTimeout(killAll, 70_000);
	watchdog.unref();
	try {
		const startAt = String(Date.now() + 800);
		const results = (await Promise.all(
			Array.from({ length: 4 }, () => runWorker(["create", dir, startAt, "15"])),
		)) as string[][];
		const ids = results
			.flat()
			.map(Number)
			.sort((a, b) => a - b);
		assert.deepEqual(
			ids,
			Array.from({ length: 60 }, (_, i) => i + 1),
			"no id given twice, none skipped",
		);
		assert.equal(listTasks({ dir }).length, 60, "and every task has its own file");
		assert.deepEqual(
			readdirSync(dir).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp")),
			[],
			"no lock or temporary file left",
		);
	} finally {
		clearTimeout(watchdog);
		killAll();
	}
});

test(
	"a cycle two processes try to make at once is refused: for each pair at most one edge exists",
	{ timeout: 90_000 },
	async () => {
		const dir = scratchDir();
		const pairs = 40;
		for (let i = 0; i < pairs * 2; i++) await createTask(lead(dir), { subject: `t${i + 1}` });
		const watchdog = setTimeout(killAll, 70_000);
		watchdog.unref();
		try {
			const startAt = String(Date.now() + 800);
			const [x, y] = (await Promise.all([
				runWorker(["edge", dir, startAt, String(pairs), "x"]),
				runWorker(["edge", dir, startAt, String(pairs), "y"]),
			])) as [string[], string[]];
			const tasks = new Map(listTasks({ dir }).map((t) => [t.id, t.blockedBy]));
			for (let i = 0; i < pairs; i++) {
				const a = tasks.get(String(2 * i + 1))!;
				const b = tasks.get(String(2 * i + 2))!;
				assert.ok(!(a.length > 0 && b.length > 0), `pair ${i}: both edges were made, a cycle`);
				assert.ok(x[i] === "ok" || x[i] === "cycle", `pair ${i}: ${x[i]}`);
				assert.ok(y[i] === "ok" || y[i] === "cycle", `pair ${i}: ${y[i]}`);
				assert.equal(
					[x[i], y[i]].filter((r) => r === "ok").length,
					1,
					`pair ${i}: exactly one of the two wins (${x[i]}, ${y[i]})`,
				);
			}
		} finally {
			clearTimeout(watchdog);
			killAll();
		}
	},
);
