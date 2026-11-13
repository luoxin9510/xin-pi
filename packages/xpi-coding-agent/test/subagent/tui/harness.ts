// Seam 2 harness: real interactive pinned pi in a pseudo-terminal, read through a headless xterm.
// Each session has its own temp repo, HOME, pi agent dir (auth linked from the user's) and session dir, so the user's
// setup never leaks in. Always `await using`-style: call kill() in a finally (or use `withPi`), the pi process must die.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";
import * as pty from "node-pty";
import { copyUserAuth } from "../user-auth.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // the xpi-coding-agent package
// XPI_SUBAGENT_TEST_PI: run the suite against another build of xpi. The default is the built bundle (npm run build).
export const PI = process.env.XPI_SUBAGENT_TEST_PI ?? join(ROOT, "dist", "bundle", "cli.js");
export const HAIKU = "anthropic/claude-haiku-5-5";
const USER_AUTH = join(process.env.HOME ?? "", ".pi", "agent", "auth.json");

// npm leaves node-pty's prebuilt spawn-helper without the execute bit on some installs.
const PTY_DIR = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
for (const dir of readdirSync(join(PTY_DIR, "prebuilds"), { withFileTypes: true })) {
	const helper = join(PTY_DIR, "prebuilds", dir.name, "spawn-helper");
	if (dir.isDirectory() && existsSync(helper)) chmodSync(helper, 0o755);
}

export const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	esc: "\x1b",
	ctrlB: "\x02",
	ctrlC: "\x03",
	pageUp: "\x1b[5~",
	pageDown: "\x1b[6~",
	home: "\x1b[H",
	end: "\x1b[F",
} as const;

export interface PiOptions {
	cols?: number;
	rows?: number;
	lingerMs?: number; // the subagent.panelLingerMs setting: how long finished rows stay in the panel (default 30 s)
	env?: Record<string, string>; // added to the environment
	args?: string[]; // extra pi arguments
}

export class PiTerminal {
	readonly root: string;
	readonly repo: string;
	readonly sessionDir: string;
	private term: InstanceType<typeof xterm.Terminal>;
	private proc: pty.IPty;
	private exited = false;
	private exitWaiters: (() => void)[] = [];

	constructor(o: PiOptions = {}) {
		const cols = o.cols ?? 120;
		const rows = o.rows ?? 40;
		this.root = mkdtempSync(join(tmpdir(), "subagent-tui-"));
		this.repo = join(this.root, "repo");
		const home = join(this.root, "home");
		const agentDir = join(this.root, "pi-agent");
		this.sessionDir = join(this.root, "sessions");
		for (const d of [join(this.repo, ".git"), home, agentDir, this.sessionDir]) mkdirSync(d, { recursive: true });
		copyUserAuth(USER_AUTH, join(agentDir, "auth.json")); // a copy: nothing in the user agent dir is touched
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "anthropic",
				defaultModel: "claude-haiku-5-5",
				packages: [],
				quietStartup: true,
				theme: "dark",
				codemode: { mode: "on" },
				subagent: o.lingerMs === undefined ? {} : { panelLingerMs: o.lingerMs },
			}),
		);
		this.term = new xterm.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "",
			HOME: home,
			XPI_CODING_AGENT_DIR: agentDir,
			XPI_SKIP_VERSION_CHECK: "1",
			XPI_TELEMETRY: "0",
			TERM: "xterm-256color",
			...o.env,
		};
		const args = [
			"--model",
			HAIKU,
			"--thinking",
			"low",
			"--approve",
			"--session-dir",
			this.sessionDir,
			"--tools",
			"+codemode",
			...(o.args ?? []),
		];
		this.proc = pty.spawn(PI, args, { name: "xterm-256color", cols, rows, cwd: this.repo, env });
		this.proc.onData((d) => this.term.write(d));
		// Answer the terminal's own queries (device attributes, cursor position), as a real terminal would.
		this.term.onData((reply) => {
			if (!this.exited) this.proc.write(reply);
		});
		this.proc.onExit(() => {
			this.exited = true;
			for (const w of this.exitWaiters.splice(0)) w();
		});
	}

	type(text: string): void {
		this.proc.write(text);
	}

	press(...keys: (keyof typeof KEYS)[]): void {
		for (const k of keys) this.proc.write(KEYS[k]);
	}

	// Type a prompt and submit it.
	submit(text: string): void {
		this.type(text);
		this.type("\r");
	}

	// The screen as text: the viewport and its scrollback, trailing blanks trimmed.
	screen(): string {
		const buf = this.term.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)!.translateToString(true));
		return lines.join("\n").trimEnd();
	}

	// Only the visible rows.
	viewport(): string {
		const buf = this.term.buffer.active;
		const lines: string[] = [];
		for (let i = 0; i < this.term.rows; i++)
			lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? "");
		return lines.join("\n").trimEnd();
	}

	// The 256-colour palette index of the foreground of the first cell of `text` on the visible rows (-1: default
	// colour or not a palette colour); undefined when the text is not on screen.
	fgOf(text: string): number | undefined {
		const buf = this.term.buffer.active;
		for (let i = 0; i < this.term.rows; i++) {
			const line = buf.getLine(buf.viewportY + i);
			const at = line?.translateToString(true).indexOf(text) ?? -1;
			if (line && at >= 0) {
				const cell = line.getCell(at)!;
				return cell.isFgPalette() ? cell.getFgColor() : -1;
			}
		}
		return undefined;
	}

	// Poll the visible screen until `test` holds. No fixed sleeps: it returns as soon as the screen matches, and throws
	// with the screen contents on timeout.
	async waitFor(what: string | RegExp | ((viewport: string) => boolean), timeoutMs = 60_000): Promise<string> {
		const test =
			typeof what === "function"
				? what
				: what instanceof RegExp
					? (s: string) => what.test(s)
					: (s: string) => s.includes(what);
		const label = typeof what === "function" ? what.toString() : String(what);
		const end = Date.now() + timeoutMs;
		for (;;) {
			const v = this.viewport();
			if (test(v)) return v;
			if (this.exited) throw new Error(`pi exited while waiting for ${label}. Screen:\n${this.screen()}`);
			if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}. Screen:\n${v}`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	// Wait until the visible screen no longer matches.
	waitGone(what: string | RegExp, timeoutMs = 60_000): Promise<string> {
		const has = (s: string) => (typeof what === "string" ? s.includes(what) : what.test(s));
		return this.waitFor((s) => !has(s), timeoutMs);
	}

	// Resolve true when the process has exited on its own (a /quit), false when it is still up after `timeoutMs`.
	waitExit(timeoutMs: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(this.exited), timeoutMs);
			this.exitWaiters.push(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	kill(): void {
		if (this.exited) return;
		this.exited = true;
		for (const target of [-this.proc.pid, this.proc.pid]) {
			// the pty child leads its own process group: take its subagents down with it
			try {
				process.kill(target, "SIGKILL");
			} catch {}
		}
		this.term.dispose();
	}
}

// Run `fn` with a started pi and always kill it afterwards.
export async function withPi<T>(o: PiOptions, fn: (pi: PiTerminal) => Promise<T>): Promise<T> {
	const pi = new PiTerminal(o);
	try {
		return await fn(pi);
	} finally {
		pi.kill();
	}
}
