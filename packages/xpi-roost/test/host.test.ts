import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { altScreenAfter } from "../src/lib/attach.ts";
import { encodeFrame, FrameDecoder, FrameType, parseJsonPayload } from "../src/lib/framing.ts";
import { connectHost, hostControl } from "../src/lib/hostclient.ts";
import { newJobId } from "../src/lib/ids.ts";
import { TEST_DIR_PREFIX } from "../src/lib/orphans.ts";
import { ensureDirs, hostSocketPath, jobDir } from "../src/lib/paths.ts";
import { createJob, exitPath, type JobRecord, readExit, screenPath } from "../src/lib/store.ts";

// The host runs straight from source under Node's type stripping.

let home: string;
let rt: string;
let hosts: ChildProcess[] = [];
let socks: Socket[] = [];
const saved = { home: process.env.ROOST_HOME, rt: process.env.ROOST_RUNTIME_DIR };

async function waitFor<T>(
	fn: () => T | undefined | false | Promise<T | undefined | false>,
	timeout = 8000,
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - start > timeout) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), `${TEST_DIR_PREFIX}h-`));
	rt = mkdtempSync("/tmp/xrt-");
	process.env.ROOST_HOME = home;
	process.env.ROOST_RUNTIME_DIR = rt;
	ensureDirs();
});

afterEach(() => {
	for (const s of socks) s.destroy();
	for (const h of hosts) if (h.exitCode === null) h.kill("SIGKILL");
	socks = [];
	hosts = [];
	rmSync(home, { recursive: true, force: true });
	rmSync(rt, { recursive: true, force: true });
	if (saved.home === undefined) delete process.env.ROOST_HOME;
	else process.env.ROOST_HOME = saved.home;
	if (saved.rt === undefined) delete process.env.ROOST_RUNTIME_DIR;
	else process.env.ROOST_RUNTIME_DIR = saved.rt;
});

async function startHost(
	script: string,
	state: Record<string, unknown> = {},
	over: Partial<JobRecord> = {},
	hostEnv: Record<string, string> = {},
): Promise<{ id: string; child: ChildProcess }> {
	const id = newJobId();
	const now = Date.now();
	const record: JobRecord = {
		id,
		name: "t",
		cwd: home,
		sessionFile: join(home, "s.jsonl"),
		command: ["/bin/sh", "-c", script],
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		origin: "bg",
		createdAt: now,
		roostVersion: "0.0.0",
		...over,
	};
	createJob(record, { state: "working", startedAt: now, updatedAt: now, ...state });
	const child = spawn(process.execPath, ["src/host/main.ts", id], {
		stdio: "ignore",
		env: { ...process.env, ...hostEnv, ROOST_PARENT_PID: String(process.pid) },
	});
	hosts.push(child);
	// The socket file appears at bind; a connect before listen is refused. Wait for an answer, not for the file.
	await waitFor(() =>
		hostControl(id, "status").then(
			() => true,
			() => false,
		),
	);
	return { id, child };
}

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

interface Client {
	sock: Socket;
	text: () => string;
	detached: () => string | undefined;
}

function watch(sock: Socket): Client {
	const dec = new FrameDecoder();
	let text = "";
	let detached: string | undefined;
	sock.on("data", (chunk) => {
		for (const f of dec.push(chunk)) {
			if (f.type === FrameType.DATA) text += f.payload.toString("utf8");
			else if (f.type === FrameType.DETACHED) detached = parseJsonPayload<{ reason: string }>(f).reason;
		}
	});
	socks.push(sock);
	return { sock, text: () => text, detached: () => detached };
}

