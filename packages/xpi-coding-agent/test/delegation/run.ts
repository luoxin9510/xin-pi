// npm run eval:delegation -- [--long] [--runs N] [--only <substring>] [--arms solo,delegate,relay] [--parallel N]
//                            [--force] [--selftest] [--cli <path to cli.js>]
// --long runs the long tasks (long-tasks.ts: features of this repository built again from their spec, and the
// multi-agent tasks) in place of the small ones.
// --cli runs another build, such as a checkout of an older commit (`<checkout>/packages/xpi-coding-agent/dist/bundle/
// cli.js`), for a before/after comparison. Default: this checkout's build.
//
// Tasks with `driver: "rpc"` (the multi-agent tasks) run through `xpi --mode rpc` (rpc-driver.ts), where scripts can
// run in the background, and report how main waited for its agents: `wakes` (main's turns started after the first),
// `timeoutMsSet`, `agentsStoppedByDeadline` and `released`. The other tasks run in print mode (`-p`).
//
// The same tasks, three ways of working, on real models:
//   solo      the main model alone (the subagent and relay extensions are off)
//   delegate  the main model with the Agent tool (subagents on haiku)
//   relay     relay/auto: the main model is the lead, haiku is the worker
// codemode is on in every arm. By default the prompt never mentions delegation: whether to delegate is the model's
// decision, and that decision is what is measured, next to the result. With --force the delegate and relay arms are
// told to delegate, which measures what delegation costs and gains when it is used (solo is not run then, compare
// with a run without the flag).
//
// EVAL_MAIN=<provider/model>  the main model (default: haiku, which tests the harness for cents)
// EVAL_BUDGET=<dollars>       stop starting runs once this much is spent (default 20)
// EVAL_KEEP=1                 keep the directory (repository and sessions) of a passing run too; a failing run's is
//                             always kept, and listed with the failures
// Results: test/delegation/results/<stamp>.json (ignored by git).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyUserAuth } from "../subagent/user-auth.ts";
import { longTasks, SOLUTION_PATH } from "./long-tasks.ts";
import { type RpcEnd, runRpc, type WaitMetrics, waitMetrics } from "./rpc-driver.ts";
import { tasks as smallTasks, type Task } from "./tasks.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const PI = resolve(flag("--cli") ?? join(ROOT, "dist", "bundle", "cli.js"));
const HAIKU = "anthropic/claude-haiku-5-5";
const MAIN = process.env.EVAL_MAIN ?? HAIKU;
const BUDGET = Number(process.env.EVAL_BUDGET ?? 20);
const USER_AUTH = join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
const RUN_TIMEOUT_MS = 900_000;
const tasks = process.argv.includes("--long") ? longTasks : smallTasks;

type Arm = "solo" | "delegate" | "relay";
const ARMS: Arm[] = ["solo", "delegate", "relay"];

const runs = Number(flag("--runs") ?? 1);
const only = flag("--only");
const parallel = Number(flag("--parallel") ?? 3);
const force = process.argv.includes("--force");
const arms = (flag("--arms")?.split(",") as Arm[] | undefined) ?? (force ? ARMS.filter((arm) => arm !== "solo") : ARMS);

const FORCED: Record<Arm, string> = {
	solo: "",
	delegate:
		"\n\nDo this through subagents: split the work and give the parts to agents with the Agent tool (in parallel where the parts are independent). Do the reading and editing in the agents, not yourself; you check their results.",
	relay: "\n\nDo not do the work yourself: look at what is needed, then give it to the worker with the handover tool, with acceptance commands where a command can tell that the work is done. Review what comes back.",
};

interface Usage {
	requests: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
}

const noUsage = (): Usage => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });

interface Row {
	task: string;
	expect: Task["expect"];
	arm: Arm;
	run: number;
	pass: boolean;
	why?: string;
	ms: number;
	/** The main session, by model. */
	main: Record<string, Usage>;
	/** Subagent sessions, by model. */
	children: Record<string, Usage>;
	subagents: number;
	handovers: number;
	/** Largest prompt of a main-model request in the main session. */
	peakContext: number;
	cost: number;
	/** A session mentions this checkout's source of the feature: the run may have read the solution. */
	leak: boolean;
	dir: string;
	/** rpc-driver tasks: how main waited for its agents, and how the run's end was found. */
	wait?: WaitMetrics & { wakes: number; endedBy: RpcEnd; sawStatus: boolean };
}

