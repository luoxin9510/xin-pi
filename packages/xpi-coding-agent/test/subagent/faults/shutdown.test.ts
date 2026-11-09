// A child's process tree must not outlive a stop or the parent, and a child that is shutting down properly is not cut
// off: grandchildren die with the group, the grace is configurable, parent exit/signals clean up (fake pi, no model).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runChild } from "../../../src/extensions/subagent/runner.ts";
import { ev, FAKE_PI } from "../helpers.ts";

const RUNNER = fileURLToPath(new URL("../../../src/extensions/subagent/runner.ts", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function waitFor(cond: () => boolean, ms = 8000) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (cond()) return true;
	return cond();
}
const pidOf = (file: string) => Number(readFileSync(file, "utf8"));

function setup(scenario: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "shutdown-test-"));
	const f = (n: string) => join(dir, n);
	const sc = {
		lines: [ev.session()],
		hang: true,
		pidFile: f("child.pid"),
		grandchildPidFile: f("gc.pid"),
		cleanFile: f("clean"),
		...scenario,
	};
	writeFileSync(f("scenario.json"), JSON.stringify(sc));
	const env = { ...process.env, FAKE_PI_SCENARIO: f("scenario.json"), FAKE_PI_RECORD: f("record.json") } as Record<
		string,
		string
	>;
	const spec = {
		command: FAKE_PI,
		args: [],
		env,
		cwd: dir,
		systemPrompt: "x",
		prompt: "go",
		model: "m",
		thinking: "off",
		agentId: "fake",
		warnings: [],
	};
	return { dir, f, spec };
}

test("stop of a child that ignores SIGTERM kills its grandchildren too", async () => {
	const t = setup({ termDelayMs: -1 });
	const ac = new AbortController();
	const run = runChild({ ...t.spec, shutdownGraceMs: 500 }, ac.signal, () => {});
	run.catch(() => {});
	assert.ok(await waitFor(() => existsSync(t.f("gc.pid"))));
	const [child, gc] = [pidOf(t.f("child.pid")), pidOf(t.f("gc.pid"))];
	ac.abort();
	await assert.rejects(run, /aborted/);
	assert.ok(await waitFor(() => !alive(child) && !alive(gc), 3000), "child and grandchild are gone");
});

test("a child that exits cleanly leaves no grandchild behind", async () => {
	const t = setup({ termDelayMs: 0 });
	const ac = new AbortController();
	const run = runChild({ ...t.spec, shutdownGraceMs: 2000 }, ac.signal, () => {});
	run.catch(() => {});
	assert.ok(await waitFor(() => existsSync(t.f("gc.pid"))));
	const gc = pidOf(t.f("gc.pid"));
	ac.abort();
	await assert.rejects(run, /aborted/);
	assert.ok(await waitFor(() => !alive(gc), 3000), "grandchild is gone");
});

test("shutdownGraceMs lets a slow-closing child finish; a short grace cuts it off", async () => {
	for (const [grace, wantClean] of [
		[5000, true],
		[300, false],
	] as const) {
		const t = setup({ termDelayMs: 1500 });
		const ac = new AbortController();
		const run = runChild({ ...t.spec, shutdownGraceMs: grace }, ac.signal, () => {});
		run.catch(() => {});
		assert.ok(await waitFor(() => existsSync(t.f("gc.pid"))));
		ac.abort();
		await assert.rejects(run, /aborted/);
		await sleep(wantClean ? 100 : 1800);
		assert.equal(existsSync(t.f("clean")), wantClean, `grace ${grace}`);
	}
});

test("subagent.shutdownGraceMs is validated; default 10 s", async () => {
	const { readConfig } = await import("../../../src/extensions/subagent/config.ts");
	assert.equal(readConfig({}).shutdownGraceMs, 10_000);
	assert.equal(readConfig({ shutdownGraceMs: 30_000 }).shutdownGraceMs, 30_000);
	for (const bad of [-1, "5", Number.NaN])
		assert.throws(() => readConfig({ shutdownGraceMs: bad }), /shutdownGraceMs/);
});

// A harness process runs a child and then does `how`; afterwards the child tree must be gone.
async function parentExit(how: string, killWith?: NodeJS.Signals) {
	const t = setup({ termDelayMs: -1 });
	const code = `
import { runChild } from ${JSON.stringify(RUNNER)};
const spec = ${JSON.stringify({ ...t.spec, shutdownGraceMs: 500 })};
runChild(spec, undefined, () => {}).catch(() => {});
setInterval(() => {}, 1000);
${how}
`;
	const h = join(t.dir, "harness.mts");
	writeFileSync(h, code);
	const p: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", h], { stdio: "ignore" });
	assert.ok(await waitFor(() => existsSync(t.f("gc.pid"))));
	const [child, gc] = [pidOf(t.f("child.pid")), pidOf(t.f("gc.pid"))];
	if (killWith) {
		await sleep(300);
		p.kill(killWith);
	}
	await new Promise((r) => p.on("exit", r));
	assert.ok(await waitFor(() => !alive(child) && !alive(gc), 3000), `tree gone after parent ${how || killWith}`);
}
test("parent process.exit() takes the child tree with it", () => parentExit("setTimeout(() => process.exit(0), 400);"));
test("parent SIGTERM takes the child tree with it", () => parentExit("", "SIGTERM"));
test("parent SIGHUP takes the child tree with it", () => parentExit("", "SIGHUP"));
test("parent SIGINT takes the child tree with it", () => parentExit("", "SIGINT"));
