// Ticket xpi-05: the rpc shutdown rework (the first SIGTERM or stdin EOF runs runtimeHost.dispose() to the end; only a
// second signal force-exits) means a child can legitimately spend seconds in session_shutdown, for example closing MCP
// servers. The runner must wait for it, and must not leave processes behind after a stop.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { agentFile, loadTool, REPLY_OK, sandbox } from "./helpers.ts";

// A project extension every trusted child loads: its session_shutdown takes `ms`, then leaves a marker with its pid.
const SLOW_SHUTDOWN = (marker: string, ms: number) => `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_shutdown", async () => {
    await new Promise((r) => setTimeout(r, ${ms}));
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  });
}
`;

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const waitUntil = async (what: string, ready: () => boolean, ms = 30_000) => {
	for (const end = Date.now() + ms; !ready(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
};

test("a child whose session_shutdown takes 3.5 s (longer than the settle grace) finishes it before the run ends", async () => {
	const s = sandbox();
	const marker = join(s.root, "shutdown.marker");
	s.write(join(s.repo, ".pi/extensions/slow.ts"), SLOW_SHUTDOWN(marker, 3500));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const r = await t.result({ prompt: REPLY_OK });
	assert.equal(r.status, "completed", r.error ?? "");
	assert.ok(existsSync(marker), "the child was killed in the middle of its shutdown");
	assert.equal(alive(Number(readFileSync(marker, "utf8"))), false, "and it is gone when the run resolves");
});

test("stop: the child's shutdown runs to the end and no process is left behind", async () => {
	const s = sandbox();
	const marker = join(s.root, "shutdown.marker");
	s.write(join(s.repo, ".pi/extensions/slow.ts"), SLOW_SHUTDOWN(marker, 2500));
	s.write(join(s.repo, ".pi/agents/x.md"), agentFile("name: x\ndescription: d"));
	const t = await loadTool({}, { cwd: s.repo, persist: join(s.root, "sessions") });
	const run = t.result({
		subagent_type: "x",
		prompt: "Run the bash command 'sleep 60' with the codemode tool, then reply OK.",
	});
	await waitUntil("the child to be running a tool", () => {
		const r = registry.list(t.sessionId)[0];
		return r?.lastTool !== undefined && registry.handle(r.id) !== undefined;
	});
	const id = registry.list(t.sessionId)[0]!.id;
	await registry.stopAll([id]);
	const r = await run;
	assert.equal(r.status, "failed");
	assert.equal(r.error, "stopped by user");
	await waitUntil("the shutdown marker", () => existsSync(marker), 15_000);
	await waitUntil("the child to be gone", () => !alive(Number(readFileSync(marker, "utf8"))), 15_000);
});