describe("host", () => {
	it("attach: output, input, exit", async () => {
		const { id, child } = await startHost("sleep 0.5; echo hi; read x; echo got:$x; sleep 0.3");
		const c = watch(await connectHost(id, { role: "attach", cols: 80, rows: 24 }));
		await waitFor(() => c.text().includes("hi"));
		c.sock.write(encodeFrame(FrameType.DATA, "abc\r"));
		await waitFor(() => c.text().includes("got:abc"));
		await waitFor(() => c.detached() === "exit");
		await waitFor(() => exited(child));
		expect(readExit(id)?.code).toBe(0);
		expect(readFileSync(screenPath(id), "utf8")).toContain("got:abc");
		expect(existsSync(hostSocketPath(id))).toBe(false);
	});

	it("takeover and terminate", async () => {
		const { id, child } = await startHost("sleep 0.5; echo ready; sleep 30");
		const a = watch(await connectHost(id, { role: "attach", cols: 80, rows: 24 }));
		await waitFor(() => a.text().includes("ready"));
		const b = watch(await connectHost(id, { role: "attach", cols: 100, rows: 30 }));
		await waitFor(() => a.detached() === "takeover");
		const status = (await hostControl(id, "status")) as { attached: boolean; alive: boolean; cols: number };
		expect(status.attached).toBe(true);
		expect(status.alive).toBe(true);
		expect(status.cols).toBe(100);
		expect(b.detached()).toBeUndefined();
		expect(await hostControl(id, "terminate")).toEqual({ ok: true });
		await waitFor(() => exited(child));
		const ex = readExit(id);
		expect(ex && (ex.signal !== null || ex.code !== 0)).toBe(true);
		expect(existsSync(exitPath(id))).toBe(true);
	});

	it("M21: an attach starts from the host's screen: no signal, no wait, nothing lost after it", async () => {
		// a program that drew once and now waits, as an idle pi or a quiet command does
		const script = `printf 'line one\\nline two\\n'; trap 'echo winch' WINCH; while :; do sleep 0.05; done`;
		const self = await startHost(script);
		await new Promise((r) => setTimeout(r, 300));
		const t0 = Date.now();
		// another size: the program's redraw for it comes after the snapshot, and is shown
		const a = watch(await connectHost(self.id, { role: "attach", cols: 80, rows: 24 }));
		await waitFor(() => a.text().includes("line two"), 2000);
		expect(Date.now() - t0).toBeLessThan(1000);
		// the user's terminal back to defaults, then this screen
		expect(a.text().startsWith("\x1b[0m\x1b[r")).toBe(true);
		expect(a.text()).toContain("\x1b[H\x1b[2J");
		await waitFor(() => a.text().includes("winch"), 2000);
		expect(a.text().indexOf("winch")).toBeGreaterThan(a.text().indexOf("line two"));
		await hostControl(self.id, "terminate");
	});

	it("M21: the snapshot carries the alternate screen and the modes; the attach signal reaches a worker that asked for it", async () => {
		const draw = `printf 'main\\n\\033[?1049h\\033[?1000h\\033[?1006h\\033[>1u\\033[?25l\\033[2J\\033[HALT SCREEN'`;
		const script = `${draw}; trap "printf redrawn" USR2; while :; do sleep 0.05; done`;
		const self = await startHost(script, { attachSignal: true });
		await new Promise((r) => setTimeout(r, 300));
		const a = watch(await connectHost(self.id, { role: "attach", cols: 120, rows: 30 }));
		await waitFor(() => a.text().includes("ALT SCREEN"), 2000);
		const first = a.text();
		expect(first).toContain("\x1b[?1049h\x1b[H\x1b[2J");
		expect(first.indexOf("\x1b[?1049h")).toBeLessThan(first.indexOf("ALT SCREEN"));
		for (const m of ["\x1b[?1000h", "\x1b[?1006h", "\x1b[>1u", "\x1b[?25l"])
			expect(first, JSON.stringify(m)).toContain(m);
		// on the alternate screen: the main screen's rows do not land on the user's own
		expect(first).not.toContain("main");
		// no scrollback: nothing from before the screen's rows
		await waitFor(() => a.text().includes("redrawn"), 2000);
		// a takeover starts from the same screen
		const b = watch(await connectHost(self.id, { role: "attach", cols: 120, rows: 30 }));
		await waitFor(() => b.text().includes("ALT SCREEN"), 2000);
		await hostControl(self.id, "terminate");
	});

	it("M21: a sequence cut at the snapshot point arrives whole; modes counted once", async () => {
		// the program stops inside a colour sequence, after pushing kitty flags
		const script = `printf '\\033[>1uhead \\033[3'; sleep 1; printf '1mRED\\033[0m\\033[>2u'; while :; do sleep 0.05; done`;
		const self = await startHost(script);
		await new Promise((r) => setTimeout(r, 400));
		const a = watch(await connectHost(self.id, { role: "attach", cols: 120, rows: 30 }));
		await waitFor(() => a.text().includes("RED"), 3000);
		const text = a.text();
		// the cut part and its rest together, never "1mRED" on its own
		expect(text).toContain("\x1b[31mRED");
		// kitty flags from before the attach once, the later push from the stream once
		expect(text.split("\x1b[>1u").length - 1).toBe(1);
		expect(text.split("\x1b[>2u").length - 1).toBe(1);
		await hostControl(self.id, "terminate");
	});

	it("M14: the client leaves the alternate screen only when the session entered it", async () => {
		expect(altScreenAfter("x\x1b[?1049hy", false)).toBe(true);
		expect(altScreenAfter("\x1b[?1049h…\x1b[?1049l", true)).toBe(false);
		expect(altScreenAfter("plain", true)).toBe(true);
		expect(altScreenAfter("plain", false)).toBe(false);
	});

	it("M15: answers terminal queries while nobody is attached", async () => {
		const { id } = await startHost(
			`sleep 0.3; stty -icanon -echo; printf '\\033[c'; x=$(dd bs=1 count=3 2>/dev/null | od -An -c | tr -d ' '); echo "got:$x"; sleep 30`,
		);
		// under a full suite's load a control connection can fail once: try again
		const text = await waitFor(async () => {
			const r = (await hostControl(id, "snapshot").catch(() => undefined)) as { text: string } | undefined;
			return r?.text.includes("got:") ? r.text : undefined;
		}, 10000);
		expect(text).toContain("got:033[?");
		await hostControl(id, "terminate");
	});

	it("control snapshot", async () => {
		const { id } = await startHost("sleep 0.5; echo ready; sleep 30");
		const text = await waitFor(async () => {
			const r = (await hostControl(id, "snapshot")) as { text: string };
			return r.text.includes("ready") ? r.text : undefined;
		});
		expect(text.endsWith("\n")).toBe(true);
		expect(await hostControl(id, "detach")).toEqual({ detached: false });
		await hostControl(id, "terminate");
	});

	it("survives garbage from a client", async () => {
		const { id, child } = await startHost("sleep 0.5; echo ready; sleep 30");
		// under load the host may not listen yet: connect when it does
		const sock = await waitFor(() => connectHost(id, { role: "control" }).catch(() => undefined));
		socks.push(sock);
		sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
		await waitFor(() => sock.destroyed);
		// under load the next control connection can race the teardown of the bad one: retry it,
		// while still requiring the host process itself to have survived
		const status = await waitFor(async () => {
			try {
				return (await hostControl(id, "status")) as { alive: boolean };
			} catch {
				return undefined;
			}
		});
		expect(status.alive).toBe(true);
		expect(exited(child)).toBe(false);
		await hostControl(id, "terminate");
		await waitFor(() => exited(child));
		expect(existsSync(jobDir(id))).toBe(true);
	});

	it("M61: command types a slash line into an xpi worker as a bracketed paste then Enter; refused for a shell job and for anything else", async () => {
		const out = join(home, "typed.txt");
		const { id } = await startHost(`stty -echo; cat > ${out}`);
		const typed = () => (existsSync(out) ? readFileSync(out, "utf8") : "");
		// not one slash line
		for (const text of ["session", "/a\nb", "/a\x1b[31m", `/${"x".repeat(500)}`, 5]) {
			expect(await hostControl(id, "command", 3000, { text })).toEqual({ error: "bad command" });
		}
		// someone attached owns the editor: refused at the host, whatever the hub saw before
		const a = watch(await connectHost(id, { role: "attach", cols: 80, rows: 24 }));
		await waitFor(async () => ((await hostControl(id, "status")) as { attached: boolean }).attached);
		expect(await hostControl(id, "command", 3000, { text: "/session" })).toEqual({
			error: "attached: the editor is the attached user's",
		});
		a.sock.destroy();
		await waitFor(async () => !((await hostControl(id, "status")) as { attached: boolean }).attached);
		expect(await hostControl(id, "command", 3000, { text: "/session" })).toEqual({ ok: true });
		// a trailing space inside the paste: a line ending in "\\" would make Enter a new line in the editor
		await waitFor(() => typed().includes("\x1b[200~/session \x1b[201~"));
		expect(typed()).toBe("\x1b[200~/session \x1b[201~\n"); // Enter reaches the pty as \r, which its line discipline makes \n
		await hostControl(id, "terminate");
		// not a shell job (it has no xpi to type into)
		const sh = await startHost("cat > /dev/null", {}, { kind: "shell" });
		expect(await hostControl(sh.id, "command", 3000, { text: "/session" })).toEqual({
			error: "command is for xpi sessions",
		});
		// M30's `input` op is not ported: the live host says so
		expect(await hostControl(sh.id, "input" as "status", 3000, { data: "x" })).toEqual({
			error: "unknown op: input",
		});
		await hostControl(sh.id, "terminate");
	});

	it("decision 7: a session gets its roost's location, and the agent directory as xpi reads it, whatever its own environment held", async () => {
		const out = join(home, "env.txt");
		const roost = { ROOST_AGENT_DIR: join(home, "agent"), ROOST_HOST_ENTRY: "/entries/host.js" };
		// its captured environment names another roost and another agent directory, and lacks this one
		const env = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			ROOST_HOME: "/elsewhere",
			XPI_CODING_AGENT_DIR: "/other/agent",
		};
		const { id } = await startHost(`env > ${out}.tmp; mv ${out}.tmp ${out}; sleep 30`, {}, { env }, roost);
		await waitFor(() => existsSync(out));
		await hostControl(id, "terminate");
		const seen = Object.fromEntries(
			readFileSync(out, "utf8")
				.split("\n")
				.filter((l) => l.includes("="))
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		expect(seen).toMatchObject({
			...roost,
			ROOST_HOME: home,
			ROOST_RUNTIME_DIR: rt,
			XPI_CODING_AGENT_DIR: roost.ROOST_AGENT_DIR,
		});
		// a test-mode marker of the host is not the session's
		expect(seen.ROOST_PARENT_PID).toBeUndefined();
	});
});