function settingsFor(arm: Arm): Record<string, unknown> {
	if (arm === "solo") return { extensions: ["-builtin:subagent", "-builtin:relay"] };
	if (arm === "delegate") return { extensions: ["-builtin:relay"], subagent: { defaultModel: "haiku" } };
	return {
		subagent: { defaultModel: "haiku" },
		relay: {
			lead: MAIN,
			worker: HAIKU,
			leadThinking: { plan: "medium", review: "medium" },
			workerThinking: "medium",
		},
	};
}

function childEnv(home: string, agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		// Only the copied login may be used: a provider key in the shell would pick another provider or account.
		if (/_API_KEY$|_AUTH_TOKEN$|^CLAUDE_CODE_|^XPI_SUBAGENT_/.test(key)) continue;
		env[key] = value;
	}
	return { ...env, HOME: home, XPI_CODING_AGENT_DIR: agentDir, XPI_SKIP_VERSION_CHECK: "1", XPI_TELEMETRY: "0" };
}

function sessionFiles(dir: string): string[] {
	return (readdirSync(dir, { recursive: true }) as string[])
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(dir, name));
}

interface Entry {
	type: string;
	details?: { relay?: boolean };
	message?: {
		role: string;
		provider?: string;
		model?: string;
		usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
	};
}

function readUsage(file: string): { byModel: Record<string, Usage>; handovers: number; peak: number } {
	const byModel: Record<string, Usage> = {};
	let handovers = 0;
	let peak = 0;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type === "compaction" && entry.details?.relay) handovers++;
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "assistant" || !message.usage) continue;
		const model = `${message.provider}/${message.model}`;
		byModel[model] ??= noUsage();
		const usage = byModel[model];
		usage.requests++;
		usage.input += message.usage.input;
		usage.cacheRead += message.usage.cacheRead;
		usage.cacheWrite += message.usage.cacheWrite;
		usage.output += message.usage.output;
		usage.cost += message.usage.cost?.total ?? 0;
		if (model === MAIN)
			peak = Math.max(peak, message.usage.input + message.usage.cacheRead + message.usage.cacheWrite);
	}
	return { byModel, handovers, peak };
}

function merge(into: Record<string, Usage>, from: Record<string, Usage>): void {
	for (const [model, usage] of Object.entries(from)) {
		into[model] ??= noUsage();
		for (const key of Object.keys(usage) as (keyof Usage)[]) into[model][key] += usage[key];
	}
}

const sumCost = (byModel: Record<string, Usage>) => Object.values(byModel).reduce((sum, usage) => sum + usage.cost, 0);

