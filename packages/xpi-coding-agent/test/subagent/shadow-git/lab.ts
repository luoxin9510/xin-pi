// A temp shadow-git workspace for the xpi integration tests: a store, a workspace with the plain adapter, an agent dir and
// a HOME, all under one temp directory. The process environment is changed (the extension and the subagent code read
// it) and `restore()` puts it back. The namespace backend is made unavailable, so every sandbox uses `policy`.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runSg } from "xpi-shadow-git";

const TOUCHED = [
	"XPI_SG_STORE",
	"XPI_SG_UNSHARE",
	"XPI_SG_ADAPTER_PATH",
	"XPI_SG_SANDBOX",
	"XPI_SG_BACKEND",
	"XPI_CODING_AGENT_DIR",
	"XPI_SUBAGENT_DEPTH",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"HOME",
];

export interface Lab {
	root: string;
	ws: string;
	upstream: string;
	store: string;
	agentDir: string;
	home: string;
	/** `xpi sg <args>` in the workspace (or `cwd`), with the environment as it is now. */
	sg(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }>;
	/** Plain git on the shadow repo. */
	git(...args: string[]): string;
	/** A new host version: files (null deletes), then a bumped version counter. */
	hostCommit(files: Record<string, string | null>): void;
	/** Put the environment back and remove the temp directory. */
	restore(): void;
}

export function write(root: string, path: string, text: string): void {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

/** `storeInAgentDir`: the store is where xpi puts it by default, `<agent dir>/shadow-git`. */
export async function lab(name = "demo", options: { storeInAgentDir?: boolean } = {}): Promise<Lab> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "xpi-sg-int-")));
	const saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
	const ws = join(root, "ws");
	const upstream = join(root, "upstream");
	const agentDir = join(root, "agent");
	const store = options.storeInAgentDir ? join(agentDir, "shadow-git") : join(root, "store");
	const home = join(root, "home");
	for (const dir of [ws, upstream, agentDir, home]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(root, "gitconfig"), "");
	for (const key of TOUCHED) delete process.env[key];
	Object.assign(process.env, {
		XPI_SG_STORE: store,
		XPI_SG_UNSHARE: join(root, "no-unshare"),
		XPI_CODING_AGENT_DIR: agentDir,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		HOME: home,
	});
	for (const [path, text] of Object.entries({ "a.txt": "a\n", "src/b.txt": "b\n" })) {
		write(ws, path, text);
		write(upstream, path, text);
	}
	write(ws, ".plainvcs/version", "1\n");
	write(upstream, ".plainvcs/version", "1\n");
	const sg: Lab["sg"] = async (args, cwd = ws) => {
		let out = "";
		let err = "";
		const code = await runSg(args, {
			cwd,
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
			stdio: "capture",
			lockTimeoutMs: 500,
		});
		return { code, out, err };
	};
	const made = await sg(["init", name, "--adapter", "plain", "--config", `shadow.plain.upstream=${upstream}`]);
	if (made.code !== 0) throw new Error(`init failed: ${made.err}`);
	const git = (...args: string[]): string =>
		execFileSync("git", args, {
			cwd: ws,
			encoding: "utf8",
			env: { ...process.env, GIT_DIR: join(store, `${name}.git`), GIT_WORK_TREE: ws },
		});
	return {
		root,
		ws,
		upstream,
		store,
		agentDir,
		home,
		sg,
		git,
		hostCommit(files) {
			for (const [path, text] of Object.entries(files)) {
				if (text === null) rmSync(join(upstream, path), { force: true });
				else write(upstream, path, text);
			}
			const version = Number(readFileSync(join(upstream, ".plainvcs/version"), "utf8")) + 1;
			write(upstream, ".plainvcs/version", `${version}\n`);
		},
		restore() {
			for (const key of TOUCHED) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** A fake ExtensionAPI that records handlers and commands; any other registration is listed in `others`. */
export function fakeApi() {
	const handlers: Record<string, ((event: any, ctx: any) => unknown)[]> = {};
	const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const others: string[] = [];
	const known = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands[name] = options;
		},
	};
	const pi = new Proxy(known, {
		get(target, key: string) {
			if (key in target) return target[key as keyof typeof target];
			return () => {
				others.push(key);
			};
		},
	}) as any;
	return {
		pi,
		handlers,
		commands,
		others,
		/** The last result a handler returned. */
		async emit(event: string, payload: object, ctx: object) {
			let result: any;
			for (const handler of handlers[event] ?? []) result = (await handler(payload, ctx)) ?? result;
			return result;
		},
	};
}

export interface Note {
	message: string;
	level: string;
}

/** A fake extension context. `idle` can be switched while a test runs. */
export function fakeCtx(cwd: string, sessionId = "s1") {
	const notes: Note[] = [];
	const state = { idle: true };
	return {
		notes,
		state,
		ctx: {
			cwd,
			hasUI: true,
			isIdle: () => state.idle,
			ui: { notify: (message: string, level = "info") => notes.push({ message, level }) },
			sessionManager: { getSessionId: () => sessionId, getSessionDir: () => join(cwd, ".sessions") },
		},
	};
}
