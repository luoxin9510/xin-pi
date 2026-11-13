// v3b ticket 04 on a real parent pi (rpc, haiku): `/subagents stop` sent as a slash command through the rpc prompt
// stops every running subagent, and the stopped ones can be resumed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startParent, textOfMessage } from "./helpers.ts";

const runScript = (code: string, then: string) =>
	`Call the codemode tool exactly once with exactly this code:\n\`\`\`js\n${code}\n\`\`\`\n${then}`;
const isCodemodeEnd = (e: any) => e.type === "tool_execution_end" && e.toolName === "codemode" && !e.parentToolCallId;

// Every agent file under the parent's session dir: its meta status and whether the child's own session ran `sleep 60`.
function agents(sessionDir: string): { id: string; status: string; sleeping: boolean }[] {
	if (!existsSync(sessionDir)) return [];
	const files = readdirSync(sessionDir, { recursive: true }) as string[];
	return files
		.filter((f) => /subagents[\\/][^\\/]+[\\/][a-z0-9]{12}\.json$/.test(f))
		.map((f) => {
			const id = f.slice(-17, -5);
			const session = files.find((g) => g.includes("subagents") && g.endsWith(".jsonl") && g.includes(id));
			return {
				id,
				status: JSON.parse(readFileSync(join(sessionDir, f), "utf8")).status as string,
				sleeping: session !== undefined && readFileSync(join(sessionDir, session), "utf8").includes("sleep 60"),
			};
		});
}

async function until(what: string, ready: () => boolean, ms: number) {
	for (const end = Date.now() + ms; !ready(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

test("/subagents stop stops two slow background agents, tells the user how many, and both can be resumed", async () => {
	const p = startParent();
	try {
		const one = (d: string) =>
			`tools.Agent({description:'${d}',prompt:'Run the bash command sleep 60 using a tool, then reply OK.',run_in_background:true})`;
		p.prompt(
			runScript(
				`const a = await ${one("slow a")};\nconst b = await ${one("slow b")};\nreturn a.agentId + ' ' + b.agentId;`,
				"Reply 'ok' and stop.",
			),
		);
		await p.waitFor("codemode call end", isCodemodeEnd, 90_000);
		await until(
			"both children running their sleep",
			() => agents(p.sessionDir).filter((a) => a.status === "running" && a.sleeping).length === 2,
			90_000,
		);
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000);

		const from = p.events.length;
		p.prompt("/subagents stop");
		const notice = await p.waitFor(
			"the stop notice",
			(e) => e.type === "extension_ui_request" && e.method === "notify" && /stopped 2 subagents/.test(e.message),
			60_000,
			from,
		);
		// The script that started the two agents is still tracked as their group (spec 09), so it is stopped too.
		assert.match(notice.message, /stopped 2 subagents and 1 script\b/);
		await until("both stopped", () => agents(p.sessionDir).every((a) => a.status === "stopped"), 30_000);
		const [a, b] = agents(p.sessionDir);
		assert.ok(a && b && a.id !== b.id);

		// nothing left running: a second stop says so
		const again = p.events.length;
		p.prompt("/subagents stop");
		await p.waitFor(
			"the nothing-running notice",
			(e) => e.type === "extension_ui_request" && e.method === "notify" && /nothing is running/.test(e.message),
			30_000,
			again,
		);

		// main hears about the stopped agents and replies; wait until it has gone quiet
		for (let n = -1; n !== p.events.length; ) {
			n = p.events.length;
			await new Promise((r) => setTimeout(r, 4000));
		}
		await p.waitFor("main to settle", (e) => e.type === "agent_settled", 60_000, from);

		// both are resumable
		const resumed = p.events.length;
		p.prompt(
			runScript(
				`const r = await Promise.all([tools.Agent({resume:'${a.id}',description:'a',prompt:'Reply with the single word RESUMED',run_in_background:false}), tools.Agent({resume:'${b.id}',description:'b',prompt:'Reply with the single word RESUMED',run_in_background:false})]);\nreturn 'TOK ' + r.map((x) => x.status).join(',');`,
				"Reply 'ok' and stop.",
			),
		);
		const end = await p.waitFor("the resume script", (e) => isCodemodeEnd(e), 120_000, resumed);
		assert.match(textOfMessage({ content: end.result.content }), /TOK completed,completed/);
	} finally {
		p.stop();
	}
});