async function runOne(task: Task, arm: Arm, run: number): Promise<Row> {
	const dir = mkdtempSync(join(tmpdir(), "delegation-eval-"));
	const repo = join(dir, "repo");
	const home = join(dir, "home");
	const agentDir = join(dir, "pi-agent");
	const sessionDir = join(dir, "sessions");
	for (const path of [repo, home, agentDir, sessionDir]) mkdirSync(path, { recursive: true });
	copyUserAuth(USER_AUTH, join(agentDir, "auth.json")); // a copy: nothing in the user's agent directory is touched
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "anthropic",
			defaultModel: "claude-haiku-5-5",
			packages: [],
			quietStartup: true,
		}),
	);
	task.setup(repo);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], {
			cwd: repo,
			stdio: "ignore",
		});
	if (!existsSync(join(repo, ".git"))) git("init", "-q");
	mkdirSync(join(repo, ".pi"), { recursive: true });
	writeFileSync(join(repo, ".pi", "settings.json"), JSON.stringify(settingsFor(arm)));
	// The start state is one commit, so the work shows as a diff against it.
	git("add", "-A");
	git("commit", "-q", "--no-verify", "-m", "start");

	const model = arm === "relay" ? "relay/auto" : MAIN;
	const prompt = task.prompt + (force ? FORCED[arm] : "");
	const options = [
		"--model",
		model,
		"--thinking",
		"medium",
		"--approve",
		"--tools",
		"+codemode",
		"--session-dir",
		sessionDir,
	];
	const started = Date.now();
	let stderr = "";
	let rpc: Awaited<ReturnType<typeof runRpc>> | undefined;
	if (task.driver === "rpc")
		rpc = await runRpc({
			cli: PI,
			cwd: repo,
			env: childEnv(home, agentDir),
			args: options,
			prompt,
			sessionDir,
			capMs: task.timeoutMs ?? RUN_TIMEOUT_MS,
		});
	const args = ["-p", ...options, prompt];
	const exit = rpc
		? rpc.error
		: await new Promise<string | undefined>((done) => {
				const child = spawn(PI, args, {
					cwd: repo,
					env: childEnv(home, agentDir),
					stdio: ["ignore", "ignore", "pipe"],
					detached: true,
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr = (stderr + chunk.toString("utf8")).slice(-2000);
				});
				const timer = setTimeout(() => {
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						// already gone
					}
					done("timed out");
				}, task.timeoutMs ?? RUN_TIMEOUT_MS);
				child.on("exit", (code) => {
					clearTimeout(timer);
					done(
						code === 0
							? undefined
							: `xpi exited with ${code}: ${stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`,
					);
				});
			});
	const ms = Date.now() - started;

	const main: Record<string, Usage> = {};
	const children: Record<string, Usage> = {};
	let subagents = 0;
	let handovers = 0;
	let peakContext = 0;
	let leak = false;
	const metrics: WaitMetrics = { timeoutMsSet: 0, agentsStoppedByDeadline: 0, released: 0 };
	for (const file of sessionFiles(sessionDir)) {
		const usage = readUsage(file);
		if (readFileSync(file, "utf8").includes(SOLUTION_PATH)) leak = true;
		if (file.includes(`${join("", "subagents")}`)) {
			subagents++;
			merge(children, usage.byModel);
		} else {
			merge(main, usage.byModel);
			const wait = waitMetrics(file);
			for (const key of Object.keys(metrics) as (keyof WaitMetrics)[]) metrics[key] += wait[key];
			handovers += usage.handovers;
			peakContext = Math.max(peakContext, usage.peak);
		}
	}
	const why = exit ?? task.check(repo);
	return {
		task: task.name,
		expect: task.expect,
		arm,
		run,
		pass: why === undefined,
		why,
		ms,
		main,
		children,
		subagents,
		handovers,
		peakContext,
		cost: sumCost(main) + sumCost(children),
		leak,
		dir,
		...(rpc ? { wait: { ...metrics, wakes: rpc.wakes, endedBy: rpc.endedBy, sawStatus: rpc.sawStatus } } : {}),
	};
}

