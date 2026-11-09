// npm run test:subagent:evals -- [--runs N] [--only <substring>] [--parallel N]
// Runs every case N times on real haiku and prints pass rates, cost and time. Results: evals/results/<stamp>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cases } from "./cases.ts";
import { type Check, flag, intFlag, ROOT } from "./harness.ts";

const runs = intFlag("--runs", 1);
const only = flag("--only");
const parallel = intFlag("--parallel", 4);
const CASE_TIMEOUT_MS = 300_000;

interface Row {
	case: string;
	kind: string;
	run: number;
	pass: boolean;
	checks: Check[];
	cost: number;
	ms: number;
	notes?: string;
	error?: string;
}

const selected = cases.filter((c) => !only || c.name.includes(only));
if (selected.length === 0) throw new Error(`no case name contains "${only}"`);
const jobs = selected.flatMap((c) => Array.from({ length: runs }, (_, run) => ({ c, run })));
const rows: Row[] = [];

async function runOne({ c: evalCase, run }: (typeof jobs)[number]): Promise<void> {
	const started = Date.now();
	// A case that runs too long is aborted: its children are stopped and its tool calls reject.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS);
	try {
		const o = await evalCase.run(controller.signal);
		const pass = o.checks.every((k) => k.pass);
		rows.push({
			case: evalCase.name,
			kind: evalCase.kind,
			run,
			pass,
			checks: o.checks,
			cost: o.cost,
			ms: Date.now() - started,
			notes: o.notes,
		});
		const failed = o.checks.filter((k) => !k.pass).map((k) => `${k.name}: ${k.detail ?? ""}`);
		console.log(
			`${pass ? "PASS" : "FAIL"}  ${evalCase.name} #${run + 1}  ${((Date.now() - started) / 1000).toFixed(1)}s  $${o.cost.toFixed(5)}${o.notes ? `  (${o.notes})` : ""}`,
		);
		for (const f of failed) console.log(`      ✗ ${f}`);
	} catch (err) {
		if (controller.signal.aborted) (err as Error).message = `case timed out after ${CASE_TIMEOUT_MS / 1000} s`;
		rows.push({
			case: evalCase.name,
			kind: evalCase.kind,
			run,
			pass: false,
			checks: [],
			cost: 0,
			ms: Date.now() - started,
			error: (err as Error).message,
		});
		console.log(`ERROR ${evalCase.name} #${run + 1}: ${(err as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
}

const started = Date.now();
const queue = [...jobs];
await Promise.all(
	Array.from({ length: Math.min(parallel, queue.length) }, async () => {
		for (let job = queue.shift(); job; job = queue.shift()) await runOne(job);
	}),
);

console.log("\ncase                                   pass   avg s   cost");
for (const c of selected) {
	const rs = rows.filter((r) => r.case === c.name);
	const passed = rs.filter((r) => r.pass).length;
	const avg = rs.reduce((s, r) => s + r.ms, 0) / rs.length / 1000;
	const cost = rs.reduce((s, r) => s + r.cost, 0);
	console.log(
		`${c.name.padEnd(38)} ${`${passed}/${rs.length}`.padStart(5)} ${avg.toFixed(1).padStart(7)}  $${cost.toFixed(5)}`,
	);
}
const passed = rows.filter((r) => r.pass).length;
const cost = rows.reduce((s, r) => s + r.cost, 0);
console.log(
	`\ntotal ${passed}/${rows.length} passed, $${cost.toFixed(4)}, ${((Date.now() - started) / 1000).toFixed(0)} s wall`,
);

const dir = join(ROOT, "test", "subagent", "evals", "results");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ runs, only, rows }, null, 2));
console.log(`results: ${file}`);
process.exit(passed === rows.length ? 0 : 1);
