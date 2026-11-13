// Agent teams, UI, through the real exchange (exchange.ts, registry, runner) with a fake `pi --mode rpc` child: Esc's
// interrupt ends the turn without stopping the teammate (idle, record not failed, no notice), `x` stops an idle teammate,
// and typing steers the running child with the user's own text.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { registry } from "../../../src/extensions/subagent/registry.ts";
import { teams } from "../../../src/extensions/subagent/team.ts";
import { ev, loadTool, sandbox } from "../helpers.ts";
import { cleanupLater, cleanupNow } from "./team-helpers.ts";

const until = async (what: string, pred: () => boolean, ms = 30_000) => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
};

let n = 0;
async function setup() {
	const s = sandbox();
	const sessionId = `0190ui-${++n}-${Math.random().toString(16).slice(2, 8)}`;
	process.env.XPI_CODING_AGENT_DIR = join(s.root, "agent");
	const t = await loadTool(
		{},
		{
			cwd: s.repo,
			sessionFile: join(s.root, "parent.jsonl"),
			sessionId,
			topSettings: { agentTeams: { enabled: true } },
		},
	);
	cleanupLater(() => t.emit("session_shutdown", {}));
	return { s, t, sessionId };
}

test(
	"Esc's interrupt: the running teammate becomes idle (not failed, not stopped), with no idle notice; x then stops it while idle",
	{ timeout: 60_000 },
	async () => {
		const x = await setup();
		try {
			x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true });
			const r = (await x.t.run({ name: "w" })).structuredContent;
			await until("the child", () => registry.handle(r.agentId) !== undefined);
			const team = teams.current()!;
			assert.equal(team.interrupt("w"), true);
			await until("idle", () => team.members.get("w")!.status === "idle");
			assert.equal(registry.get(r.agentId)!.status, "completed", "the interrupted exchange is not a failure");
			await team.deliverNow();
			await new Promise((res) => setTimeout(res, 100));
			assert.deepEqual(
				x.t.messages.map((m) => m.message.content),
				[],
				"no idle notice, no stopped notice",
			);
			assert.equal(team.interrupt("w"), false, "nothing is running to interrupt");

			assert.equal(team.stop("w"), true, "x stops an idle teammate: there is no process");
			assert.equal(team.members.get("w")!.status, "stopped");
			assert.equal(registry.get(r.agentId)!.status, "stopped");
			assert.deepEqual(
				x.t.messages.map((m) => m.message.content),
				['Teammate "w" was stopped.'],
			);
		} finally {
			await cleanupNow();
		}
	},
);

test(
	"typing to a running teammate reaches its child as a steer with the user's own text",
	{ timeout: 60_000 },
	async () => {
		const x = await setup();
		try {
			x.s.scenario({ lines: [ev.session()], hang: true, abortSettles: true, takeSteers: true });
			const r = (await x.t.run({ name: "w" })).structuredContent;
			await until("the child", () => registry.handle(r.agentId) !== undefined);
			assert.equal(teams.current()!.say("w", "please also check the docs"), "steered");
			const steers = () => {
				try {
					return x.s.record().commands.filter((c: any) => c.type === "steer");
				} catch {
					return []; // the child has not written its record yet
				}
			};
			await until("the steer", () => steers().length > 0);
			const steer = steers()[0];
			assert.equal(steer.message, "please also check the docs");
			registry.stop(r.agentId);
		} finally {
			await cleanupNow();
		}
	},
);

test("/tasks is registered only when teams are on, and then opens the overlay", { timeout: 60_000 }, async () => {
	const off = sandbox();
	process.env.XPI_CODING_AGENT_DIR = join(off.root, "agent");
	const t = await loadTool(
		{},
		{ cwd: off.repo, sessionFile: join(off.root, "parent.jsonl"), sessionId: `0190ui-off-${++n}` },
	);
	assert.equal(t.commands.tasks, undefined, "teams off: the command list is unchanged");

	const x = await setup();
	try {
		let opened: { overlay?: boolean } | undefined;
		(x.t.ctx.ui as any).custom = async (_factory: unknown, options: { overlay?: boolean }) => {
			opened = options;
		};
		await x.t.commands.tasks.handler("", x.t.ctx);
		assert.equal(opened?.overlay, true);
	} finally {
		await cleanupNow();
	}
});