/** Every task must fail before any work is done: a check that passes on the untouched repository measures nothing. */
function selftest(): void {
	for (const task of tasks) {
		const repo = mkdtempSync(join(tmpdir(), "delegation-selftest-"));
		task.setup(repo);
		const why = task.check(repo);
		console.log(
			`${why === undefined ? "BAD  passes untouched" : "ok  "}  ${task.name}${why ? `  (${why.slice(0, 90)})` : ""}`,
		);
		rmSync(repo, { recursive: true, force: true });
		if (why === undefined) process.exitCode = 1;
	}
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function report(rows: Row[]): void {
	const mainOf = (row: Row) => row.main[MAIN] ?? noUsage();
	console.log(
		`\nmain model ${MAIN}; subagents and the relay worker on ${HAIKU}; ${runs} run(s) per cell${force ? "; delegation forced by the prompt" : ""}; build ${PI}`,
	);
	console.log(
		"main: tokens of the main model in the main session (fresh input + cache write / cache read / output)\n",
	);
	const header = [
		"task",
		"arm",
		"pass",
		"time",
		"cost",
		"main $",
		"main in+write",
		"main read",
		"main out",
		"peak ctx",
		"agents",
		"handovers",
		...(rows.some((row) => row.wait) ? ["wakes", "timeout_ms", "deadline stops", "released"] : []),
	];
	const table: string[][] = [header];
	for (const task of tasks) {
		for (const arm of arms) {
			const cell = rows.filter((row) => row.task === task.name && row.arm === arm);
			if (cell.length === 0) continue;
			table.push([
				arm === arms[0] ? `${task.name} [${task.expect}]` : "",
				arm,
				`${cell.filter((row) => row.pass).length}/${cell.length}`,
				`${avg(cell.map((row) => row.ms / 1000)).toFixed(0)}s`,
				`$${avg(cell.map((row) => row.cost)).toFixed(4)}`,
				`$${avg(cell.map((row) => mainOf(row).cost)).toFixed(4)}`,
				k(avg(cell.map((row) => mainOf(row).input + mainOf(row).cacheWrite))),
				k(avg(cell.map((row) => mainOf(row).cacheRead))),
				k(avg(cell.map((row) => mainOf(row).output))),
				k(avg(cell.map((row) => row.peakContext))),
				avg(cell.map((row) => row.subagents)).toFixed(1),
				avg(cell.map((row) => row.handovers)).toFixed(1),
				...(rows.some((row) => row.wait)
					? (["wakes", "timeoutMsSet", "agentsStoppedByDeadline", "released"] as const).map((key) =>
							cell.some((row) => row.wait) ? avg(cell.map((row) => row.wait?.[key] ?? 0)).toFixed(1) : "",
						)
					: []),
			]);
		}
	}
	const widths = header.map((_, column) => Math.max(...table.map((line) => line[column]!.length)));
	for (const line of table) console.log(line.map((cellText, column) => cellText.padEnd(widths[column]!)).join("  "));
	console.log("");
	for (const arm of arms) {
		const cell = rows.filter((row) => row.arm === arm);
		if (cell.length === 0) continue;
		console.log(
			`${arm.padEnd(9)} passed ${cell.filter((row) => row.pass).length}/${cell.length}, total $${cell.reduce((s, row) => s + row.cost, 0).toFixed(4)}, main model $${cell.reduce((s, row) => s + mainOf(row).cost, 0).toFixed(4)}, ${(cell.reduce((s, row) => s + row.ms, 0) / 1000).toFixed(0)} s`,
		);
	}
	const failed = rows.filter((row) => !row.pass);
	if (failed.length > 0) console.log("\nfailures:");
	for (const row of failed) console.log(`  ${row.task} / ${row.arm} #${row.run}: ${row.why}  (${row.dir})`);
}

async function main(): Promise<void> {
	if (process.argv.includes("--selftest")) return selftest();
	const selected = tasks.filter((task) => !only || task.name.includes(only));
	if (selected.length === 0) throw new Error(`no task name contains "${only}"`);
	const jobs = selected.flatMap((task) =>
		arms.flatMap((arm) => Array.from({ length: runs }, (_, run) => ({ task, arm, run }))),
	);
	const rows: Row[] = [];
	let spent = 0;
	let skipped = 0;
	const worker = async () => {
		for (let job = jobs.shift(); job; job = jobs.shift()) {
			if (spent >= BUDGET) {
				skipped++;
				continue;
			}
			const row = await runOne(job.task, job.arm, job.run);
			rows.push(row);
			spent += row.cost;
			console.log(
				`${row.pass ? "PASS" : "FAIL"}  ${row.task} / ${row.arm} #${row.run}  ${(row.ms / 1000).toFixed(0)}s  $${row.cost.toFixed(4)}  agents ${row.subagents}  handovers ${row.handovers}${row.wait ? `  wakes ${row.wait.wakes}  timeout_ms ${row.wait.timeoutMsSet}  deadline stops ${row.wait.agentsStoppedByDeadline}  released ${row.wait.released}  end ${row.wait.endedBy}` : ""}${row.leak ? "  LEAK: read this checkout's source" : ""}${row.why ? `  ${row.why.slice(0, 120)}` : ""}`,
			);
			if (row.pass && !process.env.EVAL_KEEP) rmSync(row.dir, { recursive: true, force: true });
			else if (row.pass) console.log(`  kept ${row.dir}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
	report(rows);
	if (skipped > 0) console.log(`\nstopped at the budget of $${BUDGET}: ${skipped} run(s) not started`);
	const out = join(HERE, "results");
	mkdirSync(out, { recursive: true });
	const file = join(out, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	writeFileSync(file, JSON.stringify({ main: MAIN, worker: HAIKU, cli: PI, runs, arms, force, spent, rows }, null, 1));
	console.log(`\nspent $${spent.toFixed(4)}; results: ${file}`);
}

await main();
