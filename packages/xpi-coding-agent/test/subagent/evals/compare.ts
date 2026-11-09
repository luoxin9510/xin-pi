// npm run compare -- [--runs N]
// Codemode-only vs direct tools for children, on the same multi-step tasks (real haiku). For each task and mode:
// turns, wall time and cost per run, averaged over N runs. Mode "codemode-only" is the default (childCodemode "only");
// "direct tools" is childCodemode "inherit" with the agent's tools listed by name, so the child calls Read/Grep/Bash itself.

import { directTool, fixture, intFlag } from "./harness.ts";

const runs = intFlag("--runs", 3);

interface Task {
	name: string;
	files: Record<string, string>;
	prompt: string;
	answer: string; // the output must include it
}

const tasks: Task[] = [
	{
		name: "5 reads + grep",
		files: {
			"data/a1.txt": "n=11\n",
			"data/a2.txt": "n=22\n",
			"data/a3.txt": "n=33\n",
			"data/a4.txt": "n=44\n",
			"data/a5.txt": "n=55\n",
			"src/x.ts": "// TODO one\n// TODO two\n",
			"src/y.ts": "// TODO three\n",
			"src/z.ts": "const z = 1;\n",
		},
		prompt:
			"Read the five files data/a1.txt to data/a5.txt and add up their n values. Also count the lines containing TODO under src. Reply exactly like: SUM=<number> TODO=<number>",
		answer: "SUM=165 TODO=3",
	},
	{
		name: "search + read chain",
		files: {
			"lib/m1.ts": "export const a = 1;\n",
			"lib/m2.ts": "export const b = 2;\n",
			"lib/m3.ts": "export function widgetFactory() { return 'notes/k-9.txt'; }\n",
			"lib/m4.ts": "export const d = 4;\n",
			"notes/k-9.txt": "The secret is HERON-5521.\n",
			"notes/k-1.txt": "The secret is WRONG.\n",
		},
		prompt:
			"Find which file under lib defines widgetFactory. It returns a path; read that file and reply with the secret code in it only.",
		answer: "HERON-5521",
	},
];

const modes = [
	{ name: "codemode-only", settings: {}, tools: undefined as string | undefined },
	{ name: "direct tools", settings: { childCodemode: "inherit" }, tools: "Read, Grep, Glob, Bash" },
];

const controller = new AbortController();
const rows: string[] = [];
for (const task of tasks) {
	for (const mode of modes) {
		const rs = await Promise.all(
			Array.from({ length: runs }, async () => {
				const extra: Record<string, string> = mode.tools
					? {
							".claude/agents/worker.md": `---\nname: worker\ndescription: Does the task\ntools: ${mode.tools}\n---\nDo the task, then reply as asked.\n`,
						}
					: {};
				const t = await directTool(fixture({ ...task.files, ...extra }), controller.signal, {
					settings: mode.settings,
				});
				const r = await t.call({ prompt: task.prompt, subagent_type: mode.tools ? "worker" : "general-purpose" });
				return {
					turns: r.turns,
					ms: r.durationMs,
					cost: r.usage.cost.total,
					ok: r.status === "completed" && r.output.includes(task.answer) ? 1 : 0,
				};
			}),
		);
		const avg = (k: "turns" | "ms" | "cost") => rs.reduce((s, r) => s + r[k], 0) / rs.length;
		const ok = rs.reduce((s, r) => s + r.ok, 0);
		rows.push(
			`| ${task.name} | ${mode.name} | ${ok}/${rs.length} | ${avg("turns").toFixed(1)} | ${(avg("ms") / 1000).toFixed(1)} | $${avg("cost").toFixed(5)} |`,
		);
	}
}
console.log("| task | mode | correct | turns | wall s | cost |\n|---|---|---|---|---|---|");
console.log(rows.join("\n"));
