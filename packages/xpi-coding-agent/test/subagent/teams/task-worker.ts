// A process of the task-list test (tasks-processes.test.ts): waits for the start time, then does its part on the task
// directory and prints a JSON line with what happened.
//   create <dir> <startAt> <n>          creates n tasks, prints their ids
//   edge <dir> <startAt> <pairs> <x|y>  for each pair (2i+1, 2i+2): x makes 2i+1 wait for 2i+2, y the reverse; prints each outcome
import { createTask, type TaskEnv, updateTask } from "../../../src/extensions/subagent/team-tasks.ts";

const [mode, dir, startAt, count, side] = process.argv.slice(2) as [string, string, string, string, string?];
const env: TaskEnv = {
	dir,
	team: "session-w",
	me: "lead",
	lead: true,
	live: () => true,
	hooks: { bus: undefined, warn: () => {} },
};
const until = async (at: number) => {
	while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));
};
await until(Number(startAt));
if (mode === "create") {
	const ids: string[] = [];
	for (let i = 0; i < Number(count); i++) ids.push((await createTask(env, { subject: `p${process.pid}-${i}` })).id);
	console.log(JSON.stringify(ids));
} else {
	const out: string[] = [];
	for (let i = 0; i < Number(count); i++) {
		await until(Number(startAt) + i * 15); // both sides try the same pair at the same moment
		const [mine, other] = side === "x" ? [2 * i + 1, 2 * i + 2] : [2 * i + 2, 2 * i + 1];
		try {
			await updateTask(env, { id: String(mine), blockedBy: [String(other)] });
			out.push("ok");
		} catch (err) {
			out.push((err as Error).message.startsWith("cycle") ? "cycle" : (err as Error).message);
		}
	}
	console.log(JSON.stringify(out));
}
